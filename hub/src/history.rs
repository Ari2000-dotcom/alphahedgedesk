//! History engine. Requests are cut into pieces (instrument, interval, day).
//! A piece already being fetched is shared by every user who asks for it, and
//! each piece is fetched once, from a broker that has capacity right now.
//! Nothing is kept after delivery: no cache.

use crate::brokers::{FetchError, HistoryBroker};
use crate::model::{Candle, InstrumentId, Interval, PieceKey};
use crate::ratelimit::Permit;
use chrono::{Datelike, NaiveDate, Weekday};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, Notify};

const MAX_DAYS_PER_REQUEST: i64 = 92;
const MAX_ATTEMPTS: u32 = 3;
/// How often abandoned pieces are dropped, and the whole queue looked at even
/// when nothing seems to have changed (e.g. a broker's login was just fixed).
const SWEEP_EVERY: Duration = Duration::from_secs(1);

pub struct PieceData {
    pub source: &'static str,
    pub candles: Vec<Candle>,
    /// `candles` as JSON, made on first send and shared by every user waiting on the piece.
    json: OnceLock<String>,
}

impl PieceData {
    pub fn new(source: &'static str, candles: Vec<Candle>) -> Self {
        Self { source, candles, json: OnceLock::new() }
    }

    pub fn candles_json(&self) -> &str {
        self.json.get_or_init(|| serde_json::to_string(&self.candles).unwrap_or_else(|_| "[]".into()))
    }
}

pub type PieceResult = Result<Arc<PieceData>, String>;

struct Pending {
    waiters: Vec<oneshot::Sender<PieceResult>>,
    seq: u64,
    in_flight: bool,
    attempts: u32,
    not_before: Option<Instant>,
    /// Brokers that already failed this piece; the next attempt goes to
    /// another broker that serves it, if there is one.
    failed_on: Vec<&'static str>,
}

#[derive(Default)]
pub struct HistStats {
    pub requested_pieces: AtomicU64,
    pub merged: AtomicU64,
    pub fetched: AtomicU64,
    pub rate_limited: AtomicU64,
    pub errors: AtomicU64,
    pub failed: AtomicU64,
    pub abandoned: AtomicU64,
}

struct Inner {
    pending: HashMap<PieceKey, Pending>,
    next_seq: u64,
    /// A piece may go out now that couldn't at the dispatcher's last look (a
    /// new piece, or one back in the queue). Cleared when it looks.
    changed: bool,
}

pub struct HistoryEngine {
    brokers: Vec<Arc<dyn HistoryBroker>>,
    inner: Mutex<Inner>,
    notify: Notify,
    pub stats: HistStats,
}

impl HistoryEngine {
    /// `brokers` order is the preference order when several can serve a piece.
    pub fn new(brokers: Vec<Arc<dyn HistoryBroker>>) -> Arc<Self> {
        let me = Arc::new(Self {
            brokers,
            inner: Mutex::new(Inner { pending: HashMap::new(), next_seq: 0, changed: false }),
            notify: Notify::new(),
            stats: HistStats::default(),
        });
        tokio::spawn(me.clone().dispatch());
        me
    }

    /// Splits the request into day pieces and returns one receiver per piece.
    pub fn request(
        &self,
        id: InstrumentId,
        interval: Interval,
        from: NaiveDate,
        to: NaiveDate,
    ) -> Result<Vec<(NaiveDate, oneshot::Receiver<PieceResult>)>, String> {
        if to < from {
            return Err("`to` is before `from`".into());
        }
        if (to - from).num_days() > MAX_DAYS_PER_REQUEST {
            return Err(format!("max {MAX_DAYS_PER_REQUEST} days per request"));
        }
        let days: Vec<NaiveDate> = from.iter_days().take_while(|d| *d <= to).filter(|d| !matches!(d.weekday(), Weekday::Sat | Weekday::Sun)).collect();
        // The first look at an instrument may read the instrument lists from
        // disk (Nubra's batch group needs to know what it is): done here, not
        // under the lock that the dispatcher and every other request need.
        if let Some(day) = days.first() {
            let key = PieceKey { id: id.clone(), interval, day: *day };
            if let Some(b) = self.brokers.iter().find(|b| b.supports(&key)) {
                let _ = b.batch_group(&key);
            }
        }
        let mut out = Vec::new();
        let mut inner = self.inner.lock();
        for day in days {
            let key = PieceKey { id: id.clone(), interval, day };
            let (tx, rx) = oneshot::channel();
            self.stats.requested_pieces.fetch_add(1, Ordering::Relaxed);
            if let Some(p) = inner.pending.get_mut(&key) {
                p.waiters.push(tx);
                self.stats.merged.fetch_add(1, Ordering::Relaxed);
            } else if !self.brokers.iter().any(|b| b.supports(&key)) {
                let _ = tx.send(Err(format!("no broker serves {key}")));
            } else {
                let seq = inner.next_seq;
                inner.next_seq += 1;
                inner.pending.insert(key, Pending { waiters: vec![tx], seq, in_flight: false, attempts: 0, not_before: None, failed_on: Vec::new() });
                inner.changed = true;
            }
            out.push((day, rx));
        }
        drop(inner);
        self.notify.notify_one();
        Ok(out)
    }

