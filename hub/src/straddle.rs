//! The rolling ATM straddle for any underlying with options (NSE, BSE, MCX),
//! computed ONCE per underlying+expiry in the hub and shared by every user
//! watching it: topic `straddle:nse:nifty:2026-10-27`.
//!
//! Per minute bar: spot (the underlying's reference: index/stock spot, or the
//! future an MCX option is written on), the selected strike, call, put,
//! straddle = call + put, synthetic future = K + C − P, the straddle's session
//! VWAP, its ATM IV (Black-76) and India VIX.
//!
//! The method is QuantDesk's (`market::straddle`, `market::atm_iv`,
//! `market::combo_series`), ported unchanged so both apps draw the same lines:
//!
//! - **Selection:** ATM = strike nearest spot; candidates ATM ± 2 strikes; the
//!   cheapest candidate wins, but the held strike is kept unless a challenger
//!   is cheaper by 0.5% (without that margin it flips between two strikes that
//!   cost the same and every flip reads as a roll).
//! - **Leg price:** live, bid/ask mid when both are quoted, else the last
//!   trade; from candles, the minute's close, carried forward over minutes the
//!   leg didn't trade. A strike missing either leg is never a candidate.
//! - **IV:** Black-76 against the straddle's own synthetic future, rate 0, time
//!   to 15:40 IST on expiry day (MCX: its night close, 23:30 or 23:55 under US
//!   daylight saving), 365-day year. Same solver and revision as QuantDesk.
//! - **VWAP:** per side, traded value over traded quantity of the strike held
//!   each minute, then call side + put side.
//!
//! ## Whenever the first viewer comes, the chart starts at the open
//!
//! The first viewer of a straddle starts its engine. The engine runs live at
//! once and, in the background, fetches today's 1-minute candles from the
//! open (09:15 NSE/BSE, 09:00 MCX) up to that moment ONCE, rebuilds those
//! minutes with the same rules, and merges them in front of the live bars
//! (VWAP carried through). Every viewer, however many and whenever they come,
//! shares that one engine and that one backfill.
//!
//! The engine then keeps running for the rest of the day even with nobody
//! watching (a few hundred small bars, ~45 KB), so a later viewer costs no
//! broker call at all. Only when more than [`MAX_ENGINES`] are running does an
//! unwatched one stop; all of them stop at the day's end.
//!
//! ## Past days
//!
//! The last [`PAST_DAYS`] trading days are built on request from broker
//! candles. Identical requests in flight share one build; finished days are
//! kept in a RAM cache capped at [`PAST_CACHE_BYTES`] (least used dropped
//! first, all of it at the day's end). Nothing is written to disk.
//!
//! Every broker call goes through the history engine's rate limiters, so the
//! brokers' limits are never exceeded: under load, requests wait their turn
//! (most-requested first).

use crate::canonical::{Canonical, Market};
use crate::creds::CredStore;
use crate::history::{HistoryEngine, PieceData};
use crate::instruments::{Instruments, Strike};
use crate::live::{LiveHub, Mailbox};
use crate::model::{Candle, InstrumentId, Interval};
use axum::extract::ws::Utf8Bytes;
use black76_rust::{implied_volatility, OptionType};
use chrono::{Datelike, FixedOffset, NaiveDate, NaiveTime, TimeZone, Weekday};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, OnceCell};

/// Candidates are ATM ± this many strikes (QuantDesk `BAND`).
pub const BAND: i32 = 2;
/// A challenger must be this much cheaper before the selection rolls (QuantDesk `ROLL_HYSTERESIS`).
const ROLL_HYSTERESIS: f64 = 0.005;
/// Legs kept subscribed around the ATM: the band plus room for spot to move.
const WINDOW: i32 = 4;
/// Legs further than this from the ATM are released (wider than WINDOW, so a
/// strike at the edge isn't subscribed and dropped over and over).
const RELEASE: i32 = 6;
/// The engine recomputes on every tick; this timer only closes a minute when no tick
/// comes, and checks whether anyone is still watching.
const COMPUTE_EVERY: Duration = Duration::from_secs(1);
/// During a burst of ticks, recompute at most this often (always with the newest
/// prices). A tick after a quiet spell is computed at once. Bounds the CPU of a
/// busy engine at ~20 recomputes a second however fast the feed runs.
const MIN_COMPUTE_GAP: Duration = Duration::from_millis(50);

/// A live quote as the hub publishes it (`live::QuoteMsg`); other fields are ignored.
#[derive(serde::Deserialize)]
struct QuoteIn {
    #[serde(default)]
    ltp: f64,
    v: Option<f64>,
    bid: Option<f64>,
    ask: Option<f64>,
    #[serde(default)]
    replay: bool,
}
/// Engines kept running with nobody watching; beyond this, unwatched ones stop
/// (each holds ~20 live subscriptions and ~45 KB of bars).
pub const MAX_ENGINES: usize = 30;
/// An unwatched engine is never stopped sooner than this (a page reload keeps it).
const IDLE_GRACE: Duration = Duration::from_secs(300);
/// How many trading days back a past straddle can be asked for.
pub const PAST_DAYS: i64 = 3;
/// RAM for finished past days (computed bars only, not candles).
pub const PAST_CACHE_BYTES: usize = 16 * 1024 * 1024;
/// Approximate RAM of one bar, for the cache cap.
const BAR_BYTES: usize = 160;
const MINUTE_MS: i64 = 60_000;
const YEAR_MS: f64 = 365.0 * 24.0 * 60.0 * 60.0 * 1000.0;
/// NSE/BSE expiry clock (QuantDesk `EXPIRY_CLOSE`).
const EXPIRY_CLOSE: (u32, u32) = (15, 40);
const VIX_TOPIC: &str = "quote:nse:indiavix";

