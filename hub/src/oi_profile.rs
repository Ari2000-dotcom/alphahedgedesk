//! The OI profile: every strike's call and put open interest for one or more expiries of an
//! underlying, from Nubra's `charts/multistrike`, as QuantDesk draws it on its price axis.
//!
//! One request carries the whole chain, where subscribing to each leg's quote would take two
//! topics per strike (a NIFTY expiry lists ~235 strikes; a visitor may hold 120 topics) and the
//! quotes carry no open interest anyway. It asks for two instants at once: now (or the last
//! session's settle, outside the session), and the previous session's settle, so the browser can
//! draw today's change without a second request.
//!
//! What `multistrike` answers (probed by QuantDesk, `examples/nubra_oichg_probe.rs`): OI **as of**
//! the instant, a quiet leg's last print, but only within the same IST day (09:00 answers
//! nothing). OI keeps moving after the bell and settles by 15:39 on NSE/BSE, so a session's
//! figure is read at 15:40 (QuantDesk `oi_replay.rs`). A side missing from a strike means no
//! figure, never zero.
//!
//! Answers are kept a minute and shared by every visitor asking for the same expiries, so a
//! crowd watching NIFTY costs Nubra one call a minute, inside the limiter candle history uses.

use crate::brokers::nubra::Nubra;
use crate::canonical::{Canonical, Market};
use crate::instruments::Instruments;
use chrono::{DateTime, Datelike, Duration as CDur, NaiveDate, NaiveTime, TimeZone, Utc, Weekday};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;

/// How long an answer is shared before Nubra is asked again.
const KEEP: Duration = Duration::from_secs(60);

pub struct OiProfiles {
    nubra: Arc<Nubra>,
    instruments: Arc<Instruments>,
    /// By underlying and expiries: when it was fetched, and the reply. Held across the fetch, so
    /// visitors asking at once share one call.
    cache: AsyncMutex<HashMap<String, (Instant, Arc<Value>)>>,
}

impl OiProfiles {
    pub fn new(nubra: Arc<Nubra>, instruments: Arc<Instruments>) -> Arc<Self> {
        Arc::new(Self { nubra, instruments, cache: AsyncMutex::new(HashMap::new()) })
    }

    /// The profile of `underlying` (`nse:nifty`) over `expiries`, summed strike by strike.
    pub async fn get(&self, underlying: &str, expiries: &[NaiveDate]) -> Result<Arc<Value>, String> {
        let mut expiries = expiries.to_vec();
        expiries.sort();
        expiries.dedup();
        if expiries.is_empty() {
            return Err("pick at least one expiry".into());
        }
        let key = format!("{underlying}|{}", expiries.iter().map(|e| e.to_string()).collect::<Vec<_>>().join(","));
        let mut cache = self.cache.lock().await;
        cache.retain(|_, (at, _)| at.elapsed() < KEEP);
        if let Some((_, v)) = cache.get(&key) {
            return Ok(v.clone());
        }
        let v = Arc::new(self.fetch(underlying, &expiries).await?);
        cache.insert(key, (Instant::now(), v.clone()));
        Ok(v)
    }

    async fn fetch(&self, underlying: &str, expiries: &[NaiveDate]) -> Result<Value, String> {
        let canonical = Canonical::parse(underlying)?;
        let market = match &canonical {
            Canonical::Underlying { market, .. } => *market,
            _ => return Err(format!("{underlying}: give an underlying, e.g. nse:nifty")),
        };
        let name = canonical.name_upper();
        let mut strikes: Vec<f64> = Vec::new();
        for &expiry in expiries {
            let chain = tokio::task::block_in_place(|| self.instruments.chain(market, &name, expiry)).map_err(|e| e.to_string())?;
            strikes.extend(chain.iter().map(|s| s.strike));
        }
        strikes.sort_by(f64::total_cmp);
        strikes.dedup();
        if strikes.is_empty() {
            return Err(format!("{underlying}: no strikes for those expiries"));
        }
        let exchange = exchange_of(market);
        let (now, prev) = instants(market, Utc::now());
        let body = request_body(exchange, &name, expiries, &strikes, &[now, prev]);
        let answer = self.nubra.multistrike(&body).await?;
        let at_now = oi_at(&answer, exchange, &name, expiries, now);
        let at_prev = oi_at(&answer, exchange, &name, expiries, prev);
        let side = |at: &BTreeMap<i64, Sides>, strike: f64, put: bool| -> Value {
            at.get(&paise(strike)).and_then(|s| if put { s.put } else { s.call }).map_or(Value::Null, |v| json!(v))
        };
        Ok(json!({
            "at": now.timestamp_millis(),
            "prev_at": prev.timestamp_millis(),
            "strikes": strikes,
            "call": strikes.iter().map(|&s| side(&at_now, s, false)).collect::<Vec<_>>(),
            "put": strikes.iter().map(|&s| side(&at_now, s, true)).collect::<Vec<_>>(),
            "call_prev": strikes.iter().map(|&s| side(&at_prev, s, false)).collect::<Vec<_>>(),
            "put_prev": strikes.iter().map(|&s| side(&at_prev, s, true)).collect::<Vec<_>>(),
        }))
    }
}

