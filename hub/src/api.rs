//! User-facing API.
//!
//! WebSocket `/ws`, JSON messages. Instruments are named canonically
//! (`nse:nifty`, `nse:nifty:2026-10-27:25000:CE`, see canonical.rs); the raw
//! `SEGMENT:token` form still works.
//!   → {"op":"search","req":"s1","q":"nif"}
//!   ← {"t":"search","req":"s1","results":[{"id":"nse:nifty","name":"NIFTY","expiries":[...],"lot":65},...]}
//!   → {"op":"chain","req":"c1","underlying":"nse:nifty","expiry":"2026-10-27"}
//!   ← {"t":"chain","req":"c1","reference":"nse:nifty","strikes":[{"strike":25000,"call":"nse:nifty:2026-10-27:25000:CE","put":...},...]}
//!   → {"op":"sub","topics":["quote:nse:nifty","quote:nse:nifty:2026-10-27:25000:CE"]}
//!   → {"op":"unsub","topics":[...]}
//!   → {"op":"history","req":"r1","id":"nse:reliance","interval":"1m","from":"2026-10-20","to":"2026-10-23"}
//!   → {"op":"sub","topics":["straddle:nse:nifty:2026-10-27"]}      today, from the open, then live
//!   ← {"t":"straddle_snapshot","topic":...,"backfill":"loading|done|...","bars":[...]}  (again when the backfill lands)
//!   ← {"t":"straddle","topic":...,"n":N,"bar":{...},"prev":{...}}   every second
//!   → {"op":"straddle_history","req":"p1","underlying":"nse:nifty","expiry":"2026-10-27","date":"2026-10-23"}
//!   ← {"t":"straddle_history","req":"p1",...,"bars":[...]}           one of the last 3 trading days
//!   ← {"t":"q","topic":"quote:nse:nifty",...}   live quote (same bytes for every subscriber)
//!   ← {"t":"hist","req":"r1","day":"...","src":"kotak","candles":[[ts,o,h,l,c,v],...]}
//!   ← {"t":"hist_done","req":"r1","ok":N,"failed":M}
//! REST: GET /health, GET /stats (this machine only), GET /history?id=&interval=&from=&to=,
//!       GET /straddle_history?underlying=&expiry=&date=
//! Answers about days that are over carry Cache-Control, so a browser (or a
//! CDN in front) keeps them and asking again costs the hub nothing.
//!
//! /ws and /history need an API key from users.toml (see users.rs), and each
//! user's limits apply: connections, live topics, history days per minute,
//! live updates per second.
//!
//! Per connection there are exactly two tasks: a reader (requests) and a
//! writer (everything sent). Live quotes come from the user's Mailbox (newest
//! value per instrument, see live.rs); replies and history come through a
//! small queue. The server pings every 30 s and drops a connection that has
//! been silent for 75 s, so dead connections don't stay open.

use crate::canonical::Canonical;
use crate::history::{HistoryEngine, PieceResult};
use crate::instruments::Instruments;
use crate::live::{LiveHub, Mailbox};
use crate::straddle::StraddleHub;
use crate::model::{InstrumentId, Interval};
use crate::users::{Conn, Users};
use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use chrono::{NaiveDate, Utc};
use futures_util::stream::{FuturesUnordered, SplitSink};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

/// Replies and history waiting to be sent to one user. History waits for room
/// here (never dropped); live quotes don't use it (they use the Mailbox).
const CONTROL_QUEUE: usize = 256;
/// Most queued replies written before one flush.
const CONTROL_BATCH: usize = 64;
const PING_EVERY: Duration = Duration::from_secs(30);
/// A connection that sent nothing (not even a pong) for this long is dead.
const IDLE_LIMIT: Duration = Duration::from_secs(75);
/// Requests from users are small; anything bigger is refused.
const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// Per-connection socket buffers. The library default is 128 KB each, which
/// alone would be ~256 KB of RAM per user.
const WS_BUFFER: usize = 8 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub live: Arc<LiveHub>,
    pub hist: Arc<HistoryEngine>,
    pub instruments: Option<Arc<Instruments>>,
    pub straddles: Option<Arc<StraddleHub>>,
    pub users: Arc<Users>,
    pub started: Instant,
    pub clients: Arc<AtomicU64>,
    pub extra: Arc<dyn Fn() -> serde_json::Value + Send + Sync>,
    /// Web pages besides the hub's own site allowed to open /ws (see `origin_allowed`).
    pub allowed_origins: Arc<Vec<String>>,
    /// Visitors reach the hub only through Cloudflare: their IP is in `CF-Connecting-IP`.
    pub behind_cloudflare: bool,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/stats", get(stats))
        .route("/history", get(history_rest))
        .route("/straddle_history", get(straddle_history_rest))
        .route("/auth", get(auth))
        .route("/ws", get(ws_upgrade))
        .with_state(state)
}