fn ist() -> FixedOffset {
    FixedOffset::east_opt(19_800).expect("IST offset")
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn ist_day(ms: i64) -> Option<NaiveDate> {
    ist().timestamp_millis_opt(ms).single().map(|d| d.date_naive())
}

fn ist_ms(day: NaiveDate, (h, m): (u32, u32)) -> Option<i64> {
    ist().from_local_datetime(&day.and_time(NaiveTime::from_hms_opt(h, m, 0)?)).single().map(|t| t.timestamp_millis())
}

/// The session's first minute: 09:15 IST on NSE/BSE, 09:00 on MCX.
fn session_start_ms(day: NaiveDate, market: Market) -> Option<i64> {
    ist_ms(day, if market == Market::Mcx { (9, 0) } else { (9, 15) })
}

/// The end of the session (the first minute after its last): 15:30 IST on
/// NSE/BSE, MCX's night close. Ticks after it (late prints, the feed's
/// closing updates) make no new minutes.
fn session_end_ms(day: NaiveDate, market: Market) -> Option<i64> {
    ist_ms(day, if market == Market::Mcx { mcx_close(day) } else { (15, 30) })
}

fn strike_key(strike: f64) -> i64 {
    (strike * 100.0).round() as i64
}

// ---------------------------------------------------------------------------
// The method (pure functions, ported from QuantDesk)
// ---------------------------------------------------------------------------

/// Distance between adjacent strikes: the smallest gap (far strikes are often wider).
pub fn infer_step(strikes: &[f64], fallback: f64) -> f64 {
    strikes.windows(2).map(|w| (w[1] - w[0]).abs()).filter(|g| *g > 0.0).min_by(|a, b| a.total_cmp(b)).unwrap_or(fallback)
}

pub fn nearest_strike(spot: f64, strikes: &[f64]) -> Option<f64> {
    strikes.iter().copied().min_by(|a, b| (a - spot).abs().total_cmp(&(b - spot).abs()))
}

/// The listed strike at `target`, within a quarter step (addressed by price, so a gap can't shift the band).
fn listed_at(strikes: &[f64], target: f64, step: f64) -> Option<f64> {
    strikes.iter().copied().find(|s| (s - target).abs() < step * 0.25)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Quote {
    pub ltp: f64,
    pub volume: Option<f64>,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
}

/// Mid when both sides are quoted, otherwise the last trade.
pub fn leg_price(q: &Quote) -> Option<f64> {
    match (q.bid, q.ask) {
        (Some(b), Some(a)) if b > 0.0 && a > 0.0 => Some((b + a) / 2.0),
        _ => (q.ltp > 0.0).then_some(q.ltp),
    }
}

/// The cheapest priced strike of ATM ± `band`, holding `previous` unless a
/// challenger beats it by ROLL_HYSTERESIS. `legs(strike)` gives (call, put)
/// when both are priced. Returns (strike, call, put).
pub fn cheapest_in_band(
    strikes: &[f64],
    legs: impl Fn(f64) -> Option<(f64, f64)>,
    atm: f64,
    step: f64,
    band: i32,
    previous: Option<f64>,
) -> Option<(f64, f64, f64)> {
    let mut best: Option<(f64, f64, f64, f64)> = None; // (total, strike, call, put)
    let mut held: Option<(f64, f64, f64, f64)> = None;
    for offset in -band..=band {
        let Some(strike) = listed_at(strikes, atm + offset as f64 * step, step) else { continue };
        // A candidate missing either leg is skipped, never half-counted.
        let Some((call, put)) = legs(strike) else { continue };
        let total = call + put;
        if best.is_none_or(|(lowest, ..)| total < lowest) {
            best = Some((total, strike, call, put));
        }
        if previous.is_some_and(|p| (p - strike).abs() < step * 0.25) {
            held = Some((total, strike, call, put));
        }
    }
    let (total, strike, call, put) = best?;
    // Stay put unless the challenger is cheaper by a real margin.
    if let Some((held_total, held_strike, held_call, held_put)) = held {
        if total > held_total * (1.0 - ROLL_HYSTERESIS) {
            return Some((held_strike, held_call, held_put));
        }
    }
    Some((strike, call, put))
}

/// MCX's close on `day`, IST: 23:55 from the second Sunday of March to the
/// first Sunday of November (US daylight saving), 23:30 otherwise.
pub fn mcx_close(day: NaiveDate) -> (u32, u32) {
    let year = day.year();
    let starts = NaiveDate::from_weekday_of_month_opt(year, 3, Weekday::Sun, 2);
    let ends = NaiveDate::from_weekday_of_month_opt(year, 11, Weekday::Sun, 1);
    match (starts, ends) {
        (Some(s), Some(e)) if day >= s && day < e => (23, 55),
        _ => (23, 30),
    }
}

/// When an expiry stops counting down, epoch ms.
pub fn expiry_close_ms(expiry: NaiveDate, market: Market) -> Option<i64> {
    ist_ms(expiry, if market == Market::Mcx { mcx_close(expiry) } else { EXPIRY_CLOSE })
}

/// The straddle's IV in percent, off its own synthetic future. `None` when there
/// is no honest answer (a leg unpriced, expiry passed, no solution).
pub fn straddle_iv(strike: f64, call: f64, put: f64, time_ms: i64, expiry_ms: i64) -> Option<f64> {
    if strike <= 0.0 || call <= 0.0 || put <= 0.0 {
        return None;
    }
    let years = (expiry_ms - time_ms) as f64 / YEAR_MS;
    if years <= 0.0 {
        return None;
    }
    let forward = strike + call - put;
    if forward <= 0.0 {
        return None;
    }
    // Parity makes both legs imply the same σ; solve on the out-of-the-money one.
    let (price, side) = if forward >= strike { (put, OptionType::Put) } else { (call, OptionType::Call) };
    implied_volatility(price, forward, strike, years, 0.0, side).ok().filter(|s| s.is_finite() && *s > 0.0).map(|s| s * 100.0)
}

/// Session VWAP as running totals per side; the straddle's VWAP is call side + put side.
#[derive(Clone, Copy, Default, Debug)]
pub struct Vwap {
    call_value: f64,
    call_qty: f64,
    put_value: f64,
    put_qty: f64,
}

impl Vwap {
    pub fn add(&mut self, call: f64, call_qty: f64, put: f64, put_qty: f64) {
        if call > 0.0 && call_qty > 0.0 {
            self.call_value += call * call_qty;
            self.call_qty += call_qty;
        }
        if put > 0.0 && put_qty > 0.0 {
            self.put_value += put * put_qty;
            self.put_qty += put_qty;
        }
    }

    pub fn merge(&mut self, other: &Vwap) {
        self.call_value += other.call_value;
        self.call_qty += other.call_qty;
        self.put_value += other.put_value;
        self.put_qty += other.put_qty;
    }

    pub fn value(&self) -> Option<f64> {
        (self.call_qty > 0.0 && self.put_qty > 0.0).then(|| self.call_value / self.call_qty + self.put_value / self.put_qty)
    }
}

// ---------------------------------------------------------------------------
// Bars from 1-minute candles (today's backfill and past days)
// ---------------------------------------------------------------------------

/// One minute. `t` is the minute's start (epoch ms); the last values of the minute win.
///
/// Values are kept at full precision here and sent rounded to 2 decimals
/// (`96.68651562243576` → `96.69`): what a chart can show, and ~40% less to
/// send to every viewer.
#[derive(Clone, Debug, Serialize)]
pub struct Bar {
    pub t: i64,
    #[serde(serialize_with = "round2")]
    pub spot: f64,
    #[serde(serialize_with = "round2")]
    pub strike: f64,
    #[serde(serialize_with = "round2")]
    pub atm: f64,
    #[serde(serialize_with = "round2")]
    pub call: f64,
    #[serde(serialize_with = "round2")]
    pub put: f64,
    #[serde(serialize_with = "round2")]
    pub straddle: f64,
    #[serde(serialize_with = "round2")]
    pub synth: f64,
    #[serde(serialize_with = "round2_opt")]
    pub vwap: Option<f64>,
    #[serde(serialize_with = "round2_opt")]
    pub iv: Option<f64>,
    #[serde(serialize_with = "round2_opt")]
    pub vix: Option<f64>,
    /// First bar at a new strike.
    pub rolled: bool,
}

fn round2<S: serde::Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64((v * 100.0).round() / 100.0)
}

fn round2_opt<S: serde::Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(x) => round2(x, s),
        None => s.serialize_none(),
    }
}