    /// The broker a piece goes to: the first in preference order that serves it
    /// and hasn't failed it. Strict: a busy preferred broker means the piece
    /// waits, it doesn't spill to another broker (whose candles may differ a
    /// little, which made one straddle-day come out differently run to run).
    /// The next broker is used only when the preferred ones failed the piece.
    fn broker_for(&self, key: &PieceKey, failed_on: &[&'static str]) -> Option<Arc<dyn HistoryBroker>> {
        let fresh_left = self.brokers.iter().any(|b| b.supports(key) && !failed_on.contains(&b.name()));
        self.brokers.iter().find(|b| b.supports(key) && !(fresh_left && failed_on.contains(&b.name()))).cloned()
    }

    /// Picks the next pieces (most waiters first, then newest day, then oldest
    /// request) and hands each to its broker as soon as that broker can take a
    /// call. Pieces its broker can carry in the same call go along: other
    /// instruments of the same day (Nubra: 8) or other days of the same
    /// instrument (Nubra: a date range), whichever fills the call more.
    ///
    /// Under load the brokers are at their limits nearly all the time, so most
    /// wake-ups (each request, each finished call) find nothing that could go
    /// out. The queue is walked and sorted only when a broker can take a call
    /// AND something changed for it since the last look; otherwise the loop
    /// just sleeps until the first broker frees up.
    async fn dispatch(self: Arc<Self>) {
        // Brokers that had room at the end of the last look but nothing to
        // take: no reason to look again for them until something changes.
        let mut idle: Vec<&'static str> = Vec::new();
        // When the first piece held back after an error may go again.
        let mut due: Option<Instant> = None;
        let mut next_sweep = Instant::now();
        loop {
            let mut wake = Duration::from_millis(500);
            let mut launches = Vec::new();
            {
                let mut inner = self.inner.lock();
                let now = Instant::now();

                let sweep = now >= next_sweep;
                if sweep {
                    next_sweep = now + SWEEP_EVERY;
                    // Drop pieces whose users all went away.
                    let before = inner.pending.len();
                    inner.pending.retain(|_, p| p.in_flight || p.waiters.iter().any(|w| !w.is_closed()));
                    self.stats.abandoned.fetch_add((before - inner.pending.len()) as u64, Ordering::Relaxed);
                }

                let mut open: Vec<&'static str> = Vec::new();
                for b in &self.brokers {
                    match b.limiter().ready_in() {
                        w if w.is_zero() => open.push(b.name()),
                        w => wake = wake.min(w),
                    }
                }
                let worth = sweep || inner.changed || due.is_some_and(|d| d <= now) || open.iter().any(|b| !idle.contains(b));
                if !open.is_empty() && worth {
                    inner.changed = false;
                    launches = self.hand_out(&mut inner, now, &mut open, &mut wake, &mut due);
                    idle = open;
                } else if let (false, Some(d)) = (open.is_empty(), due) {
                    wake = wake.min(d.saturating_duration_since(now));
                }
            }
            for (keys, broker, permit) in launches {
                tokio::spawn(self.clone().fetch_batch(keys, broker, permit));
            }
            tokio::select! {
                _ = self.notify.notified() => {}
                _ = tokio::time::sleep(wake.max(Duration::from_millis(1))) => {}
            }
        }
    }

    /// One look at the queue: the batches to launch now, each with its permit.
    /// `open` (brokers that can take a call) loses each broker that fills up;
    /// the look ends when none is left.
    fn hand_out(
        &self,
        inner: &mut Inner,
        now: Instant,
        open: &mut Vec<&'static str>,
        wake: &mut Duration,
        due: &mut Option<Instant>,
    ) -> Vec<(Vec<PieceKey>, Arc<dyn HistoryBroker>, Permit)> {
        *due = None;
        let mut ready: Vec<(PieceKey, usize, u64)> = Vec::new();
        for (k, p) in inner.pending.iter() {
            if p.in_flight {
                continue;
            }
            match p.not_before {
                Some(nb) if nb > now => {
                    *wake = (*wake).min(nb - now);
                    *due = Some(due.map_or(nb, |d| d.min(nb)));
                }
                _ => ready.push((k.clone(), p.waiters.len(), p.seq)),
            }
        }
        ready.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.day.cmp(&a.0.day)).then(a.2.cmp(&b.2)));