async fn health(State(s): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok": true, "uptime_s": s.started.elapsed().as_secs()}))
}

async fn stats(State(s): State<AppState>, ConnectInfo(addr): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Response {
    if !is_local(addr, &headers) {
        return (StatusCode::FORBIDDEN, "stats are only available on the hub machine").into_response();
    }
    Json(stats_json(&s)).into_response()
}

/// Headers a proxy on this machine adds when it relays a request (Caddy:
/// X-Forwarded-For; cloudflared: CF-Connecting-IP and CF-Ray).
const PROXY_HEADERS: [&str; 5] = ["x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip", "cf-ray"];

/// A request made on this machine itself: from loopback and not relayed by a
/// proxy. Caddy and cloudflared connect from loopback too, so loopback alone
/// would let a tunnel pointed straight at the hub open /stats and /admin to
/// the internet.
pub fn is_local(peer: SocketAddr, headers: &HeaderMap) -> bool {
    peer.ip().is_loopback() && !PROXY_HEADERS.iter().any(|h| headers.contains_key(*h))
}

/// Whether a browser page may open /ws. Browsers send `Origin` on every
/// WebSocket, and unlike a fetch, CORS doesn't stop another site's page from
/// using the answer: without this, any website could run on the hub (and on
/// its visitors' allowances) from its own pages. Allowed: the hub's own site
/// (Origin's host is the Host asked for, also through Caddy or the Vite dev
/// server), `allowed_origins`, and programs that send no Origin (algos and
/// scripts aren't browsers; Origin can't stop them anyway).
fn origin_allowed(allowed: &[String], headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get("origin") else { return true };
    let Ok(origin) = origin.to_str() else { return false };
    let origin = origin.trim_end_matches('/');
    let host = headers.get("host").and_then(|h| h.to_str().ok());
    let own_site = match (origin.split_once("://"), host) {
        (Some((_, authority)), Some(host)) => authority.eq_ignore_ascii_case(host),
        _ => false,
    };
    own_site || allowed.iter().any(|o| o.trim_end_matches('/').eq_ignore_ascii_case(origin))
}

#[derive(Deserialize)]
struct KeyQuery {
    key: Option<String>,
}

/// Whether a key is valid, before the page opens its WebSocket (a browser
/// can't read why a WebSocket was refused). Answers with the user's name.
async fn auth(State(s): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, Query(k): Query<KeyQuery>, headers: HeaderMap) -> Response {
    match s.users.connect(api_key(&k, &headers).as_deref(), client_ip(s.behind_cloudflare, peer, &headers)) {
        Ok(conn) => Json(serde_json::json!({"user": conn.user().name()})).into_response(),
        Err((code, msg)) => (code, msg).into_response(),
    }
}

/// The API key from `?key=`, `X-API-Key`, or `Authorization: Bearer`.
fn api_key(q: &KeyQuery, headers: &HeaderMap) -> Option<String> {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim);
    q.key
        .clone()
        .or_else(|| header("x-api-key").map(str::to_string))
        .or_else(|| header("authorization").and_then(|a| a.strip_prefix("Bearer ")).map(str::to_string))
}

/// The visitor's IP: the peer's, or, when the peer is a proxy on this machine,
/// the address it passes on. Behind Cloudflare (`behind_cloudflare`), that is
/// `CF-Connecting-IP`: Caddy and cloudflared only ever see Cloudflare's own
/// addresses, which would put every visitor in one shared allowance. Otherwise
/// the first address in Caddy's `X-Forwarded-For` (Caddy sets that itself and
/// doesn't pass on one a visitor sends). `CF-Connecting-IP` is trusted only
/// with the flag on: with no Cloudflare in front, anyone could send one
/// through Caddy to dodge the per-IP limits.
fn client_ip(behind_cloudflare: bool, peer: SocketAddr, headers: &HeaderMap) -> std::net::IpAddr {
    if peer.ip().is_loopback() {
        let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
        let cloudflare = if behind_cloudflare { header("cf-connecting-ip") } else { None };
        let forwarded = cloudflare
            .or_else(|| header("x-forwarded-for").and_then(|v| v.split(',').next()))
            .and_then(|ip| ip.trim().parse().ok());
        if let Some(ip) = forwarded {
            return ip;
        }
    }
    peer.ip()
}