/// One instrument's candles by minute (ms): close and that minute's volume.
#[derive(Default)]
struct Series(BTreeMap<i64, (f64, f64)>);

impl Series {
    fn new(candles: &[Candle]) -> Self {
        Series(candles.iter().filter(|c| c.4 > 0.0).map(|c| (c.0 * 1000, (c.4, c.5.max(0.0)))).collect())
    }
    /// The last close at or before `t`: an untraded minute carries the last price.
    fn close_at(&self, t: i64) -> Option<f64> {
        self.0.range(..=t).next_back().map(|(_, v)| v.0)
    }
    /// What traded in exactly this minute.
    fn volume_at(&self, t: i64) -> f64 {
        self.0.get(&t).map(|v| v.1).unwrap_or(0.0)
    }
}

/// What a candle build hands back: the bars, the VWAP totals after the last
/// one, and the strike last held (so a live engine continues without a jump).
struct Built {
    bars: Vec<Bar>,
    vwap: Vwap,
    held: Option<f64>,
}

/// Strikes the selection could have used during [from, until): ATM ± BAND each minute.
fn strikes_needed(spot: &Series, strikes: &[f64], step: f64, from: i64, until: i64) -> BTreeSet<i64> {
    let mut need = BTreeSet::new();
    for (_, (px, _)) in spot.0.range(from..until) {
        let Some(atm) = nearest_strike(*px, strikes) else { continue };
        for offset in -BAND..=BAND {
            if let Some(s) = listed_at(strikes, atm + offset as f64 * step, step) {
                need.insert(strike_key(s));
            }
        }
    }
    need
}

#[allow(clippy::too_many_arguments)]
fn build_bars(
    spot: &Series,
    legs: &HashMap<i64, (Series, Series)>,
    vix: Option<&Series>,
    strikes: &[f64],
    step: f64,
    expiry_ms: Option<i64>,
    from: i64,
    until: i64,
) -> Built {
    let mut out = Built { bars: Vec::new(), vwap: Vwap::default(), held: None };
    for (&t, &(spot_px, _)) in spot.0.range(from..until) {
        let Some(atm) = nearest_strike(spot_px, strikes) else { continue };
        let price = |s: f64| legs.get(&strike_key(s)).and_then(|(c, p)| Some((c.close_at(t)?, p.close_at(t)?)));
        let Some((strike, call, put)) = cheapest_in_band(strikes, price, atm, step, BAND, out.held) else { continue };
        if let Some((c, p)) = legs.get(&strike_key(strike)) {
            out.vwap.add(call, c.volume_at(t), put, p.volume_at(t));
        }
        let rolled = out.bars.last().is_some_and(|b| (b.strike - strike).abs() > f64::EPSILON);
        out.held = Some(strike);
        out.bars.push(Bar {
            t,
            spot: spot_px,
            strike,
            atm,
            call,
            put,
            straddle: call + put,
            synth: strike + call - put,
            vwap: out.vwap.value(),
            // Valued at the minute's end, as its closes are.
            iv: expiry_ms.and_then(|e| straddle_iv(strike, call, put, t + MINUTE_MS, e)),
            vix: vix.and_then(|v| v.close_at(t)),
            rolled,
        });
    }
    out
}

/// One instrument's 1-minute candles for one day, through the shared, rate-limited history engine.
async fn day_candles(hist: &HistoryEngine, id: &str, day: NaiveDate) -> Result<Arc<PieceData>, String> {
    let id = InstrumentId::parse(id).ok_or_else(|| format!("bad id {id}"))?;
    let mut pieces = hist.request(id, Interval::M1, day, day)?;
    let (_, rx) = pieces.pop().ok_or_else(|| format!("{day} is not a trading day"))?;
    rx.await.map_err(|_| "history request cancelled".to_string())?
}

// ---------------------------------------------------------------------------
// The shared engines
// ---------------------------------------------------------------------------

struct Engine {
    topic: Arc<str>,
    underlying: String,
    expiry: NaiveDate,
    reference: String,
    day: NaiveDate,
    subs: Mutex<Vec<Arc<Mailbox>>>,
    /// Finished minutes, then the one forming.
    bars: Mutex<(Vec<Bar>, Option<Bar>)>,
    /// "loading", "done", "none" (opened before the open) or "failed: ...".
    backfill: Mutex<String>,
}

/// A finished past day in the cache, and when it was last asked for.
struct PastEntry {
    cell: Arc<OnceCell<Arc<Vec<Bar>>>>,
    used: Instant,
}

pub struct StraddleHub {
    live: Arc<LiveHub>,
    instruments: Arc<Instruments>,
    hist: Arc<HistoryEngine>,
    engines: Mutex<HashMap<String, Arc<Engine>>>,
    past: Mutex<(Option<NaiveDate>, HashMap<String, PastEntry>)>,
    /// Shoonya login, for India VIX history (None: VIX starts live).
    creds: Option<Arc<CredStore>>,
    /// India VIX minutes of past days; an async lock, so fetches go one at a time.
    vix_days: tokio::sync::Mutex<HashMap<NaiveDate, Arc<Vec<Candle>>>>,
}

#[derive(Serialize)]
struct Snapshot<'a> {
    t: &'static str,
    topic: &'a str,
    underlying: &'a str,
    expiry: NaiveDate,
    reference: &'a str,
    /// Today's minutes from the open: "loading" while they are fetched, then "done".
    backfill: String,
    bars: Vec<Bar>,
}

#[derive(Serialize)]
struct Update<'a> {
    t: &'static str,
    topic: &'a str,
    /// Number of finished bars; a client that sees a jump of more than one missed some.
    n: usize,
    /// The minute forming now.
    bar: &'a Bar,
    /// The last finished minute, final values (sent every time, so a client that
    /// missed the update at the minute's turn still gets them).
    prev: Option<&'a Bar>,
}

/// What the engine needs to know about its straddle, resolved once.
struct Setup {
    market: Market,
    expiry: NaiveDate,
    chain: Vec<Strike>,
    reference: Canonical,
}

impl StraddleHub {
    pub fn new(live: Arc<LiveHub>, instruments: Arc<Instruments>, hist: Arc<HistoryEngine>, creds: Option<Arc<CredStore>>) -> Arc<Self> {
        Arc::new(Self {
            live,
            instruments,
            hist,
            engines: Mutex::new(HashMap::new()),
            past: Mutex::new((None, HashMap::new())),
            creds,
            vix_days: tokio::sync::Mutex::new(HashMap::new()),
        })
    }

