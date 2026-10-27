//! The gatekeeper: every outgoing broker call must get a `Permit` from that
//! broker's `Limiter` first.
//!
//! Sliding-window logs are used instead of token buckets on purpose: a token
//! bucket of capacity C refilling C/min can let ~2C calls through inside one
//! 60 s window, which would break a broker's per-minute limit. A log never
//! lets more than the limit through in any window, fixed or sliding.

use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn default_fraction() -> f64 {
    0.8
}
fn default_in_flight() -> usize {
    4
}

#[derive(Clone, Debug, Deserialize)]
pub struct LimitSpec {
    pub per_second: Option<u32>,
    pub per_minute: Option<u32>,
    pub per_hour: Option<u32>,
    /// Minimum gap between two calls. Needed for brokers that reject any call
    /// arriving too soon after the previous one (Kotak history: ~1/s, measured).
    pub min_interval_ms: Option<u64>,
    #[serde(default = "default_fraction")]
    pub use_fraction: f64,
    #[serde(default = "default_in_flight")]
    pub max_in_flight: usize,
}

struct Window {
    span: Duration,
    limit: u32,
    log: VecDeque<Instant>,
}

impl Window {
    fn prune(&mut self, now: Instant) {
        while let Some(&t) = self.log.front() {
            if now.duration_since(t) >= self.span {
                self.log.pop_front();
            } else {
                break;
            }
        }
    }
}

struct State {
    windows: Vec<Window>,
    min_interval: Option<Duration>,
    last_grant: Option<Instant>,
    paused_until: Option<Instant>,
    /// Adaptive slowdown after a broker complains: 1.0 = full configured rate.
    factor_after_penalty: f64,
    last_penalty: Option<Instant>,
    consecutive_penalties: u32,
}

impl State {
    /// Recovers linearly by +0.1 every 30 s after the last penalty, up to 1.0.
    fn factor(&self, now: Instant) -> f64 {
        match self.last_penalty {
            None => 1.0,
            Some(t) => {
                let recovered = now.duration_since(t).as_secs_f64() / 30.0 * 0.1;
                (self.factor_after_penalty + recovered).min(1.0)
            }
        }
    }
}

pub struct Limiter {
    pub name: String,
    state: Mutex<State>,
    in_flight: AtomicUsize,
    max_in_flight: usize,
    pub granted: AtomicU64,
    pub penalties: AtomicU64,
}

fn scaled(limit: u32, factor: f64) -> u32 {
    ((limit as f64 * factor).floor() as u32).max(1)
}

impl Limiter {
    pub fn new(name: &str, spec: &LimitSpec) -> Arc<Self> {
        let f = spec.use_fraction.clamp(0.1, 1.0);
        let mut windows = Vec::new();
        for (n, secs) in [(spec.per_second, 1), (spec.per_minute, 60), (spec.per_hour, 3600)] {
            if let Some(n) = n {
                windows.push(Window {
                    span: Duration::from_secs(secs),
                    limit: scaled(n, f),
                    log: VecDeque::new(),
                });
            }
        }
        Arc::new(Self {
            name: name.to_string(),
            state: Mutex::new(State {
                windows,
                min_interval: spec.min_interval_ms.map(Duration::from_millis),
                last_grant: None,
                paused_until: None,
                factor_after_penalty: 1.0,
                last_penalty: None,
                consecutive_penalties: 0,
            }),
            in_flight: AtomicUsize::new(0),
            max_in_flight: spec.max_in_flight.max(1),
            granted: AtomicU64::new(0),
            penalties: AtomicU64::new(0),
        })
    }

    /// How long until a call may go out (zero = now).
    fn wait(&self, s: &mut State, now: Instant) -> Duration {
        if let Some(p) = s.paused_until {
            if now < p {
                return p - now;
            }
            s.paused_until = None;
        }
        if self.in_flight.load(Ordering::Acquire) >= self.max_in_flight {
            return Duration::from_millis(20);
        }
        let factor = s.factor(now);
        let mut wait = Duration::ZERO;
        if let (Some(gap), Some(last)) = (s.min_interval, s.last_grant) {
            // Slowed down after a penalty → the gap grows by the same factor.
            let gap = gap.div_f64(factor);
            wait = gap.saturating_sub(now.duration_since(last));
        }
        for w in s.windows.iter_mut() {
            w.prune(now);
            let lim = scaled(w.limit, factor) as usize;
            if w.log.len() >= lim {
                // The (len - lim)-th oldest call must leave the window first.
                let t = w.log[w.log.len() - lim];
                wait = wait.max(w.span.saturating_sub(now.duration_since(t)));
            }
        }
        wait
    }

    /// How long until `try_acquire` could grant a permit (zero = now), without taking one.
    pub fn ready_in(&self) -> Duration {
        self.wait(&mut self.state.lock(), Instant::now())
    }

    /// Grants a permit now, or says how long until one could be granted.
    pub fn try_acquire(self: &Arc<Self>) -> Result<Permit, Duration> {
        let now = Instant::now();
        let mut s = self.state.lock();
        let wait = self.wait(&mut s, now);
        if wait > Duration::ZERO {
            return Err(wait);
        }
        for w in s.windows.iter_mut() {
            w.log.push_back(now);
        }
        s.last_grant = Some(now);
        self.in_flight.fetch_add(1, Ordering::AcqRel);
        self.granted.fetch_add(1, Ordering::Relaxed);
        Ok(Permit { lim: self.clone() })
    }

    /// The broker rejected us (e.g. HTTP 429): pause, halve the rate, recover slowly.
    pub fn penalize(&self, retry_after: Option<Duration>) {
        let now = Instant::now();
        let mut s = self.state.lock();
        s.consecutive_penalties += 1;
        let backoff = retry_after
            .unwrap_or_else(|| Duration::from_secs(1 << s.consecutive_penalties.min(6)));
        s.paused_until = Some(now + backoff);
        s.factor_after_penalty = (s.factor(now) * 0.5).max(0.25);
        s.last_penalty = Some(now);
        self.penalties.fetch_add(1, Ordering::Relaxed);
        tracing::warn!(limiter = %self.name, ?backoff, "broker rate-limited us; pausing and slowing down");
    }

    pub fn success(&self) {
        self.state.lock().consecutive_penalties = 0;
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let now = Instant::now();
        let mut s = self.state.lock();
        let factor = s.factor(now);
        let windows: Vec<_> = s
            .windows
            .iter_mut()
            .map(|w| {
                w.prune(now);
                serde_json::json!({
                    "window_s": w.span.as_secs(),
                    "used": w.log.len(),
                    "allowed": scaled(w.limit, factor),
                })
            })
            .collect();
        serde_json::json!({
            "granted": self.granted.load(Ordering::Relaxed),
            "penalties": self.penalties.load(Ordering::Relaxed),
            "in_flight": self.in_flight.load(Ordering::Relaxed),
            "rate_factor": factor,
            "paused": s.paused_until.map(|p| p > now).unwrap_or(false),
            "windows": windows,
        })
    }
}

pub struct Permit {
    lim: Arc<Limiter>,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.lim.in_flight.fetch_sub(1, Ordering::AcqRel);
    }
}
