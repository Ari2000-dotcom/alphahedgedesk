//! Simulated broker for load tests (markets closed, or to prove limits hold).
//! Its *server side* strictly enforces `server_limits` and counts every
//! violation, exactly like a real broker would reject with HTTP 429.

use super::{FetchError, HistoryBroker};
use crate::live::{FeedCmd, LiveHub};
use crate::model::{Candle, InstrumentId, Interval, PieceKey, Tick};
use crate::ratelimit::{LimitSpec, Limiter};
use async_trait::async_trait;
use chrono::{NaiveTime, TimeZone};
use parking_lot::Mutex;
use rand::{rngs::StdRng, Rng, SeedableRng};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub struct Sim {
    limiter: Arc<Limiter>,
    server: Mutex<Vec<(Duration, u32, VecDeque<Instant>)>>,
    latency_ms: [u64; 2],
    pub calls: AtomicU64,
    pub violations: AtomicU64,
}

impl Sim {
    pub fn new(hub_limits: &LimitSpec, server_limits: &LimitSpec, latency_ms: [u64; 2]) -> Self {
        let mut server = Vec::new();
        for (n, secs) in [
            (server_limits.per_second, 1),
            (server_limits.per_minute, 60),
            (server_limits.per_hour, 3600),
        ] {
            if let Some(n) = n {
                server.push((Duration::from_secs(secs), n, VecDeque::new()));
            }
        }
        Self {
            limiter: Limiter::new("sim.history", hub_limits),
            server: Mutex::new(server),
            latency_ms,
            calls: AtomicU64::new(0),
            violations: AtomicU64::new(0),
        }
    }

    /// The "broker server" view: true if this call breaks a limit.
    fn server_rejects(&self) -> bool {
        let now = Instant::now();
        let mut s = self.server.lock();
        let mut over = false;
        for (span, limit, log) in s.iter_mut() {
            while log.front().map(|&t| now.duration_since(t) >= *span).unwrap_or(false) {
                log.pop_front();
            }
            if log.len() as u32 >= *limit {
                over = true;
            }
        }
        if !over {
            for (_, _, log) in s.iter_mut() {
                log.push_back(now);
            }
        }
        over
    }
}

#[async_trait]
impl HistoryBroker for Sim {
    fn name(&self) -> &'static str {
        "sim"
    }
    fn limiter(&self) -> Arc<Limiter> {
        self.limiter.clone()
    }
    fn supports(&self, key: &PieceKey) -> bool {
        key.id.segment() == "SIM"
    }

    async fn fetch(&self, key: &PieceKey) -> Result<Vec<Candle>, FetchError> {
        self.fetch_batch(std::slice::from_ref(key)).await.pop().unwrap_or_else(|| Ok(Vec::new()))
    }

    /// Like Nubra: one call covers several days of an instrument.
    fn max_span_days(&self, _interval: Interval) -> i64 {
        31
    }

    /// One call to the simulated server for the whole batch, as a real broker counts it.
    async fn fetch_batch(&self, keys: &[PieceKey]) -> Vec<Result<Vec<Candle>, FetchError>> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        if self.server_rejects() {
            self.violations.fetch_add(1, Ordering::Relaxed);
            return keys.iter().map(|_| Err(FetchError::RateLimited(Some(Duration::from_secs(1))))).collect();
        }
        let delay = rand::thread_rng().gen_range(self.latency_ms[0]..=self.latency_ms[1]);
        tokio::time::sleep(Duration::from_millis(delay)).await;
        keys.iter().map(|k| Ok(candles(k))).collect()
    }
}

/// Deterministic candles per (instrument, day) so repeated fetches agree.
fn candles(key: &PieceKey) -> Vec<Candle> {
    let seed = key.id.0.bytes().fold(key.day.to_string().len() as u64, |a, b| a * 31 + b as u64)
        ^ key.day.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp() as u64;
    let mut rng = StdRng::seed_from_u64(seed);
    let step = key.interval.minutes();
    let open = chrono::Local
        .from_local_datetime(&key.day.and_time(NaiveTime::from_hms_opt(9, 15, 0).unwrap()))
        .unwrap()
        .timestamp();
    let mut px = 100.0 + (seed % 900) as f64;
    let n = (375 / step).max(1);
    (0..n)
        .map(|i| {
            let o = px;
            let c = (o + rng.gen_range(-0.5..0.5)).max(1.0);
            px = c;
            let (h, l) = (o.max(c) + rng.gen_range(0.0..0.3), o.min(c) - rng.gen_range(0.0..0.3));
            (open + (i * step) as i64 * 60, o, h, l, c, rng.gen_range(100.0..5000.0))
        })
        .collect()
}

/// Live ticks for subscribed `SIM:*` instruments, every `tick_ms`.
pub async fn run_feed(hub: Arc<LiveHub>, mut rx: mpsc::UnboundedReceiver<FeedCmd>, tick_ms: u64) {
    let mut rng = StdRng::from_entropy();
    // Per instrument: price, cumulative volume, open interest, and price x volume traded (the
    // running sum an average traded price divides by the volume).
    let mut subs: HashMap<InstrumentId, (f64, f64, f64, f64)> = HashMap::new();
    let mut every = tokio::time::interval(Duration::from_millis(tick_ms));
    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(FeedCmd::Sub(id)) => { subs.entry(id).or_insert((1000.0, 0.0, 250_000.0, 0.0)); }
                Some(FeedCmd::Unsub(id)) => { subs.remove(&id); }
                None => return,
            },
            _ = every.tick() => {
                let now = chrono::Utc::now().timestamp_millis();
                for (id, (px, vol, oi, turnover)) in subs.iter_mut() {
                    *px = (*px + rng.gen_range(-0.5..0.5)).max(1.0);
                    let traded = rng.gen_range(1.0f64..50.0).floor();
                    *vol += traded;
                    *turnover += traded * *px;
                    *oi = (*oi + rng.gen_range(-900.0f64..1000.0).floor()).max(0.0);
                    let ltp = (*px * 100.0).round() / 100.0;
                    hub.publish(&Tick { id: id.clone(), ltp, volume: Some(*vol), bid: Some(ltp - 0.05), ask: Some(ltp + 0.05), oi: Some(*oi), prev_oi: None, atp: Some((*turnover / *vol * 100.0).round() / 100.0), ts_ms: now, src: "sim", replay: false });
                }
            }
        }
    }
}