    /// `straddle:nse:nifty:2026-10-27` → (underlying, expiry).
    fn parse(topic: &str) -> Result<(Canonical, NaiveDate), String> {
        let rest = topic.strip_prefix("straddle:").ok_or("straddle topics start with straddle:")?;
        let (u, e) = rest.rsplit_once(':').ok_or("use straddle:<underlying>:<YYYY-MM-DD>, e.g. straddle:nse:nifty:2026-10-27")?;
        let expiry = NaiveDate::parse_from_str(e, "%Y-%m-%d").map_err(|_| format!("`{e}`: expiry must be YYYY-MM-DD"))?;
        match Canonical::parse(u)? {
            c @ Canonical::Underlying { .. } => Ok((c, expiry)),
            _ => Err(format!("`{u}`: give the underlying, e.g. nse:nifty")),
        }
    }

    /// Underlying, expiry → chain and reference, or why not.
    fn setup(&self, c: &Canonical, expiry: NaiveDate) -> Result<Setup, String> {
        let (market, name) = (c.market(), c.name_upper());
        let u = self.instruments.get(market, &name).ok_or_else(|| format!("{c}: no options on {}", market.as_str()))?;
        if !u.expiries.contains(&expiry) {
            return Err(format!("{c}: no expiry {expiry} in today's list (expiries: {:?})", u.expiries.iter().take(6).collect::<Vec<_>>()));
        }
        let reference = u.reference_for(expiry).ok_or_else(|| format!("{c}: no spot or future to set the straddle against"))?;
        let chain = tokio::task::block_in_place(|| self.instruments.chain(market, &name, expiry)).map_err(|e| e.to_string())?;
        if chain.is_empty() {
            return Err(format!("{c}: empty chain for {expiry}"));
        }
        Ok(Setup { market, expiry, chain, reference })
    }

    /// One trading day's bars from broker candles: spot first, then the legs the
    /// selection could have used. Shares pieces with anyone asking for the same.
    async fn build_day(&self, setup: &Setup, day: NaiveDate, from: i64, until: i64) -> Result<Built, String> {
        let strikes: Vec<f64> = setup.chain.iter().map(|s| s.strike).collect();
        let step = infer_step(&strikes, 50.0);
        let spot_id = self.instruments.history_id(&setup.reference)?;
        let spot = Series::new(&day_candles(&self.hist, &spot_id, day).await?.candles);
        if spot.0.range(from..until).next().is_none() {
            return Err(format!("no {} candles for {day}", setup.reference));
        }
        let need = strikes_needed(&spot, &strikes, step, from, until);
        let legs = need.iter().filter_map(|k| setup.chain.iter().find(|s| strike_key(s.strike) == *k)).map(|s| {
            let ids = (|| -> Result<(String, String), String> {
                let id = |leg: &str| Canonical::parse(leg).and_then(|c| self.instruments.history_id(&c));
                Ok((id(&s.call)?, id(&s.put)?))
            })();
            async move {
                let (call_id, put_id) = match ids {
                    Ok(v) => v,
                    Err(e) => return (strike_key(s.strike), Err(e)),
                };
                let (c, p) = tokio::join!(day_candles(&self.hist, &call_id, day), day_candles(&self.hist, &put_id, day));
                (strike_key(s.strike), c.and_then(|c| Ok((Series::new(&c.candles), Series::new(&p?.candles)))))
            }
        });
        let (legs, vix) = tokio::join!(futures_util::future::join_all(legs), self.vix_minutes(day));
        let mut leg_series = HashMap::new();
        let mut failed = 0;
        for (k, r) in legs {
            match r {
                Ok(v) => {
                    leg_series.insert(k, v);
                }
                Err(e) => {
                    failed += 1;
                    tracing::debug!(error = %e, "straddle leg candles unavailable");
                }
            }
        }
        if leg_series.is_empty() {
            return Err(format!("no option candles for {day} ({failed} strikes failed)"));
        }
        let vix = vix.map(|c| Series::new(&c));
        let expiry_ms = expiry_close_ms(setup.expiry, setup.market);
        Ok(build_bars(&spot, &leg_series, vix.as_ref(), &strikes, step, expiry_ms, from, until))
    }

    /// India VIX's minutes for `day`, from Shoonya (neither history broker serves
    /// it). The same for every straddle: a past day is fetched once and kept;
    /// today is fetched each time a session is backfilled. Calls go one at a
    /// time. None when unavailable: the line then starts with the live feed.
    async fn vix_minutes(&self, day: NaiveDate) -> Option<Arc<Vec<Candle>>> {
        let creds = self.creds.as_ref()?;
        let feed_id = Canonical::parse("nse:indiavix").and_then(|c| self.instruments.resolve(&c)).ok()?;
        let today = ist_day(now_ms())?;
        let mut cache = self.vix_days.lock().await;
        cache.retain(|d, _| (today - *d).num_days() <= 7);
        if let Some(c) = cache.get(&day) {
            return Some(c.clone());
        }
        match crate::brokers::shoonya::day_minutes(creds, &feed_id, day).await {
            Ok(c) if !c.is_empty() => {
                let c = Arc::new(c);
                if day < today {
                    cache.insert(day, c.clone());
                }
                Some(c)
            }
            Ok(_) => None,
            Err(e) => {
                tracing::warn!(%day, error = %e, "India VIX history unavailable; the line starts live");
                None
            }
        }
    }

    /// Adds a watcher and returns the session so far (snapshot message).
    pub fn subscribe(self: &Arc<Self>, topic: &str, mailbox: &Arc<Mailbox>) -> Result<Utf8Bytes, String> {
        // Look up in its own statement: a guard taken in a `match` head lives
        // until the match ends, and `start` takes the same lock (deadlock).
        let existing = self.engines.lock().get(topic).cloned();
        let engine = match existing {
            Some(e) => e,
            None => self.start(topic)?,
        };
        engine.subs.lock().push(mailbox.clone());
        snapshot_of(&engine)
    }

    pub fn unsubscribe(&self, topic: &str, mailbox: &Arc<Mailbox>) {
        if let Some(e) = self.engines.lock().get(topic) {
            e.subs.lock().retain(|m| !Arc::ptr_eq(m, mailbox));
        }
    }