fn exchange_of(market: Market) -> &'static str {
    match market {
        Market::Nse => "NSE",
        Market::Bse => "BSE",
        Market::Mcx => "MCX",
    }
}

/// A strike as Nubra keys it: paise, as an integer (23,250 → 2,325,000).
fn paise(strike: f64) -> i64 {
    (strike * 100.0).round() as i64
}

/// When a market opens, and when its open interest has settled after the close, IST.
fn session(market: Market) -> (NaiveTime, NaiveTime) {
    let t = |h, m| NaiveTime::from_hms_opt(h, m, 0).expect("valid time");
    match market {
        Market::Nse | Market::Bse => (t(9, 15), t(15, 40)),
        Market::Mcx => (t(9, 0), t(23, 40)),
    }
}

fn previous_weekday(d: NaiveDate) -> NaiveDate {
    let mut d = d - CDur::days(1);
    while matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
        d -= CDur::days(1);
    }
    d
}

/// The instant to read now (the current minute in session, else the last session's settle) and
/// the session before it's settle, the reference for today's change. A holiday reads nothing and
/// comes back without figures, never as zero.
fn instants(market: Market, now: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
    let ist = crate::clock::ist();
    let local = now.with_timezone(&ist);
    let (open, settle) = session(market);
    let at = |d: NaiveDate, t: NaiveTime| ist.from_local_datetime(&d.and_time(t)).single().expect("IST has no gaps").with_timezone(&Utc);
    let today = local.date_naive();
    let weekday = !matches!(today.weekday(), Weekday::Sat | Weekday::Sun);
    let session_day = if weekday && local.time() >= open { today } else { previous_weekday(today) };
    let read = if session_day == today {
        // The last whole minute, no later than the settle.
        let minute = now - CDur::seconds(now.timestamp() % 60) - CDur::nanoseconds(i64::from(now.timestamp_subsec_nanos()));
        minute.min(at(today, settle))
    } else {
        at(session_day, settle)
    };
    (read, at(previous_weekday(session_day), settle))
}