        let mut launches = Vec::new();
        let failed = |inner: &Inner, k: &PieceKey| inner.pending.get(k).map(|p| p.failed_on.clone()).unwrap_or_default();
        for i in 0..ready.len() {
            if open.is_empty() {
                break; // every broker is busy now
            }
            let key = &ready[i].0;
            if inner.pending.get(key).is_none_or(|p| p.in_flight) {
                continue; // went out with an earlier batch
            }
            let Some(broker) = self.broker_for(key, &failed(inner, key)) else { continue };
            if !open.contains(&broker.name()) {
                continue;
            }
            let permit = match broker.limiter().try_acquire() {
                Ok(p) => p,
                Err(w) => {
                    *wake = (*wake).min(w);
                    open.retain(|b| *b != broker.name());
                    continue;
                }
            };
            let mut batch = vec![key.clone()];
            // A piece that failed once goes alone from then on, so one bad
            // instrument can't keep sinking the others it shares a call with.
            let first_try = |inner: &Inner, k: &PieceKey| inner.pending.get(k).is_some_and(|p| p.attempts == 0 && !p.in_flight);
            if first_try(inner, key) {
                let rest = &ready[i + 1..];
                let same_broker = |inner: &Inner, k: &PieceKey| self.broker_for(k, &failed(inner, k)).is_some_and(|b| b.name() == broker.name());
                // One day, several instruments. Cheap checks first: most of the queue is other days.
                let mut by_day = Vec::new();
                if let Some(group) = (broker.max_batch() > 1).then(|| broker.batch_group(key)).flatten() {
                    for (other, _, _) in rest {
                        if by_day.len() + 1 >= broker.max_batch() {
                            break;
                        }
                        if other.day == key.day
                            && other.interval == key.interval
                            && first_try(inner, other)
                            && same_broker(inner, other)
                            && broker.batch_group(other).as_deref() == Some(group.as_str())
                        {
                            by_day.push(other.clone());
                        }
                    }
                }
                // One instrument, several days within the broker's span.
                let mut by_span = Vec::new();
                let span = broker.max_span_days(key.interval);
                if span > 1 {
                    let (mut first, mut last) = (key.day, key.day);
                    for (other, _, _) in rest {
                        if other.id != key.id || other.interval != key.interval {
                            continue;
                        }
                        let (f, l) = (first.min(other.day), last.max(other.day));
                        if (l - f).num_days() < span && first_try(inner, other) && same_broker(inner, other) {
                            by_span.push(other.clone());
                            (first, last) = (f, l);
                        }
                    }
                }
                batch.extend(if by_span.len() > by_day.len() { by_span } else { by_day });
            }
            for k in &batch {
                inner.pending.get_mut(k).unwrap().in_flight = true;
            }
            launches.push((batch, broker, permit));
        }
        launches
    }

    /// One broker call for one or more pieces; each piece's result is handled on its own.
    async fn fetch_batch(self: Arc<Self>, keys: Vec<PieceKey>, broker: Arc<dyn HistoryBroker>, permit: Permit) {
        let results = if keys.len() == 1 { vec![broker.fetch(&keys[0]).await] } else { broker.fetch_batch(&keys).await };
        drop(permit);
        let mut penalized = false;
        {
            let mut inner = self.inner.lock();
            for (key, res) in keys.into_iter().zip(results) {
                if matches!(res, Err(FetchError::RateLimited(_))) && penalized {
                    // One "too many requests" is one penalty, not one per piece in the call.
                    if let Some(p) = inner.pending.get_mut(&key) {
                        p.in_flight = false;
                    }
                    inner.changed = true;
                    continue;
                }
                penalized |= matches!(res, Err(FetchError::RateLimited(_)));
                self.settle(&mut inner, key, &broker, res);
            }
        }
        self.notify.notify_one();
    }

    fn settle(&self, inner: &mut Inner, key: PieceKey, broker: &Arc<dyn HistoryBroker>, res: Result<Vec<Candle>, FetchError>) {
        {
            match res {
                Ok(candles) => {
                    broker.limiter().success();
                    self.stats.fetched.fetch_add(1, Ordering::Relaxed);
                    let data = Arc::new(PieceData::new(broker.name(), candles));
                    if let Some(p) = inner.pending.remove(&key) {
                        for w in p.waiters {
                            let _ = w.send(Ok(data.clone()));
                        }
                    }
                }
                Err(FetchError::RateLimited(retry)) => {
                    // Should stay at 0 with correct limits; if a broker complains anyway,
                    // that broker slows down and the piece goes back in the queue.
                    self.stats.rate_limited.fetch_add(1, Ordering::Relaxed);
                    broker.limiter().penalize(retry);
                    if let Some(p) = inner.pending.get_mut(&key) {
                        p.in_flight = false;
                    }
                    inner.changed = true;
                }
                Err(e) => {
                    self.stats.errors.fetch_add(1, Ordering::Relaxed);
                    let msg = match e {
                        FetchError::Auth(m) => format!("{} login problem: {m}", broker.name()),
                        FetchError::Other(m) => format!("{}: {m}", broker.name()),
                        FetchError::RateLimited(_) => unreachable!("handled above"),
                    };
                    tracing::warn!(piece = %key, error = %msg, "history fetch failed");
                    if let Some(p) = inner.pending.get_mut(&key) {
                        p.attempts += 1;
                        p.in_flight = false;
                        if !p.failed_on.contains(&broker.name()) {
                            p.failed_on.push(broker.name());
                        }
                        if p.attempts >= MAX_ATTEMPTS {
                            let p = inner.pending.remove(&key).unwrap();
                            self.stats.failed.fetch_add(1, Ordering::Relaxed);
                            for w in p.waiters {
                                let _ = w.send(Err(msg.clone()));
                            }
                        } else {
                            p.not_before = Some(Instant::now() + Duration::from_secs(1 << p.attempts));
                            inner.changed = true;
                        }
                    }
                }
            }
        }
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let s = &self.stats;
        let pending = self.inner.lock().pending.len();
        let g = |a: &AtomicU64| a.load(Ordering::Relaxed);
        serde_json::json!({
            "pending_pieces": pending,
            "requested_pieces": g(&s.requested_pieces),
            "merged_into_existing_fetch": g(&s.merged),
            "broker_calls_ok": g(&s.fetched),
            "rate_limited_by_broker": g(&s.rate_limited),
            "errors": g(&s.errors),
            "failed_pieces": g(&s.failed),
            "abandoned_pieces": g(&s.abandoned),
            "brokers": self.brokers.iter().map(|b| (b.name().to_string(), b.limiter().snapshot())).collect::<HashMap<_, _>>(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::InstrumentId;
    use crate::ratelimit::{LimitSpec, Limiter};
    use async_trait::async_trait;

    /// Serves anything. One call carries 3 instruments of a day, or 10 calendar days of one.
    struct Counting {
        limiter: Arc<Limiter>,
        calls: AtomicU64,
    }

    #[async_trait]
    impl HistoryBroker for Counting {
        fn name(&self) -> &'static str {
            "test"
        }
        fn limiter(&self) -> Arc<Limiter> {
            self.limiter.clone()
        }
        fn supports(&self, _: &PieceKey) -> bool {
            true
        }
        async fn fetch(&self, key: &PieceKey) -> Result<Vec<Candle>, FetchError> {
            self.fetch_batch(std::slice::from_ref(key)).await.pop().unwrap()
        }
        fn max_batch(&self) -> usize {
            3
        }
        fn batch_group(&self, key: &PieceKey) -> Option<String> {
            Some(key.day.to_string())
        }
        fn max_span_days(&self, _: Interval) -> i64 {
            10
        }
        async fn fetch_batch(&self, keys: &[PieceKey]) -> Vec<Result<Vec<Candle>, FetchError>> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            keys.iter().map(|k| Ok(vec![(k.day.and_hms_opt(4, 0, 0).unwrap().and_utc().timestamp(), 1.0, 1.0, 1.0, 1.0, 1.0)])).collect()
        }
    }

    /// One call at a time, 20 ms apart, no batching. The first call for each
    /// piece of `NSE_EQ:flaky` fails, so it is retried after the backoff.
    struct Strict {
        limiter: Arc<Limiter>,
        calls: AtomicU64,
        failed_once: Mutex<std::collections::HashSet<PieceKey>>,
    }

    #[async_trait]
    impl HistoryBroker for Strict {
        fn name(&self) -> &'static str {
            "strict"
        }
        fn limiter(&self) -> Arc<Limiter> {
            self.limiter.clone()
        }
        fn supports(&self, _: &PieceKey) -> bool {
            true
        }
        async fn fetch(&self, key: &PieceKey) -> Result<Vec<Candle>, FetchError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            if key.id.token() == "flaky" && self.failed_once.lock().insert(key.clone()) {
                return Err(FetchError::Other("first try fails".into()));
            }
            Ok(vec![(key.day.and_hms_opt(4, 0, 0).unwrap().and_utc().timestamp(), 1.0, 1.0, 1.0, 1.0, 1.0)])
        }
    }

    fn engine() -> (Arc<HistoryEngine>, Arc<Counting>) {
        let spec = LimitSpec { per_second: None, per_minute: None, per_hour: None, min_interval_ms: None, use_fraction: 1.0, max_in_flight: 4 };
        let broker = Arc::new(Counting { limiter: Limiter::new("test", &spec), calls: AtomicU64::new(0) });
        (HistoryEngine::new(vec![broker.clone()]), broker)
    }

    async fn all(pieces: Vec<(NaiveDate, oneshot::Receiver<PieceResult>)>) -> Vec<NaiveDate> {
        let mut days = Vec::new();
        for (day, rx) in pieces {
            let data = rx.await.unwrap().unwrap();
            assert_eq!(data.candles[0].0, day.and_hms_opt(4, 0, 0).unwrap().and_utc().timestamp(), "each piece got its own day");
            days.push(day);
        }
        days
    }

    #[tokio::test]
    async fn many_days_of_one_instrument_share_calls() {
        let (hist, broker) = engine();
        let d = |s: &str| s.parse::<NaiveDate>().unwrap();
        let pieces = hist.request(InstrumentId("NSE_EQ:1".into()), Interval::M1, d("2026-01-05"), d("2026-01-30")).unwrap();
        assert_eq!(all(pieces).await.len(), 20, "20 weekdays");
        // Newest first, 10 calendar days a call: 21–30 Jan, 12–20 Jan, 5–9 Jan.
        assert_eq!(broker.calls.load(Ordering::Relaxed), 3);
    }

    #[tokio::test]
    async fn one_day_of_several_instruments_shares_calls() {
        let (hist, broker) = engine();
        let day: NaiveDate = "2026-01-05".parse().unwrap();
        let mut pieces = Vec::new();
        for t in 0..5 {
            pieces.extend(hist.request(InstrumentId(format!("NSE_FO:{t}")), Interval::M1, day, day).unwrap());
        }
        assert_eq!(all(pieces).await.len(), 5);
        assert_eq!(broker.calls.load(Ordering::Relaxed), 2, "3 + 2 instruments");
    }

    #[tokio::test]
    async fn a_busy_broker_and_retries_still_deliver_every_piece() {
        let spec = LimitSpec { per_second: None, per_minute: None, per_hour: None, min_interval_ms: Some(20), use_fraction: 1.0, max_in_flight: 1 };
        let broker = Arc::new(Strict { limiter: Limiter::new("strict", &spec), calls: AtomicU64::new(0), failed_once: Mutex::new(Default::default()) });
        let hist = HistoryEngine::new(vec![broker.clone()]);
        let d = |s: &str| s.parse::<NaiveDate>().unwrap();
        let mut pieces = hist.request(InstrumentId("NSE_EQ:1".into()), Interval::M1, d("2026-01-05"), d("2026-01-16")).unwrap();
        pieces.extend(hist.request(InstrumentId("NSE_EQ:flaky".into()), Interval::M1, d("2026-01-05"), d("2026-01-16")).unwrap());
        let done = tokio::time::timeout(Duration::from_secs(10), all(pieces)).await.expect("every piece delivered, none stuck");
        assert_eq!(done.len(), 20);
        assert_eq!(broker.calls.load(Ordering::Relaxed), 30, "20 pieces + 10 retries");
    }
}