    fn start(self: &Arc<Self>, topic: &str) -> Result<Arc<Engine>, String> {
        let (c, expiry) = Self::parse(topic)?;
        let setup = self.setup(&c, expiry)?;
        let mut engines = self.engines.lock();
        if let Some(e) = engines.get(topic) {
            return Ok(e.clone());
        }
        let now = now_ms();
        let day = ist_day(now).ok_or("clock")?;
        let engine = Arc::new(Engine {
            topic: Arc::from(topic),
            underlying: c.to_string(),
            expiry,
            reference: setup.reference.to_string(),
            day,
            subs: Mutex::new(Vec::new()),
            bars: Mutex::new((Vec::new(), None)),
            backfill: Mutex::new("loading".into()),
        });
        engines.insert(topic.to_string(), engine.clone());
        drop(engines);
        tracing::info!(topic, reference = %setup.reference, strikes = setup.chain.len(), "straddle engine started");

        // Today from the open up to now: once, in the background, shared by every viewer.
        let (backfill_tx, backfill_rx) = oneshot::channel();
        let first_live_minute = now - now.rem_euclid(MINUTE_MS);
        let setup = Arc::new(setup);
        match session_start_ms(day, setup.market).filter(|open| *open < first_live_minute) {
            Some(open) => {
                let (me, s) = (self.clone(), setup.clone());
                tokio::spawn(async move {
                    let _ = backfill_tx.send(me.build_day(&s, day, open, first_live_minute).await);
                });
            }
            None => *engine.backfill.lock() = "none".into(),
        }
        tokio::spawn(self.clone().run(engine.clone(), setup, backfill_rx));
        Ok(engine)
    }