fn rfc3339(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// The request, as nubra.io's own OI chart sends it: one query per instant, strikes in paise,
/// expiries as `YYYYMMDD`.
fn request_body(exchange: &str, asset: &str, expiries: &[NaiveDate], strikes: &[f64], times: &[DateTime<Utc>]) -> Value {
    let keys: Vec<i64> = strikes.iter().map(|&s| paise(s)).collect();
    let min = keys.iter().min().copied().unwrap_or(0);
    let max = keys.iter().max().copied().unwrap_or(0);
    let expiries: Vec<String> = expiries.iter().map(|e| e.format("%Y%m%d").to_string()).collect();
    json!({ "query": times.iter().map(|&t| json!({
        "exchange": exchange,
        "asset": asset,
        "expiries": expiries,
        "minStrike": min,
        "maxStrike": max,
        "strikes": keys,
        "fields": ["cumulative_oi"],
        "time": rfc3339(t),
    })).collect::<Vec<_>>() })
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Sides {
    call: Option<f64>,
    put: Option<f64>,
}

/// `result[exchange][asset][<time>][<expiry>][<strike paise>].cumulative_oi.{CE,PE}` at the time
/// key that is `t` (Nubra's echo of the asked instant, read as a time rather than matched as
/// text), summed over the expiries. A side with no figure in any expiry stays unknown.
fn oi_at(answer: &Value, exchange: &str, asset: &str, expiries: &[NaiveDate], t: DateTime<Utc>) -> BTreeMap<i64, Sides> {
    let mut out: BTreeMap<i64, Sides> = BTreeMap::new();
    let Some(times) = answer.get("result").and_then(|r| r.get(exchange)).and_then(|e| e.get(asset)).and_then(Value::as_object) else {
        return out;
    };
    let Some(at) = times
        .iter()
        .find(|(k, _)| DateTime::parse_from_rfc3339(k).is_ok_and(|k| k.timestamp() == t.timestamp()))
        .map(|(_, v)| v)
    else {
        return out;
    };
    for expiry in expiries {
        let Some(strikes) = at.get(expiry.format("%Y%m%d").to_string()).and_then(Value::as_object) else { continue };
        for (strike, fields) in strikes {
            let Ok(strike) = strike.parse::<i64>() else { continue };
            let Some(oi) = fields.get("cumulative_oi") else { continue };
            let entry = out.entry(strike).or_default();
            for (side, slot) in [("CE", &mut entry.call), ("PE", &mut entry.put)] {
                if let Some(v) = oi.get(side).or_else(|| oi.get(side.to_lowercase())).and_then(Value::as_f64) {
                    *slot = Some(slot.unwrap_or(0.0) + v);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    /// The probed shape: strikes in paise under each expiry, sides under `cumulative_oi`, a
    /// missing side left missing; two expiries sum strike by strike; the other instant ignored.
    #[test]
    fn answers_parse_by_strike_and_sum_over_expiries() {
        let answer = json!({ "result": { "NSE": { "NIFTY": {
            "2026-10-28T09:50:00.000Z": {
                "20261103": {
                    "2135000": { "cumulative_oi": { "PE": 2077400 } },
                    "2150000": { "cumulative_oi": { "CE": 0, "PE": 3911765 } }
                },
                "20261110": { "2150000": { "cumulative_oi": { "CE": 100, "PE": 5 } } }
            },
            "2026-10-27T10:10:00.000Z": { "20261103": { "2150000": { "cumulative_oi": { "CE": 7 } } } }
        }}}});
        let expiries = [NaiveDate::from_ymd_opt(2026, 11, 3).unwrap(), NaiveDate::from_ymd_opt(2026, 11, 10).unwrap()];
        let now = oi_at(&answer, "NSE", "NIFTY", &expiries, utc("2026-10-28T09:50:00Z"));
        assert_eq!(now[&paise(21_350.0)], Sides { call: None, put: Some(2_077_400.0) }, "no print is not zero");
        assert_eq!(now[&paise(21_500.0)], Sides { call: Some(100.0), put: Some(3_911_770.0) });
        let prev = oi_at(&answer, "NSE", "NIFTY", &expiries, utc("2026-10-27T10:10:00Z"));
        assert_eq!(prev[&paise(21_500.0)], Sides { call: Some(7.0), put: None });
        assert!(oi_at(&answer, "NSE", "NIFTY", &expiries, utc("2026-10-26T10:10:00Z")).is_empty());
    }

    #[test]
    fn the_request_names_strikes_in_paise_and_one_query_per_instant() {
        let body = request_body("NSE", "NIFTY", &[NaiveDate::from_ymd_opt(2026, 11, 3).unwrap()], &[23_250.0, 23_300.0], &[utc("2026-10-28T09:50:00Z"), utc("2026-10-27T10:10:00Z")]);
        let q = body["query"].as_array().unwrap();
        assert_eq!(q.len(), 2);
        assert_eq!(q[0]["strikes"], json!([2_325_000, 2_330_000]));
        assert_eq!(q[0]["minStrike"], json!(2_325_000));
        assert_eq!(q[0]["expiries"], json!(["20261103"]));
        assert_eq!(q[0]["time"], json!("2026-10-28T09:50:00.000Z"));
        assert_eq!(q[1]["time"], json!("2026-10-27T10:10:00.000Z"));
    }

    /// In session: this minute and yesterday's 15:40. Before the open, on a weekend: the last
    /// session's 15:40 and the one before it (Friday's and Thursday's from a Monday morning).
    #[test]
    fn instants_follow_the_session() {
        // Wed 28 Oct 2026, 11:20:37 IST = 05:50:37Z.
        let (now, prev) = instants(Market::Nse, utc("2026-10-28T05:50:37Z"));
        assert_eq!(rfc3339(now), "2026-10-28T05:50:00.000Z");
        assert_eq!(rfc3339(prev), "2026-10-27T10:10:00.000Z");
        // Mon 2 Nov 2026, 08:00 IST: Friday 30 Oct's settle, then Thursday 29 Oct's.
        let (now, prev) = instants(Market::Nse, utc("2026-11-02T02:30:00Z"));
        assert_eq!(rfc3339(now), "2026-10-30T10:10:00.000Z");
        assert_eq!(rfc3339(prev), "2026-10-29T10:10:00.000Z");
        // After the settle the same day: today's settle, not the clock.
        let (now, _) = instants(Market::Nse, utc("2026-10-28T12:00:00Z"));
        assert_eq!(rfc3339(now), "2026-10-28T10:10:00.000Z");
    }
}
