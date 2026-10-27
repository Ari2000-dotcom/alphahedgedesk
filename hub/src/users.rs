//! API keys and per-user limits, from users.toml next to config.toml.
//! The file is re-read whenever it changes: a new user can connect at once,
//! changed limits apply at once, and a removed user is disconnected.
//!
//! A key is sent as `?key=...` (works from browsers), an `X-API-Key` header,
//! or `Authorization: Bearer ...`.

use axum::http::StatusCode;
use parking_lot::{Mutex, RwLock};
use serde::Deserialize;
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::watch;

const MIN_KEY_LEN: usize = 20;

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct UserCfg {
    pub name: String,
    pub key: String,
    /// Open connections at once (each browser tab / app instance is one).
    #[serde(default = "default_connections")]
    pub max_connections: usize,
    /// Live instruments per connection.
    #[serde(default = "default_topics")]
    pub max_topics: usize,
    /// History allowance, in instrument-days per minute (a 5-day request uses 5).
    #[serde(default = "default_history")]
    pub history_days_per_minute: u32,
    /// Live updates per instrument per second at most (newest value wins);
    /// 0 = every tick as it comes (for algos).
    #[serde(default = "default_updates")]
    pub max_updates_per_sec: u32,
}
fn default_connections() -> usize {
    3
}
/// An option chain holds about 90 (41 strikes, both legs) beside the indices and a chart.
fn default_topics() -> usize {
    120
}
fn default_history() -> u32 {
    200
}
fn default_updates() -> u32 {
    10
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UsersFile {
    #[serde(default)]
    user: Vec<UserCfg>,
}

pub struct User {
    cfg: RwLock<UserCfg>,
    conns: AtomicUsize,
    /// History token bucket: (tokens left, last refill).
    bucket: Mutex<(f64, Instant)>,
    /// Bumped when the user is removed: their open connections close.
    kick: watch::Sender<u64>,
}

impl User {
    fn new(cfg: UserCfg) -> Arc<Self> {
        let full = cfg.history_days_per_minute as f64;
        Arc::new(Self { cfg: RwLock::new(cfg), conns: AtomicUsize::new(0), bucket: Mutex::new((full, Instant::now())), kick: watch::channel(0).0 })
    }

    pub fn name(&self) -> String {
        self.cfg.read().name.clone()
    }

    pub fn max_topics(&self) -> usize {
        self.cfg.read().max_topics
    }

    /// Shortest gap between two sends of live updates (None = send at once).
    pub fn min_send_gap(&self) -> Option<Duration> {
        match self.cfg.read().max_updates_per_sec {
            0 => None,
            n => Some(Duration::from_secs(1) / n),
        }
    }

    /// Takes `days` from this user's per-minute history allowance.
    pub fn take_history(&self, days: u32) -> Result<(), String> {
        let rate = self.cfg.read().history_days_per_minute as f64;
        let mut b = self.bucket.lock();
        let now = Instant::now();
        b.0 = (b.0 + now.duration_since(b.1).as_secs_f64() * rate / 60.0).min(rate);
        b.1 = now;
        if days as f64 > b.0 {
            return Err(format!("history limit for this key: {} days per minute — try again shortly", rate as u64));
        }
        b.0 -= days as f64;
        Ok(())
    }

    pub fn kicked(&self) -> watch::Receiver<u64> {
        self.kick.subscribe()
    }
}

/// One open connection; frees its slot when dropped.
pub struct Conn(Arc<User>);

impl Conn {
    pub fn user(&self) -> &Arc<User> {
        &self.0
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        self.0.conns.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Limits for visitors without a key (`require_keys = false`), per IP address.
/// Broker limits don't depend on these (the history engine enforces those for
/// everyone together); these keep one visitor from hogging the hub. Several
/// people behind one mobile-network IP share them, so they are generous.
#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct GuestLimits {
    #[serde(default = "guest_connections")]
    pub max_connections: usize,
    #[serde(default = "default_topics")]
    pub max_topics: usize,
    #[serde(default = "guest_history")]
    pub history_days_per_minute: u32,
    #[serde(default = "default_updates")]
    pub max_updates_per_sec: u32,
}
fn guest_connections() -> usize {
    20
}
fn guest_history() -> u32 {
    120
}

impl Default for GuestLimits {
    fn default() -> Self {
        Self {
            max_connections: guest_connections(),
            max_topics: default_topics(),
            history_days_per_minute: guest_history(),
            max_updates_per_sec: default_updates(),
        }
    }
}

/// A guest unused for this long is forgotten (its history allowance resets).
const GUEST_FORGET: Duration = Duration::from_secs(600);

pub struct Users {
    path: PathBuf,
    required: bool,
    by_key: RwLock<HashMap<String, Arc<User>>>,
    /// Visitors without a key, one entry per IP, when keys are optional.
    guests: Mutex<HashMap<IpAddr, (Arc<User>, Instant)>>,
    guest_limits: GuestLimits,
}

impl Users {
    pub fn open(path: PathBuf, required: bool, guest_limits: GuestLimits) -> Arc<Self> {
        let me = Arc::new(Self { path, required, by_key: RwLock::new(HashMap::new()), guests: Mutex::new(HashMap::new()), guest_limits });
        if !required {
            tracing::info!(limits = ?me.guest_limits, "open to everyone: visitors without a key get guest limits per IP; keys in users.toml still work");
        }
        let watcher = me.clone();
        tokio::spawn(async move {
            let mut seen: Option<SystemTime> = None;
            // With keys optional, no users file is normal.
            let mut missing_logged = !watcher.required;
            loop {
                watcher.forget_idle_guests();
                match std::fs::metadata(&watcher.path).and_then(|m| m.modified()) {
                    Ok(m) if Some(m) != seen => {
                        seen = Some(m);
                        missing_logged = false;
                        match watcher.reload() {
                            Ok(n) => tracing::info!(users = n, file = %watcher.path.display(), "users loaded"),
                            Err(e) => tracing::error!(error = %e, file = %watcher.path.display(), "users file has a mistake; keeping the previous users"),
                        }
                    }
                    Ok(_) => {}
                    Err(_) if !missing_logged => {
                        missing_logged = true;
                        tracing::warn!(file = %watcher.path.display(), "no users file: nobody can connect until it exists");
                    }
                    Err(_) => {}
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
        me
    }

    fn reload(&self) -> Result<usize, String> {
        let text = std::fs::read_to_string(&self.path).map_err(|e| e.to_string())?;
        let file: UsersFile = toml::from_str(&text).map_err(|e| e.to_string())?;
        let mut seen = std::collections::HashSet::new();
        for u in &file.user {
            if u.key.len() < MIN_KEY_LEN {
                return Err(format!("user {}: key is too short (make one with: MarketHub-server.exe --new-key)", u.name));
            }
            if !seen.insert(u.key.as_str()) {
                return Err(format!("user {}: same key as another user", u.name));
            }
        }
        let mut map = self.by_key.write();
        let mut next = HashMap::new();
        for cfg in file.user {
            let user = match map.remove(&cfg.key) {
                Some(u) => {
                    *u.cfg.write() = cfg.clone();
                    u
                }
                None => User::new(cfg.clone()),
            };
            next.insert(cfg.key, user);
        }
        for (_, gone) in map.drain() {
            tracing::info!(user = %gone.name(), "user removed; disconnecting them");
            gone.kick.send_modify(|v| *v += 1);
        }
        let n = next.len();
        *map = next;
        Ok(n)
    }

    pub fn keys_required(&self) -> bool {
        self.required
    }

    /// Takes one of the user's connection slots: the key's user when a known key
    /// is given; otherwise, when keys are optional, the guest for this IP.
    pub fn connect(&self, key: Option<&str>, ip: IpAddr) -> Result<Conn, (StatusCode, &'static str)> {
        let key = key.filter(|k| !k.is_empty());
        let keyed = key.and_then(|k| self.by_key.read().get(k).cloned());
        let user = match (keyed, key, self.required) {
            (Some(u), _, _) => u,
            (None, Some(_), true) => return Err((StatusCode::UNAUTHORIZED, "unknown API key")),
            (None, None, true) => return Err((StatusCode::UNAUTHORIZED, "API key required (?key=...)")),
            // Keys optional: an unknown key is treated like none.
            (None, _, false) => self.guest(ip),
        };
        let max = user.cfg.read().max_connections;
        user.conns
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |c| (c < max).then_some(c + 1))
            .map_err(|_| (StatusCode::TOO_MANY_REQUESTS, "too many open connections from here; close some tabs"))?;
        Ok(Conn(user))
    }

    fn guest(&self, ip: IpAddr) -> Arc<User> {
        let mut guests = self.guests.lock();
        let entry = guests.entry(ip).or_insert_with(|| {
            let g = &self.guest_limits;
            let cfg = UserCfg {
                name: "guest".into(),
                key: String::new(),
                max_connections: g.max_connections,
                max_topics: g.max_topics,
                history_days_per_minute: g.history_days_per_minute,
                max_updates_per_sec: g.max_updates_per_sec,
            };
            (User::new(cfg), Instant::now())
        });
        entry.1 = Instant::now();
        entry.0.clone()
    }

    /// Drops guests with no open connection that haven't been seen for a while.
    fn forget_idle_guests(&self) {
        self.guests.lock().retain(|_, (u, seen)| u.conns.load(Ordering::Relaxed) > 0 || seen.elapsed() < GUEST_FORGET);
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let map = self.by_key.read();
        let online: HashMap<String, usize> =
            map.values().filter(|u| u.conns.load(Ordering::Relaxed) > 0).map(|u| (u.name(), u.conns.load(Ordering::Relaxed))).collect();
        let guests = self.guests.lock();
        let guest_conns: usize = guests.values().map(|(u, _)| u.conns.load(Ordering::Relaxed)).sum();
        serde_json::json!({
            "keys_required": self.required,
            "users": map.len(),
            "online": online,
            "guest_ips": guests.values().filter(|(u, _)| u.conns.load(Ordering::Relaxed) > 0).count(),
            "guest_connections": guest_conns,
        })
    }
}

/// A fresh random key for users.toml.
pub fn new_key() -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    let body: String = (0..32).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect();
    format!("mh_{body}")
}