    /// One engine: follows spot, keeps the legs around the ATM subscribed, and
    /// on every tick (and at least once a second) updates the forming minute and
    /// sends it to the watchers.
    async fn run(self: Arc<Self>, engine: Arc<Engine>, setup: Arc<Setup>, mut backfill: oneshot::Receiver<Result<Built, String>>) {
        let strikes: Vec<f64> = setup.chain.iter().map(|s| s.strike).collect();
        let step = infer_step(&strikes, 50.0);
        let legs_of: HashMap<i64, (Arc<str>, Arc<str>)> = setup
            .chain
            .iter()
            .map(|s| (strike_key(s.strike), (Arc::from(format!("quote:{}", s.call)), Arc::from(format!("quote:{}", s.put)))))
            .collect();
        let expiry_ms = expiry_close_ms(engine.expiry, setup.market);
        let ref_topic = format!("quote:{}", setup.reference);
        // Minutes are made only inside the day's session.
        let session = (session_start_ms(engine.day, setup.market), session_end_ms(engine.day, setup.market));

        let inbox = Mailbox::new();
        let mut subscribed: HashSet<Arc<str>> = HashSet::new();
        for t in [ref_topic.as_str(), VIX_TOPIC] {
            match self.live.subscribe(t, &inbox) {
                Ok(_) => {
                    subscribed.insert(Arc::from(t));
                }
                Err(e) => tracing::warn!(topic = %engine.topic, feed = t, error = %e, "straddle input unavailable"),
            }
        }

        let mut quotes: HashMap<Arc<str>, Quote> = HashMap::new();
        let mut batch: HashMap<Arc<str>, Utf8Bytes> = HashMap::new();
        // Each leg's cumulative volume at the start of the current minute.
        let mut minute_mark: HashMap<Arc<str>, f64> = HashMap::new();
        // VWAP of the live minutes only, and each finished live minute's share,
        // so the backfill's totals can be put in front of them when it arrives.
        let mut vwap = Vwap::default();
        let mut live_minutes: Vec<Vwap> = Vec::new();
        let mut backfill_open = !matches!(engine.backfill.lock().as_str(), "none");
        let mut held: Option<f64> = None;
        // No bar is made until spot has had a live update: before the open, or on
        // a holiday, the feed only replays the last session's prices.
        let mut spot_live = false;
        let mut idle_since: Option<Instant> = None;
        let mut tick = tokio::time::interval(COMPUTE_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_compute = tokio::time::Instant::now() - MIN_COMPUTE_GAP;
        // Ticks arrived inside MIN_COMPUTE_GAP of the last compute: one is due at its end.
        let mut owed = false;
        // The ATM the subscribed window was last laid out around.
        let mut window_atm: Option<f64> = None;

        loop {
            let timer = tokio::select! {
                _ = inbox.ready() => {
                    inbox.drain_into(&mut batch);
                    for (topic, bytes) in batch.drain() {
                        let Ok(v) = serde_json::from_str::<QuoteIn>(bytes.as_str()) else { continue };
                        if *topic == *ref_topic && !v.replay && !spot_live {
                            spot_live = true;
                            tracing::info!(topic = %engine.topic, "straddle: first live tick");
                        }
                        if let Some(vol) = v.v {
                            minute_mark.entry(topic.clone()).or_insert(vol);
                        }
                        quotes.insert(topic, Quote { ltp: v.ltp, volume: v.v, bid: v.bid, ask: v.ask });
                    }
                    // Recompute now, not at the next timer tick, unless one just ran:
                    // then once the gap is up, with whatever is newest by then.
                    if last_compute.elapsed() < MIN_COMPUTE_GAP {
                        owed = true;
                        continue;
                    }
                    false
                }
                _ = tokio::time::sleep_until(last_compute + MIN_COMPUTE_GAP), if owed => false,
                r = &mut backfill, if backfill_open => {
                    backfill_open = false;
                    match r {
                        Ok(Ok(built)) => {
                            let mut bars = engine.bars.lock();
                            let first_live = bars.0.first().or(bars.1.as_ref()).map(|b| b.t).unwrap_or(i64::MAX);
                            let early: Vec<Bar> = built.bars.into_iter().filter(|b| b.t < first_live).collect();
                            // Live minutes' VWAP now includes the morning's trading.
                            let mut running = built.vwap;
                            for (bar, inc) in bars.0.iter_mut().zip(&live_minutes) {
                                running.merge(inc);
                                bar.vwap = running.value();
                            }
                            vwap = running;
                            if held.is_none() {
                                held = built.held;
                            }
                            let n = early.len();
                            let mut merged = early;
                            merged.append(&mut bars.0);
                            bars.0 = merged;
                            drop(bars);
                            *engine.backfill.lock() = "done".into();
                            tracing::info!(topic = %engine.topic, minutes = n, "straddle backfilled from the open");
                        }
                        Ok(Err(e)) => {
                            tracing::warn!(topic = %engine.topic, error = %e, "straddle backfill failed; live minutes only");
                            *engine.backfill.lock() = format!("failed: {e}");
                        }
                        Err(_) => *engine.backfill.lock() = "failed: cancelled".into(),
                    }
                    // Everyone watching gets the whole day again.
                    if let Ok(snap) = snapshot_of(&engine) {
                        for m in engine.subs.lock().iter() {
                            m.offer(&engine.topic, snap.clone());
                        }
                    }
                    continue;
                }
                _ = tick.tick() => true,
            };
            owed = false;
            last_compute = tokio::time::Instant::now();

            let now = now_ms();
            // Kept all day; an unwatched engine stops only when too many run, or the day is over.
            if engine.subs.lock().is_empty() {
                let since = *idle_since.get_or_insert_with(Instant::now);
                let crowded = self.engines.lock().len() > MAX_ENGINES;
                let day_over = ist_day(now) != Some(engine.day);
                if since.elapsed() >= IDLE_GRACE && (crowded || day_over) {
                    break;
                }
            } else {
                idle_since = None;
            }

            if !spot_live {
                continue;
            }
            let Some(spot) = quotes.get(ref_topic.as_str()).map(|q| q.ltp).filter(|p| *p > 0.0) else { continue };
            let Some(atm) = nearest_strike(spot, &strikes) else { continue };

            // Keep ATM ± WINDOW subscribed; release legs beyond ATM ± RELEASE. Only
            // when the ATM moves (and on the timer, to retry a refused subscribe),
            // not on every tick.
            if timer || window_atm != Some(atm) {
                window_atm = Some(atm);
                for offset in -WINDOW..=WINDOW {
                    if let Some(s) = listed_at(&strikes, atm + offset as f64 * step, step) {
                        if let Some((c, p)) = legs_of.get(&strike_key(s)) {
                            for t in [c, p] {
                                if !subscribed.contains(t) && self.live.subscribe(t, &inbox).is_ok() {
                                    subscribed.insert(t.clone());
                                }
                            }
                        }
                    }
                }
                let far: Vec<Arc<str>> = legs_of
                    .iter()
                    .filter(|(k, _)| ((**k as f64 / 100.0) - atm).abs() > RELEASE as f64 * step + step * 0.25)
                    .flat_map(|(_, (c, p))| [c.clone(), p.clone()])
                    .filter(|t| subscribed.contains(t))
                    .collect();
                for t in far {
                    self.live.unsubscribe(&t, &inbox);
                    subscribed.remove(&t);
                    quotes.remove(&t);
                    minute_mark.remove(&t);
                }
            }

            let price = |t: &Arc<str>| quotes.get(t).and_then(leg_price);
            let legs = |s: f64| legs_of.get(&strike_key(s)).and_then(|(c, p)| Some((price(c)?, price(p)?)));
            let Some((strike, call, put)) = cheapest_in_band(&strikes, legs, atm, step, BAND, held) else { continue };
            held = Some(strike);

            let minute = now - now.rem_euclid(MINUTE_MS);
            let vix = quotes.get(VIX_TOPIC).map(|q| q.ltp).filter(|v| *v > 0.0);
            let mut bars = engine.bars.lock();
            // The minute turned: close the forming bar and book its traded volume.
            if let Some(done) = bars.1.take_if(|b| b.t != minute) {
                let mut inc = Vwap::default();
                if let Some((c, p)) = legs_of.get(&strike_key(done.strike)) {
                    inc.add(done.call, traded(&quotes, &minute_mark, c), done.put, traded(&quotes, &minute_mark, p));
                }
                vwap.merge(&inc);
                live_minutes.push(inc);
                for (t, q) in &quotes {
                    if let Some(v) = q.volume {
                        minute_mark.insert(t.clone(), v);
                    }
                }
                bars.0.push(Bar { vwap: vwap.value(), ..done });
            }
            // Outside the session: the last minute is closed above; nothing new is made.
            let in_session = session.0.is_none_or(|open| minute >= open) && session.1.is_none_or(|close| minute < close);
            if !in_session {
                continue;
            }
            // The forming bar's VWAP includes this minute's trading so far.
            let mut live_vwap = vwap;
            if let Some((c, p)) = legs_of.get(&strike_key(strike)) {
                live_vwap.add(call, traded(&quotes, &minute_mark, c), put, traded(&quotes, &minute_mark, p));
            }
            let rolled = bars.0.last().is_some_and(|b| (b.strike - strike).abs() > f64::EPSILON);
            let bar = Bar {
                t: minute,
                spot,
                strike,
                atm,
                call,
                put,
                straddle: call + put,
                synth: strike + call - put,
                vwap: live_vwap.value(),
                iv: expiry_ms.and_then(|e| straddle_iv(strike, call, put, now, e)),
                vix,
                rolled,
            };
            let update = Update { t: "straddle", topic: &engine.topic, n: bars.0.len(), bar: &bar, prev: bars.0.last() };
            let bytes = Utf8Bytes::from(serde_json::to_string(&update).unwrap_or_default());
            bars.1 = Some(bar);
            drop(bars);
            for m in engine.subs.lock().iter() {
                m.offer(&engine.topic, bytes.clone());
            }
        }

        for t in &subscribed {
            self.live.unsubscribe(t, &inbox);
        }
        self.engines.lock().remove(&*engine.topic);
        tracing::info!(topic = %engine.topic, "straddle engine stopped");
    }

    /// A past trading day's straddle (one of the last PAST_DAYS). Built from
    /// broker candles on first request; identical requests share the build;
    /// kept in a capped RAM cache.
    pub async fn past(&self, underlying: &str, expiry: NaiveDate, date: NaiveDate) -> Result<Arc<Vec<Bar>>, String> {
        let c = match Canonical::parse(underlying)? {
            c @ Canonical::Underlying { .. } => c,
            _ => return Err(format!("`{underlying}`: give the underlying, e.g. nse:nifty")),
        };
        let today = ist_day(now_ms()).ok_or("clock")?;
        if date >= today {
            return Err("for today, subscribe to the straddle topic".into());
        }
        let back = date.iter_days().take_while(|d| *d < today).filter(|d| !matches!(d.weekday(), Weekday::Sat | Weekday::Sun)).count() as i64;
        if back > PAST_DAYS || back == 0 {
            return Err(format!("past straddles cover the last {PAST_DAYS} trading days"));
        }
        if date > expiry {
            return Err(format!("{date} is after expiry {expiry}"));
        }
        let key = format!("{c}:{expiry}:{date}");
        let cell = {
            let mut past = self.past.lock();
            if past.0 != Some(today) {
                *past = (Some(today), HashMap::new());
            }
            let e = past.1.entry(key.clone()).or_insert_with(|| PastEntry { cell: Arc::new(OnceCell::new()), used: Instant::now() });
            e.used = Instant::now();
            e.cell.clone()
        };
        let bars = cell
            .get_or_try_init(|| async {
                let setup = self.setup(&c, expiry)?;
                let open = session_start_ms(date, setup.market).ok_or("clock")?;
                let close = open + 16 * 3_600_000; // past the latest close (MCX 23:55)
                self.build_day(&setup, date, open, close).await.map(|b| Arc::new(b.bars))
            })
            .await?
            .clone();
        self.trim_past_cache();
        Ok(bars)
    }

    /// Gets these underlyings ready before anyone asks (nearest expiry each):
    /// today's engine running, so it records from the open, and the last
    /// PAST_DAYS trading days built into the cache. All broker calls go through
    /// the same rate limits as everything else.
    pub async fn warm(self: &Arc<Self>, underlyings: &[String]) {
        let Some(today) = ist_day(now_ms()) else { return };
        let mut past_days = Vec::new();
        let mut d = today;
        while past_days.len() < PAST_DAYS as usize {
            d = d.pred_opt().unwrap_or(d);
            if !matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
                past_days.push(d);
            }
        }
        let mut builds = Vec::new();
        let mut started = 0;
        for id in underlyings {
            let c = match Canonical::parse(id) {
                Ok(c @ Canonical::Underlying { .. }) => c,
                _ => {
                    tracing::warn!(underlying = %id, "warm: not an underlying name (e.g. nse:nifty)");
                    continue;
                }
            };
            let Some(expiry) = self.instruments.get(c.market(), &c.name_upper()).and_then(|u| u.expiries.first().copied()) else {
                tracing::warn!(underlying = %id, "warm: no options listed");
                continue;
            };
            let topic = format!("straddle:{c}:{expiry}");
            let running = self.engines.lock().contains_key(&topic);
            if !running {
                match self.start(&topic) {
                    Ok(_) => started += 1,
                    Err(e) => tracing::warn!(topic, error = %e, "warm: could not start"),
                }
            }
            for date in past_days.iter().copied().filter(|d| *d <= expiry) {
                let (me, u) = (self.clone(), c.to_string());
                builds.push(async move { me.past(&u, expiry, date).await.is_ok() });
            }
        }
        let built = futures_util::future::join_all(builds).await.into_iter().filter(|ok| *ok).count();
        tracing::info!(engines_started = started, past_days_ready = built, "straddles warmed");
    }