/// Weekdays in the range: what a history request costs against the user's allowance.
fn days_in(from: NaiveDate, to: NaiveDate) -> u32 {
    use chrono::Datelike;
    from.iter_days()
        .take_while(|d| *d <= to)
        .filter(|d| !matches!(d.weekday(), chrono::Weekday::Sat | chrono::Weekday::Sun))
        .count() as u32
}

/// The same numbers the app window shows.
pub fn stats_json(s: &AppState) -> serde_json::Value {
    serde_json::json!({
        "uptime_s": s.started.elapsed().as_secs(),
        "memory_mb": memory_stats::memory_stats().map(|m| (m.physical_mem as f64 / 1048576.0 * 10.0).round() / 10.0),
        "clients": s.clients.load(Ordering::Relaxed),
        "users": s.users.snapshot(),
        "straddles": s.straddles.as_ref().map(|h| h.snapshot()),
        "live": s.live.snapshot(),
        "history": s.hist.snapshot(),
        "extra": (s.extra)(),
    })
}

#[derive(Deserialize)]
struct HistQuery {
    id: String,
    interval: String,
    from: NaiveDate,
    to: NaiveDate,
}

/// A history instrument from a request: canonical (`nse:reliance`) or raw (`NSE_EQ:2885`).
fn instrument(s: &AppState, id: &str) -> Result<InstrumentId, String> {
    if id.starts_with("nse:") || id.starts_with("bse:") || id.starts_with("mcx:") {
        let c = Canonical::parse(id)?;
        let feed = s.instruments.as_ref().ok_or("instrument lists are not available")?.history_id(&c)?;
        return InstrumentId::parse(&feed).ok_or_else(|| format!("{c}: bad feed id"));
    }
    InstrumentId::parse(id).ok_or_else(|| "bad id; use nse:reliance or <SEGMENT>:<token>".into())
}

fn parse_req(s: &AppState, id: &str, interval: &str) -> Result<(InstrumentId, Interval), String> {
    let id = instrument(s, id)?;
    let iv = Interval::parse(interval).ok_or("bad interval; use 1m,3m,5m,15m,30m,60m,1d")?;
    Ok((id, iv))
}

const SEARCH_LIMIT: usize = 20;
/// What a past-day straddle costs against the user's history allowance, in days.
const STRADDLE_DAY_COST: u32 = 10;

/// Search and chain replies. The first call of the day may wait for the
/// instrument lists; after that it answers from memory or a small file read.
async fn instruments_reply(s: AppState, op: Op, ctl: mpsc::Sender<Message>) {
    let Some(inst) = s.instruments.clone() else {
        let _ = ctl.send(text(serde_json::json!({"t": "err", "error": "instrument lists are not available"}))).await;
        return;
    };
    inst.ensure_fresh().await;
    let reply = match op {
        Op::Search { req, q } => serde_json::json!({"t": "search", "req": req, "results": inst.search(&q, SEARCH_LIMIT)}),
        Op::Chain { req, underlying, expiry } => {
            let chain = Canonical::parse(&underlying).and_then(|c| match c {
                Canonical::Underlying { market, .. } => {
                    let name = c.name_upper();
                    let u = inst.get(market, &name).ok_or_else(|| format!("{underlying}: no options"))?;
                    let reference = u.reference_for(expiry).map(|r| r.to_string());
                    let strikes = tokio::task::block_in_place(|| inst.chain(market, &name, expiry)).map_err(|e| e.to_string())?;
                    Ok((reference, strikes))
                }
                _ => Err(format!("{underlying}: give an underlying, e.g. nse:nifty")),
            });
            match chain {
                Ok((reference, strikes)) => serde_json::json!({
                    "t": "chain", "req": req, "underlying": underlying, "expiry": expiry, "reference": reference, "strikes": strikes,
                }),
                Err(e) => serde_json::json!({"t": "err", "req": req, "error": e}),
            }
        }
        _ => return,
    };
    let _ = ctl.send(text(reply)).await;
}