    /// Drops the least recently used finished days until the cache fits its cap.
    fn trim_past_cache(&self) {
        let mut past = self.past.lock();
        let size = |m: &HashMap<String, PastEntry>| m.values().filter_map(|e| e.cell.get()).map(|b| b.len() * BAR_BYTES).sum::<usize>();
        while size(&past.1) > PAST_CACHE_BYTES {
            let Some(oldest) = past.1.iter().filter(|(_, e)| e.cell.initialized()).min_by_key(|(_, e)| e.used).map(|(k, _)| k.clone()) else { break };
            past.1.remove(&oldest);
        }
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let engines = self.engines.lock();
        let past = self.past.lock();
        serde_json::json!({
            "engines": engines.values().map(|e| serde_json::json!({
                "topic": &*e.topic,
                "viewers": e.subs.lock().len(),
                "bars": e.bars.lock().0.len(),
                "backfill": e.backfill.lock().clone(),
            })).collect::<Vec<_>>(),
            "past_cached_days": past.1.values().filter(|e| e.cell.initialized()).count(),
        })
    }
}

/// A leg's volume traded since the current minute began (0 when unknown).
fn traded(quotes: &HashMap<Arc<str>, Quote>, marks: &HashMap<Arc<str>, f64>, leg: &Arc<str>) -> f64 {
    match (quotes.get(leg).and_then(|q| q.volume), marks.get(leg)) {
        (Some(now), Some(mark)) => (now - mark).max(0.0),
        _ => 0.0,
    }
}

fn snapshot_of(engine: &Engine) -> Result<Utf8Bytes, String> {
    let (done, forming) = engine.bars.lock().clone();
    let mut bars = done;
    bars.extend(forming);
    let snap = Snapshot {
        t: "straddle_snapshot",
        topic: &engine.topic,
        underlying: &engine.underlying,
        expiry: engine.expiry,
        reference: &engine.reference,
        backfill: engine.backfill.lock().clone(),
        bars,
    };
    Ok(Utf8Bytes::from(serde_json::to_string(&snap).map_err(|e| e.to_string())?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use black76_rust::undiscounted_black_price;

    #[test]
    fn step_is_the_smallest_gap() {
        assert_eq!(infer_step(&[24000.0, 24050.0, 24100.0, 24200.0], 1.0), 50.0);
    }

    #[test]
    fn cheapest_wins_but_a_tie_does_not_roll() {
        let strikes = [24900.0, 24950.0, 25000.0, 25050.0, 25100.0];
        let prices = |s: f64| -> Option<(f64, f64)> {
            Some(match s as i64 {
                24900 => (180.0, 60.0),
                24950 => (140.0, 80.0),
                25000 => (110.0, 105.0), // 215: cheapest
                25050 => (85.0, 129.9),  // 214.9: cheaper by 0.05%, not enough to roll
                25100 => (60.0, 170.0),
                _ => return None,
            })
        };
        assert_eq!(cheapest_in_band(&strikes, prices, 25000.0, 50.0, 2, None).unwrap().0, 25050.0, "first bar: plain cheapest");
        assert_eq!(cheapest_in_band(&strikes, prices, 25000.0, 50.0, 2, Some(25000.0)).unwrap().0, 25000.0, "held within 0.5%");
    }

    #[test]
    fn a_strike_missing_a_leg_is_never_selected() {
        let strikes = [100.0, 110.0, 120.0];
        let prices = |s: f64| if s == 100.0 { None } else { Some((20.0, 20.0 + s / 10.0)) };
        assert_eq!(cheapest_in_band(&strikes, prices, 110.0, 10.0, 1, None).unwrap().0, 110.0);
    }

    #[test]
    fn mid_beats_last_trade() {
        assert_eq!(leg_price(&Quote { ltp: 10.0, volume: None, bid: Some(11.0), ask: Some(13.0) }), Some(12.0));
        assert_eq!(leg_price(&Quote { ltp: 10.0, volume: None, bid: None, ask: Some(13.0) }), Some(10.0));
        assert_eq!(leg_price(&Quote::default()), None);
    }

    #[test]
    fn recovers_the_vol_a_straddle_was_priced_at() {
        // QuantDesk's own check, same numbers.
        let (forward, strike, sigma) = (24_060.0, 24_050.0, 0.142);
        let expiry = (3.0 * 86_400_000.0) as i64;
        let years = expiry as f64 / YEAR_MS;
        let call = undiscounted_black_price(forward, strike, sigma, years, OptionType::Call);
        let put = undiscounted_black_price(forward, strike, sigma, years, OptionType::Put);
        let iv = straddle_iv(strike, call, put, 0, expiry).unwrap();
        assert!((iv - 14.2).abs() < 1e-6, "got {iv}");
        assert!(straddle_iv(strike, call, put, expiry, expiry).is_none(), "no answer at expiry");
    }

    #[test]
    fn expiry_clocks() {
        let at = |d: &str, m: Market| {
            let ms = expiry_close_ms(NaiveDate::parse_from_str(d, "%Y-%m-%d").unwrap(), m).unwrap();
            ist().timestamp_millis_opt(ms).unwrap().format("%Y-%m-%d %H:%M").to_string()
        };
        assert_eq!(at("2026-10-27", Market::Nse), "2026-10-27 15:40");
        assert_eq!(at("2026-10-15", Market::Mcx), "2026-10-15 23:55", "US daylight saving");
        assert_eq!(at("2026-12-16", Market::Mcx), "2026-12-16 23:30");
    }

    #[test]
    fn vwap_is_call_side_plus_put_side() {
        let mut v = Vwap::default();
        assert_eq!(v.value(), None);
        v.add(100.0, 10.0, 90.0, 30.0);
        v.add(110.0, 30.0, 80.0, 10.0);
        // call: (1000 + 3300) / 40 = 107.5; put: (2700 + 800) / 40 = 87.5
        assert!((v.value().unwrap() - 195.0).abs() < 1e-9);
    }

    /// Whole engine on the real NIFTY chain (data/instruments must exist): fake
    /// ticks priced by Black-76 at 14% vol go in through the live engine, and
    /// the straddle must come out at the right strike, price, forward and IV.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn engine_turns_ticks_into_a_straddle() {
        use crate::model::Tick;
        let dir = std::path::PathBuf::from("data/instruments");
        if !dir.join("NFO.parquet").exists() {
            eprintln!("skipped: no instrument lists in data/instruments");
            return;
        }
        let inst = Instruments::new(dir);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let live = LiveHub::new(HashMap::from([("shoonya", tx)]), Some(inst.clone()));
        // No history brokers: the backfill fails at once, the live part is what's tested here.
        let hub = StraddleHub::new(live.clone(), inst.clone(), HistoryEngine::new(Vec::new()), None);

        let u = inst.get(Market::Nse, "NIFTY").unwrap();
        let expiry = u.expiries[0];
        let chain = inst.chain(Market::Nse, "NIFTY", expiry).unwrap();
        let strikes: Vec<f64> = chain.iter().map(|s| s.strike).collect();
        let spot = nearest_strike(24_010.0, &strikes).unwrap() + 10.0;
        let expiry_ms = expiry_close_ms(expiry, Market::Nse).unwrap();
        let feed = |c: &str| inst.resolve(&Canonical::parse(c).unwrap()).unwrap();

        let (spot_id, vix_id) = (feed("nse:nifty"), feed("nse:indiavix"));
        let legs: Vec<(String, String, f64)> =
            chain.iter().filter(|s| (s.strike - spot).abs() <= 500.0).map(|s| (feed(&s.call), feed(&s.put), s.strike)).collect();
        let publisher = {
            let live = live.clone();
            tokio::spawn(async move {
                for round in 1..=60u32 {
                    let years = (expiry_ms - now_ms()) as f64 / YEAR_MS;
                    let tick = |id: &str, ltp: f64, vol: f64| Tick {
                        id: InstrumentId(id.to_string()),
                        ltp,
                        volume: Some(vol),
                        bid: None,
                        ask: None,
                        oi: None,
                        prev_oi: None,
                        ts_ms: now_ms(),
                        src: "test",
                        replay: false,
                    };
                    live.publish(&tick(&spot_id, spot, 0.0));
                    live.publish(&tick(&vix_id, 11.5, 0.0));
                    for (c, p, k) in &legs {
                        let call = undiscounted_black_price(spot, *k, 0.14, years, OptionType::Call);
                        let put = undiscounted_black_price(spot, *k, 0.14, years, OptionType::Put);
                        live.publish(&tick(c, call, 1000.0 * round as f64));
                        live.publish(&tick(p, put, 1000.0 * round as f64));
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
        };

        let topic = format!("straddle:nse:nifty:{expiry}");
        let mine = Mailbox::new();
        let snap = hub.subscribe(&topic, &mine).unwrap();
        assert!(snap.as_str().contains("\"t\":\"straddle_snapshot\""));
        tokio::time::sleep(Duration::from_millis(3500)).await;
        let mut got = HashMap::new();
        mine.drain_into(&mut got);
        publisher.abort();
        let v: serde_json::Value = serde_json::from_str(got.get(topic.as_str()).expect("an update").as_str()).unwrap();
        let bar = &v["bar"];
        let f = |k: &str| bar[k].as_f64().unwrap_or(f64::NAN);
        println!("bar: {bar}");
        assert_eq!(f("spot"), spot);
        assert!((f("strike") - spot).abs() <= 100.0, "strike near the money");
        // Each value is sent rounded to 2 decimals, so the sum may be off by a cent.
        assert!((f("straddle") - (f("call") + f("put"))).abs() < 0.0101);
        assert!((f("synth") - spot).abs() < 0.5, "synthetic future = the forward the prices were made with");
        assert!((f("iv") - 14.0).abs() < 0.1, "IV recovered: {}", f("iv"));
        assert_eq!(f("vix"), 11.5);
        assert!(bar["vwap"].as_f64().is_some(), "VWAP once legs have traded");
    }

    #[test]
    fn candles_carry_the_last_price_and_roll_with_spot() {
        // Spot walks 100 → 112 over three minutes; strikes every 10.
        let m = |i: i64| 1_000_000 * 60 + i * 60; // candle seconds
        let spot = Series::new(&[(m(0), 0.0, 0.0, 0.0, 100.0, 0.0), (m(1), 0.0, 0.0, 0.0, 104.0, 0.0), (m(2), 0.0, 0.0, 0.0, 112.0, 0.0)]);
        let leg = |rows: &[(i64, f64, f64)]| Series::new(&rows.iter().map(|(i, px, v)| (m(*i), 0.0, 0.0, 0.0, *px, *v)).collect::<Vec<_>>());
        let mut legs = HashMap::new();
        // 100: both legs trade at minute 0 only (later minutes carry the price).
        legs.insert(strike_key(100.0), (leg(&[(0, 6.0, 10.0)]), leg(&[(0, 6.0, 10.0)])));
        // 110: cheap from minute 2.
        legs.insert(strike_key(110.0), (leg(&[(2, 3.0, 5.0)]), leg(&[(2, 3.0, 5.0)])));
        legs.insert(strike_key(90.0), (leg(&[(0, 20.0, 1.0)]), leg(&[(0, 20.0, 1.0)])));
        let strikes = [80.0, 90.0, 100.0, 110.0, 120.0];
        let built = build_bars(&spot, &legs, None, &strikes, 10.0, None, m(0) * 1000, m(3) * 1000);
        let s: Vec<f64> = built.bars.iter().map(|b| b.strike).collect();
        assert_eq!(s, vec![100.0, 100.0, 110.0], "carried price at minute 1, roll to the cheaper 110 at minute 2");
        assert!(built.bars[2].rolled && !built.bars[1].rolled);
        assert_eq!(built.bars[1].straddle, 12.0, "minute 1 carries minute 0's prices");
        assert_eq!(built.held, Some(110.0));
        // VWAP: minute 0 traded 10 @ 6 on each side, minute 2 traded 5 @ 3 → (60+15)/15 = 5 per side.
        assert!((built.vwap.value().unwrap() - 10.0).abs() < 1e-9);
    }
}