/// One piece as sent. The candles are encoded once per piece (`candles_json`)
/// and pasted in, not encoded again for every user waiting on the same piece.
fn piece_json(req: Option<&str>, day: NaiveDate, r: PieceResult) -> String {
    match r {
        Ok(d) => format!(
            r#"{{"t":"hist","req":{},"day":"{day}","src":"{}","candles":{}}}"#,
            serde_json::to_string(&req).unwrap_or_else(|_| "null".into()),
            d.source,
            d.candles_json()
        ),
        Err(e) => serde_json::json!({"t": "hist_err", "req": req, "day": day, "error": e}).to_string(),
    }
}

/// Simple REST variant: waits for all pieces and returns them together.
async fn history_rest(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(k): Query<KeyQuery>,
    headers: HeaderMap,
    Query(q): Query<HistQuery>,
) -> Response {
    let conn = match s.users.connect(api_key(&k, &headers).as_deref(), client_ip(s.behind_cloudflare, peer, &headers)) {
        Ok(c) => c,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let (id, iv) = match parse_req(&s, &q.id, &q.interval) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    if let Err(e) = conn.user().take_history(days_in(q.from, q.to)) {
        return (StatusCode::TOO_MANY_REQUESTS, e).into_response();
    }
    let pieces = match s.hist.request(id, iv, q.from, q.to) {
        Ok(p) => p,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    let mut body = String::from(r#"{"pieces":["#);
    let mut all_ok = true;
    for (i, (day, rx)) in pieces.into_iter().enumerate() {
        let r = rx.await.unwrap_or_else(|_| Err("cancelled".into()));
        all_ok &= r.is_ok();
        if i > 0 {
            body.push(',');
        }
        body.push_str(&piece_json(None, day, r));
    }
    body.push_str("]}");
    // Today's candles are still being made, and a failed piece should be asked for again.
    let cache = if all_ok && q.to < crate::clock::ist_now().date_naive() { past_day_cache(&s) } else { "no-store".into() };
    ([(header::CONTENT_TYPE, "application/json".to_string()), (header::CACHE_CONTROL, cache)], body).into_response()
}

/// How long a browser keeps an answer about days that are over. Those days
/// don't change; a day is still short enough that a bad answer (a broker
/// hiccup) doesn't stick for good.
const PAST_DAY_MAX_AGE: u32 = 86_400;

/// `public` lets a CDN in front keep one copy for everyone, which is only
/// right when no key is needed: otherwise it could hand a keyed answer to a
/// visitor without one. With keys, only the user's own browser keeps it.
fn past_day_cache(s: &AppState) -> String {
    let who = if s.users.keys_required() { "private" } else { "public" };
    format!("{who}, max-age={PAST_DAY_MAX_AGE}")
}

#[derive(Deserialize)]
struct StraddleQuery {
    underlying: String,
    expiry: NaiveDate,
    date: NaiveDate,
}

/// A past day's straddle over plain HTTP: the same bars as the WebSocket's
/// `straddle_history`, but an answer the browser can keep, so reopening a
/// day (or a CDN serving many visitors) never reaches the hub.
async fn straddle_history_rest(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(k): Query<KeyQuery>,
    headers: HeaderMap,
    Query(q): Query<StraddleQuery>,
) -> Response {
    let conn = match s.users.connect(api_key(&k, &headers).as_deref(), client_ip(s.behind_cloudflare, peer, &headers)) {
        Ok(c) => c,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let Some(hub) = s.straddles.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "straddles need the live feed").into_response();
    };
    if let Err(e) = conn.user().take_history(STRADDLE_DAY_COST) {
        return (StatusCode::TOO_MANY_REQUESTS, e).into_response();
    }
    match hub.past(&q.underlying, q.expiry, q.date).await {
        Ok(bars) => {
            let body = serde_json::json!({
                "t": "straddle_history", "underlying": q.underlying, "expiry": q.expiry, "date": q.date, "bars": &*bars,
            });
            // `past` serves only days before today: always over.
            ([(header::CACHE_CONTROL, past_day_cache(&s))], Json(body)).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn ws_upgrade(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(k): Query<KeyQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // Checked before the upgrade, so a refusal is a plain HTTP 403/401/429.
    if !origin_allowed(&s.allowed_origins, &headers) {
        return (StatusCode::FORBIDDEN, "this hub serves its own website only (allowed_origins in config.toml)").into_response();
    }
    match s.users.connect(api_key(&k, &headers).as_deref(), client_ip(s.behind_cloudflare, peer, &headers)) {
        Ok(conn) => ws
            .read_buffer_size(WS_BUFFER)
            .write_buffer_size(WS_BUFFER)
            .max_message_size(MAX_REQUEST_BYTES)
            .max_frame_size(MAX_REQUEST_BYTES)
            .on_upgrade(move |socket| client(socket, s, conn)),
        Err((code, msg)) => (code, msg).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Op {
    Sub { topics: Vec<String> },
    Unsub { topics: Vec<String> },
    History { req: String, id: String, interval: String, from: NaiveDate, to: NaiveDate },
    Search { req: String, q: String },
    StraddleHistory { req: String, underlying: String, expiry: NaiveDate, date: NaiveDate },
    Chain { req: String, underlying: String, expiry: NaiveDate },
}

fn text(v: serde_json::Value) -> Message {
    Message::Text(v.to_string().into())
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn unsubscribe(s: &AppState, topic: &str, mailbox: &Arc<Mailbox>) {
    match (&s.straddles, topic.starts_with("straddle:")) {
        (Some(h), true) => h.unsubscribe(topic, mailbox),
        _ => s.live.unsubscribe(topic, mailbox),
    }
}

/// Reads one user's requests. Everything sent to the user goes through `write_loop`.
async fn client(socket: WebSocket, s: AppState, conn: Conn) {
    let user = conn.user().clone();
    let mut kicked = user.kicked();
    tracing::debug!(user = %user.name(), "client connected");
    s.clients.fetch_add(1, Ordering::Relaxed);
    let (sink, mut stream) = socket.split();
    let mailbox = Mailbox::new();
    let (ctl, ctl_rx) = mpsc::channel::<Message>(CONTROL_QUEUE);
    let last_heard = Arc::new(AtomicI64::new(now_ms()));
    let mut writer = tokio::spawn(write_loop(sink, mailbox.clone(), ctl_rx, user.min_send_gap(), last_heard.clone()));
    let mut writer_done = false;

    let mut topics: HashSet<String> = HashSet::new();
    loop {
        let msg = tokio::select! {
            m = stream.next() => m,
            // The user was removed from users.toml.
            _ = kicked.changed() => break,
            // The writer stopped: connection broken or silent for too long.
            _ = &mut writer => {
                writer_done = true;
                break;
            }
        };
        let Some(Ok(msg)) = msg else { break };
        last_heard.store(now_ms(), Ordering::Relaxed);
        let Message::Text(t) = msg else { continue };
        let op: Op = match serde_json::from_str(t.as_str()) {
            Ok(op) => op,
            Err(e) => {
                // Echo the request id when there is one, so the client can match the error to its request.
                let req = serde_json::from_str::<serde_json::Value>(t.as_str()).ok().and_then(|v| v.get("req").cloned());
                let _ = ctl.try_send(text(serde_json::json!({"t": "err", "req": req, "error": e.to_string()})));
                continue;
            }
        };
        match op {
            Op::Sub { topics: wanted } => {
                for topic in wanted {
                    if topics.contains(&topic) {
                        continue;
                    }
                    if topics.len() >= user.max_topics() {
                        let _ = ctl.try_send(text(serde_json::json!({"t": "err", "topic": topic, "error": "topic limit reached"})));
                        continue;
                    }
                    let first = if topic.starts_with("straddle:") {
                        match &s.straddles {
                            Some(h) => h.subscribe(&topic, &mailbox).map(Some),
                            None => Err("straddles need the live feed".to_string()),
                        }
                    } else {
                        s.live.subscribe(&topic, &mailbox)
                    };
                    match first {
                        Ok(last) => {
                            let _ = ctl.try_send(text(serde_json::json!({"t": "subscribed", "topic": topic})));
                            if let Some(l) = last {
                                let _ = ctl.try_send(Message::Text(l));
                            }
                            topics.insert(topic);
                        }
                        Err(e) => {
                            let _ = ctl.try_send(text(serde_json::json!({"t": "err", "topic": topic, "error": e})));
                        }
                    }
                }
            }
            Op::Unsub { topics: unwanted } => {
                for topic in unwanted {
                    if topics.remove(&topic) {
                        unsubscribe(&s, &topic, &mailbox);
                    }
                }
            }
            Op::History { req, id, interval, from, to } => {
                let pieces = parse_req(&s, &id, &interval)
                    .and_then(|v| user.take_history(days_in(from, to)).map(|_| v))
                    .and_then(|(id, iv)| s.hist.request(id, iv, from, to));
                match pieces {
                    Ok(p) => {
                        tokio::spawn(stream_history(req, p, ctl.clone()));
                    }
                    Err(e) => {
                        let _ = ctl.try_send(text(serde_json::json!({"t": "hist_err", "req": req, "error": e})));
                    }
                }
            }
            op @ (Op::Search { .. } | Op::Chain { .. }) => {
                tokio::spawn(instruments_reply(s.clone(), op, ctl.clone()));
            }
            Op::StraddleHistory { req, underlying, expiry, date } => {
                let Some(hub) = s.straddles.clone() else {
                    let _ = ctl.try_send(text(serde_json::json!({"t": "err", "req": req, "error": "straddles need the live feed"})));
                    continue;
                };
                // Charged like a history request of this many days (a day's build is ~25 broker calls,
                // shared and cached, so this is the user's fair share, not the full cost).
                if let Err(e) = user.take_history(STRADDLE_DAY_COST) {
                    let _ = ctl.try_send(text(serde_json::json!({"t": "err", "req": req, "error": e})));
                    continue;
                }
                let ctl = ctl.clone();
                tokio::spawn(async move {
                    let reply = match hub.past(&underlying, expiry, date).await {
                        Ok(bars) => serde_json::json!({
                            "t": "straddle_history", "req": req, "underlying": underlying, "expiry": expiry, "date": date, "bars": &*bars,
                        }),
                        Err(e) => serde_json::json!({"t": "err", "req": req, "error": e}),
                    };
                    let _ = ctl.send(text(reply)).await;
                });
            }
        }
    }

    for topic in &topics {
        unsubscribe(&s, topic, &mailbox);
    }
    drop(ctl);
    if !writer_done {
        // Let it send what is queued, but never wait long on a dead connection.
        let _ = tokio::time::timeout(Duration::from_secs(2), &mut writer).await;
        writer.abort();
    }
    s.clients.fetch_sub(1, Ordering::Relaxed);
    tracing::debug!(user = %user.name(), "client disconnected");
    drop(conn);
}

/// Sends to one user: replies/history from `ctl`, live quotes from the mailbox
/// (at most one send per `gap`, newest value per instrument), and pings.
/// Messages are written in batches with one flush, not one network write each.
async fn write_loop(
    mut sink: SplitSink<WebSocket, Message>,
    mailbox: Arc<Mailbox>,
    mut ctl: mpsc::Receiver<Message>,
    gap: Option<Duration>,
    last_heard: Arc<AtomicI64>,
) {
    let mut batch: HashMap<Arc<str>, Utf8Bytes> = HashMap::new();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await; // the first tick fires at once
    let mut last_live = Instant::now();
    loop {
        let sent = tokio::select! {
            m = ctl.recv() => match m {
                // Whatever else is queued already goes out in the same flush:
                // a history request answers with dozens of pieces at once.
                Some(m) => {
                    let mut r = sink.feed(m).await;
                    let mut n = 1;
                    while r.is_ok() && n < CONTROL_BATCH {
                        let Ok(m) = ctl.try_recv() else { break };
                        r = sink.feed(m).await;
                        n += 1;
                    }
                    r
                }
                None => break,
            },
            _ = mailbox.ready() => {
                if let Some(gap) = gap {
                    let wait = gap.saturating_sub(last_live.elapsed());
                    if !wait.is_zero() {
                        tokio::time::sleep(wait).await;
                    }
                }
                last_live = Instant::now();
                mailbox.drain_into(&mut batch);
                let mut r = Ok(());
                for (_, bytes) in batch.drain() {
                    r = sink.feed(Message::Text(bytes)).await;
                    if r.is_err() {
                        break;
                    }
                }
                r
            }
            _ = ping.tick() => {
                if now_ms() - last_heard.load(Ordering::Relaxed) > IDLE_LIMIT.as_millis() as i64 {
                    break;
                }
                sink.feed(Message::Ping(Default::default())).await
            }
        };
        if sent.is_err() || sink.flush().await.is_err() {
            break;
        }
    }
}

/// Sends each history piece as soon as it arrives (newest pieces are fetched first).
async fn stream_history(req: String, pieces: Vec<(NaiveDate, oneshot::Receiver<PieceResult>)>, out: mpsc::Sender<Message>) {
    let total = pieces.len();
    let mut pending: FuturesUnordered<_> = pieces
        .into_iter()
        .map(|(day, rx)| async move { (day, rx.await.unwrap_or_else(|_| Err("cancelled".into()))) })
        .collect();
    let mut failed = 0;
    while let Some((day, r)) = pending.next().await {
        failed += r.is_err() as usize;
        // History messages wait for room (never dropped), unlike live ticks.
        if out.send(Message::Text(piece_json(Some(&req), day, r).into())).await.is_err() {
            return;
        }
    }
    let _ = out
        .send(text(serde_json::json!({"t": "hist_done", "req": req, "ok": total - failed, "failed": failed, "at": Utc::now().timestamp_millis()})))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, v.parse().unwrap());
        }
        h
    }

    #[test]
    fn websocket_only_from_the_hubs_own_site_or_listed_ones() {
        let host = ("host", "alphahedgedesk.duckdns.org");
        let none: &[String] = &[];
        assert!(origin_allowed(none, &headers(&[host, ("origin", "https://alphahedgedesk.duckdns.org")])), "own site");
        assert!(origin_allowed(none, &headers(&[("host", "localhost:5173"), ("origin", "http://localhost:5173")])), "Vite dev server");
        assert!(origin_allowed(none, &headers(&[host])), "a program: no Origin");
        assert!(!origin_allowed(none, &headers(&[host, ("origin", "https://evil.example")])), "another site");
        assert!(!origin_allowed(none, &headers(&[host, ("origin", "null")])), "sandboxed page");
        let listed = ["https://partner.example/".to_string()];
        assert!(origin_allowed(&listed, &headers(&[host, ("origin", "https://PARTNER.example")])), "listed");
    }

    #[test]
    fn visitor_ip_from_cloudflare_only_when_configured() {
        let caddy: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let h = headers(&[("x-forwarded-for", "162.158.1.1"), ("cf-connecting-ip", "49.36.10.20")]);
        assert_eq!(client_ip(true, caddy, &h).to_string(), "49.36.10.20", "behind Cloudflare: the real visitor");
        assert_eq!(client_ip(false, caddy, &h).to_string(), "162.158.1.1", "flag off: a sent CF header is ignored");
        let outsider: SocketAddr = "8.8.8.8:1234".parse().unwrap();
        assert_eq!(client_ip(true, outsider, &h).to_string(), "8.8.8.8", "headers trusted only from a proxy here");
    }

    #[test]
    fn a_piece_is_sent_as_the_same_json_as_before() {
        let d = Arc::new(crate::history::PieceData::new("nubra", vec![(1, 2.5, 3.0, 2.0, 2.75, 100.0)]));
        let day: NaiveDate = "2026-10-23".parse().unwrap();
        let sent: serde_json::Value = serde_json::from_str(&piece_json(Some("r\"1"), day, Ok(d))).unwrap();
        let expected = serde_json::json!({"t": "hist", "req": "r\"1", "day": "2026-10-23", "src": "nubra", "candles": [[1, 2.5, 3.0, 2.0, 2.75, 100.0]]});
        assert_eq!(sent, expected);
        let failed: serde_json::Value = serde_json::from_str(&piece_json(None, day, Err("x".into()))).unwrap();
        assert_eq!(failed["req"], serde_json::Value::Null);
    }

    #[test]
    fn relayed_requests_are_not_local() {
        let here: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        assert!(is_local(here, &HeaderMap::new()), "a script on the hub machine");
        assert!(!is_local(here, &headers(&[("x-forwarded-for", "1.2.3.4")])), "through Caddy");
        assert!(!is_local(here, &headers(&[("cf-connecting-ip", "1.2.3.4")])), "through a Cloudflare Tunnel");
        assert!(!is_local("10.0.0.5:1".parse().unwrap(), &HeaderMap::new()), "another machine");
    }
}
