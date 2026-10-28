//! Nubra history (REST `POST charts/timeseries`). History only, no WebSocket.
//!
//! ## Login (ported from QuantDesk's `brokers/adapters/nubra.rs`)
//! Every route ends with `/verifypin` (auth token + MPIN → session token).
//! What differs is how the auth token is obtained:
//!   * **Saved device login (default):** an SMS OTP ONCE per computer
//!     (`/sendphoneotp` → `/verifyphoneotp`) returns a long-lived auth token.
//!     It is kept DPAPI-encrypted with the device id it was issued to, and every
//!     later login is just `/verifypin` with it and the MPIN. When Nubra stops
//!     accepting it, the app asks for one new OTP.
//!   * **TOTP (optional):** if a TOTP secret is saved, `/totp/login` with a code
//!     generated from Nubra's own clock (a drifted PC clock makes valid secrets fail).
//!
//! Failed logins are throttled (≥ 60 s apart) and stop after 3 in a row, so a
//! wrong credential can never lock the account. Saving new credentials in the
//! app resets this and logs in again straight away.
//!
//! Nubra names instruments by symbol. The symbol is built by rule
//! ([`nubra_symbol`], QuantDesk's naming) from what the hub's own compact
//! instrument lists say a token is, so Nubra's full instrument list (~89k
//! contracts) is never downloaded or held in RAM. Prices are paise ÷ 100.

use super::{FetchError, HistoryBroker};
use crate::canonical::{Canonical, Market};
use crate::creds::CredStore;
use crate::instruments::{Described, Instruments};
use crate::model::{Candle, Interval, PieceKey};
use crate::ratelimit::{LimitSpec, Limiter};
use crate::secure_store;
use async_trait::async_trait;
use chrono::{Datelike, Duration as CDur, Local, NaiveDate, NaiveTime, TimeZone, Utc};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;

const LOGIN_MIN_GAP: Duration = Duration::from_secs(60);
const MAX_LOGIN_FAILURES: u32 = 3;
/// Headers Nubra's own web client sends (QuantDesk sends them too).
const APP_VERSION: &str = "0.4.2";
const DEVICE_OS: &str = "web";
const PENDING_OTP_FOR: Duration = Duration::from_secs(600);
/// A saved day session is reused across restarts only within this age.
const SESSION_REUSE_FOR: i64 = 20 * 3600 * 1000;

/// What a verified OTP leaves behind (DPAPI-encrypted on disk).
#[derive(Clone, Default, Serialize, Deserialize)]
struct DeviceLogin {
    device_id: String,
    auth_token: String,
    saved_at_ms: i64,
    #[serde(default)]
    session_token: String,
    #[serde(default)]
    session_at_ms: i64,
}

struct Session {
    token: Option<String>,
    device_id: String,
    last_login: Option<Instant>,
    failures: u32,
}

struct NErr {
    status: u16,
    msg: String,
}

impl NErr {
    fn is_auth(&self) -> bool {
        matches!(self.status, 400 | 401 | 403 | 440)
    }
}

pub struct Nubra {
    client: reqwest::Client,
    base: String,
    creds: Arc<CredStore>,
    device_file: PathBuf,
    has_device_login: AtomicBool,
    limiter: Arc<Limiter>,
    session: AsyncMutex<Session>,
    pending_otp: Mutex<Option<(String, String, Instant)>>, // (temp_token, device_id, sent_at)
    /// The hub's own instrument lists: what a token is, so Nubra's symbol can be built by rule.
    instruments: Option<Arc<Instruments>>,
    /// One-line status for the app window.
    pub status: RwLock<String>,
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

pub fn masked(phone: &str) -> String {
    format!("••••••{}", &phone[phone.len().saturating_sub(4)..])
}

impl Nubra {
    pub fn new(
        base: String,
        creds: Arc<CredStore>,
        device_file: PathBuf,
        limits: &LimitSpec,
        instruments: Option<Arc<Instruments>>,
    ) -> Arc<Self> {
        let me = Arc::new(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .pool_max_idle_per_host(4)
                .build()
                .expect("http client"),
            base: base.trim_end_matches('/').to_string(),
            creds,
            has_device_login: AtomicBool::new(false),
            device_file,
            limiter: Limiter::new("nubra.history", limits),
            session: AsyncMutex::new(Session { token: None, device_id: String::new(), last_login: None, failures: 0 }),
            pending_otp: Mutex::new(None),
            instruments,
            status: RwLock::new("not logged in".into()),
        });
        me.has_device_login.store(me.load_device().is_some(), Ordering::Relaxed);
        me.refresh_status_idle();

        // Nubra's own credentials changed in the app → forget the session and log in again.
        let watcher = me.clone();
        tokio::spawn(async move {
            const KEYS: [&str; 3] = ["NUBRA_PHONE", "NUBRA_MPIN", "NUBRA_TOTP_SECRET"];
            let mut rx = watcher.creds.subscribe();
            let mut before = watcher.creds.snapshot(&KEYS);
            while rx.changed().await.is_ok() {
                let now = watcher.creds.snapshot(&KEYS);
                if now == before {
                    continue;
                }
                before = now;
                let mut s = watcher.session.lock().await;
                *s = Session { token: None, device_id: String::new(), last_login: None, failures: 0 };
                drop(s);
                watcher.refresh_status_idle();
                tracing::info!("nubra credentials changed; will log in again");
            }
        });
        me
    }

    fn phone(&self) -> Option<String> {
        let digits: String = self.creds.get("NUBRA_PHONE")?.chars().filter(|c| c.is_ascii_digit()).collect();
        (digits.len() >= 10).then(|| digits[digits.len() - 10..].to_string())
    }

    /// Stable per phone, so every launch looks like the same device to Nubra.
    fn device_id_for(phone: &str) -> String {
        format!("markethub-{phone}")
    }

    fn set_status(&self, s: impl Into<String>) {
        *self.status.write() = s.into();
    }

    fn refresh_status_idle(&self) {
        let s = if self.phone().is_none() || !self.creds.is_set("NUBRA_MPIN") {
            "enter mobile number and MPIN".to_string()
        } else if self.creds.is_set("NUBRA_TOTP_SECRET") {
            "ready (TOTP login)".to_string()
        } else if self.has_device_login.load(Ordering::Relaxed) {
            "ready (saved device login, MPIN only)".to_string()
        } else {
            "needs a one-time OTP — press Send OTP".to_string()
        };
        self.set_status(s);
    }

    /// Whether a login can happen without the user (used to route history elsewhere if not).
    pub fn ready(&self) -> bool {
        self.phone().is_some()
            && self.creds.is_set("NUBRA_MPIN")
            && (self.creds.is_set("NUBRA_TOTP_SECRET") || self.has_device_login.load(Ordering::Relaxed))
    }

    // ---------- device login file (DPAPI) ----------

    fn load_device(&self) -> Option<DeviceLogin> {
        let sealed = std::fs::read(&self.device_file).ok()?;
        let plain = secure_store::unprotect(&sealed).ok()?;
        serde_json::from_slice::<DeviceLogin>(&plain).ok().filter(|d| !d.auth_token.is_empty())
    }

    fn save_device(&self, d: &DeviceLogin) {
        let Ok(plain) = serde_json::to_vec(d) else { return };
        let Ok(sealed) = secure_store::protect(&plain) else { return };
        if let Some(dir) = self.device_file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.device_file.with_extension("bin.tmp");
        if std::fs::write(&tmp, sealed).is_ok() && std::fs::rename(&tmp, &self.device_file).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        self.has_device_login.store(true, Ordering::Relaxed);
    }

    fn clear_device(&self) {
        let _ = std::fs::remove_file(&self.device_file);
        self.has_device_login.store(false, Ordering::Relaxed);
    }

    // ---------- HTTP ----------

    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        device_id: &str,
        bearer: Option<&str>,
        temp_token: Option<&str>,
        body: Option<Value>,
    ) -> Result<Value, NErr> {
        let mut req = self
            .client
            .request(method, format!("{}{path}", self.base))
            .header("Accept", "application/json")
            .header("x-device-id", device_id)
            .header("x-app-version", APP_VERSION)
            .header("x-device-os", DEVICE_OS);
        if let Some(t) = bearer {
            req = req.bearer_auth(t);
        }
        if let Some(t) = temp_token {
            req = req.header("x-temp-token", t);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.map_err(|e| NErr { status: 0, msg: format!("network: {e}") })?;
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if status >= 400 {
            let msg = ["error", "message", "msg"]
                .iter()
                .find_map(|k| v[*k].as_str())
                .map(str::to_string)
                .unwrap_or_else(|| text.chars().take(160).collect());
            return Err(NErr { status, msg: format!("HTTP {status}: {msg}") });
        }
        Ok(v)
    }

    /// Nubra's own clock (Date header), so a drifted PC clock doesn't produce stale TOTPs.
    async fn server_secs(&self) -> u64 {
        if let Ok(r) = self.client.head(format!("{}/", self.base)).send().await {
            if let Some(d) = r.headers().get(reqwest::header::DATE).and_then(|v| v.to_str().ok()) {
                if let Ok(t) = chrono::DateTime::parse_from_rfc2822(d) {
                    return t.timestamp().max(0) as u64;
                }
            }
        }
        Utc::now().timestamp().max(0) as u64
    }

    async fn finish_with_pin(&self, device_id: &str, auth_token: &str) -> Result<String, NErr> {
        let mpin = self.creds.get("NUBRA_MPIN").ok_or(NErr { status: 400, msg: "MPIN not set".into() })?;
        let v = self
            .call(reqwest::Method::POST, "/verifypin", device_id, Some(auth_token), None, Some(json!({"pin": mpin})))
            .await?;
        v["session_token"]
            .as_str()
            .or_else(|| v["data"]["token"].as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .ok_or(NErr { status: 400, msg: "MPIN check returned no session token".into() })
    }

    // ---------- login ----------

    /// One login attempt. Returns (session token, device id).
    async fn login_once(&self) -> Result<(String, String), FetchError> {
        let phone = self.phone().ok_or_else(|| FetchError::Auth("Nubra mobile number not set".into()))?;
        if !self.creds.is_set("NUBRA_MPIN") {
            return Err(FetchError::Auth("Nubra MPIN not set".into()));
        }

        if let Some(secret) = self.creds.get("NUBRA_TOTP_SECRET") {
            let device = Self::device_id_for(&phone);
            let bytes = totp_rs::Secret::Encoded(secret.replace(' ', "").to_uppercase())
                .to_bytes()
                .map_err(|_| FetchError::Auth("Nubra TOTP secret is not valid (should be letters A–Z and digits 2–7)".into()))?;
            let totp = totp_rs::TOTP::new_unchecked(totp_rs::Algorithm::SHA1, 6, 1, 30, bytes);
            // Retry once only when the code was made at the edge of its 30 s window.
            for attempt in 0..2 {
                let now = self.server_secs().await;
                let code: u64 = totp.generate(now).parse().unwrap_or(0);
                let res = self
                    .call(reqwest::Method::POST, "/totp/login", &device, None, None, Some(json!({"phone": phone, "totp": code, "otp": ""})))
                    .await;
                let auth = match res {
                    Ok(v) => v["auth_token"].as_str().unwrap_or("").to_string(),
                    Err(e) if attempt == 0 && now % 30 >= 27 => {
                        tokio::time::sleep(Duration::from_secs(30 - now % 30 + 1)).await;
                        let _ = e;
                        continue;
                    }
                    Err(e) => return Err(FetchError::Auth(format!("TOTP login refused ({}) — check the TOTP secret", e.msg))),
                };
                if auth.is_empty() {
                    return Err(FetchError::Auth("TOTP login returned no auth token".into()));
                }
                return self
                    .finish_with_pin(&device, &auth)
                    .await
                    .map(|t| (t, device.clone()))
                    .map_err(|e| FetchError::Auth(format!("MPIN refused: {}", e.msg)));
            }
            return Err(FetchError::Auth("TOTP login failed".into()));
        }

        // Saved device login: MPIN only.
        let Some(saved) = self.load_device() else {
            return Err(FetchError::Auth(format!(
                "Nubra needs a one-time OTP to {} — Brokers → Nubra → Send OTP in the app, or run \"Nubra Login.bat\" on the server",
                masked(&phone)
            )));
        };
        // Reuse today's session from a previous run if it is recent.
        if !saved.session_token.is_empty() && now_ms() - saved.session_at_ms < SESSION_REUSE_FOR {
            return Ok((saved.session_token.clone(), saved.device_id.clone()));
        }
        match self.finish_with_pin(&saved.device_id, &saved.auth_token).await {
            Ok(tok) => {
                self.save_device(&DeviceLogin { session_token: tok.clone(), session_at_ms: now_ms(), ..saved.clone() });
                Ok((tok, saved.device_id))
            }
            Err(e) if e.is_auth() && e.msg.to_ascii_lowercase().contains("pin") => {
                Err(FetchError::Auth(format!("MPIN refused ({}) — check the MPIN", e.msg)))
            }
            Err(e) if e.is_auth() => {
                // Nubra ended the device login: forget it so the app asks for a new OTP.
                self.clear_device();
                Err(FetchError::Auth(format!("Nubra no longer accepts the saved login ({}) — send a new OTP", e.msg)))
            }
            Err(e) => Err(FetchError::Other(e.msg)),
        }
    }

    async fn login(&self, s: &mut Session) -> Result<(), FetchError> {
        if s.failures >= MAX_LOGIN_FAILURES {
            return Err(FetchError::Auth("login failed 3 times; stopped to protect the account — fix credentials in the app".into()));
        }
        if let Some(t) = s.last_login {
            if t.elapsed() < LOGIN_MIN_GAP {
                return Err(FetchError::Other("waiting before the next login attempt".into()));
            }
        }
        s.last_login = Some(Instant::now());
        self.set_status("logging in…");
        match self.login_once().await {
            Ok((tok, dev)) => {
                s.token = Some(tok);
                s.device_id = dev;
                s.failures = 0;
                self.set_status("logged in");
                tracing::info!("nubra logged in");
                Ok(())
            }
            Err(e) => {
                if matches!(e, FetchError::Auth(_)) {
                    s.failures += 1;
                }
                let msg = match &e {
                    FetchError::Auth(m) | FetchError::Other(m) => m.clone(),
                    FetchError::RateLimited(_) => "rate limited".into(),
                };
                self.set_status(format!("login failed: {msg}"));
                tracing::warn!(error = %msg, "nubra login failed");
                Err(e)
            }
        }
    }

    async fn session(&self) -> Result<(String, String), FetchError> {
        let mut s = self.session.lock().await;
        if s.token.is_none() {
            self.login(&mut s).await?;
        }
        Ok((s.token.clone().unwrap(), s.device_id.clone()))
    }

    async fn drop_session(&self) {
        self.session.lock().await.token = None;
        if let Some(mut d) = self.load_device() {
            d.session_token.clear();
            self.save_device(&d);
        }
    }

    // ---------- one-time OTP (called from the app window) ----------

    /// Step 1: Nubra texts a code. Returns the masked number it went to.
    pub async fn send_otp(&self) -> Result<String, String> {
        let phone = self.phone().ok_or("save the Nubra mobile number first")?;
        let device = Self::device_id_for(&phone);
        let first = self
            .call(reqwest::Method::POST, "/sendphoneotp", &device, None, None, Some(json!({"phone": phone, "flow": "", "skip_totp": false})))
            .await
            .map_err(|e| e.msg)?;
        let mut temp = first["temp_token"].as_str().unwrap_or("").to_string();
        // Accounts with TOTP answer VERIFY_TOTP; asking again with skip_totp sends the SMS.
        if first["next"].as_str().map(|n| n.eq_ignore_ascii_case("VERIFY_TOTP")).unwrap_or(false) {
            let second = self
                .call(reqwest::Method::POST, "/sendphoneotp", &device, None, Some(&temp), Some(json!({"phone": phone, "flow": "", "skip_totp": true})))
                .await
                .map_err(|e| e.msg)?;
            temp = second["temp_token"].as_str().unwrap_or("").to_string();
        }
        if temp.is_empty() {
            return Err("Nubra did not start the OTP login — try again".into());
        }
        *self.pending_otp.lock() = Some((temp, device, Instant::now()));
        self.set_status(format!("OTP sent to {} — enter it and press Verify", masked(&phone)));
        Ok(masked(&phone))
    }

    /// Step 2: the texted code, then the MPIN. The device login is saved only
    /// when both are accepted, so a wrong MPIN never leaves a half-made login.
    pub async fn verify_otp(&self, otp: &str) -> Result<(), String> {
        let otp: String = otp.chars().filter(|c| !c.is_whitespace()).collect();
        if otp.len() < 4 || otp.len() > 8 || !otp.chars().all(|c| c.is_ascii_digit()) {
            return Err("enter the code Nubra texted (digits only)".into());
        }
        let phone = self.phone().ok_or("save the Nubra mobile number first")?;
        let (temp, device) = match &*self.pending_otp.lock() {
            Some((t, d, at)) if at.elapsed() < PENDING_OTP_FOR => (t.clone(), d.clone()),
            _ => return Err("that code has expired — press Send OTP again".into()),
        };
        let v = self
            .call(reqwest::Method::POST, "/verifyphoneotp", &device, None, Some(&temp), Some(json!({"phone": phone, "otp": otp})))
            .await
            .map_err(|e| e.msg)?;
        let auth = v["auth_token"].as_str().filter(|s| !s.is_empty()).ok_or("Nubra accepted the code but returned no login token")?;
        let session = self.finish_with_pin(&device, auth).await.map_err(|e| format!("MPIN refused: {}", e.msg))?;

        self.save_device(&DeviceLogin {
            device_id: device.clone(),
            auth_token: auth.to_string(),
            saved_at_ms: now_ms(),
            session_token: session.clone(),
            session_at_ms: now_ms(),
        });
        *self.pending_otp.lock() = None;
        let mut s = self.session.lock().await;
        *s = Session { token: Some(session), device_id: device, last_login: Some(Instant::now()), failures: 0 };
        self.set_status("logged in (device login saved — MPIN only from now on)");
        tracing::info!("nubra device login saved; future logins need only the MPIN");
        Ok(())
    }

    /// Logs in now (or reuses the session) and reports the result. For the app's "Test login" button.
    pub async fn test_login(&self) -> Result<(), String> {
        let mut s = self.session.lock().await;
        s.failures = 0;
        s.last_login = None;
        s.token = None;
        self.login(&mut s).await.map_err(|e| match e {
            FetchError::Auth(m) | FetchError::Other(m) => m,
            FetchError::RateLimited(_) => "rate limited".into(),
        })
    }

    // ---------- instruments ----------

    fn exchange(seg: &str) -> Option<(&'static str, bool)> {
        Some(match seg {
            "NSE_EQ" | "NSE_IDX" => ("NSE", false),
            "NSE_FO" => ("NSE", true),
            "BSE_EQ" | "BSE_IDX" => ("BSE", false),
            "BSE_FO" => ("BSE", true),
            "MCX_FO" => ("MCX", true),
            _ => return None,
        })
    }

    fn interval(i: Interval) -> &'static str {
        match i {
            Interval::M1 => "1m",
            Interval::M3 => "3m",
            Interval::M5 => "5m",
            Interval::M15 => "15m",
            Interval::M30 => "30m",
            Interval::M60 => "1h",
            Interval::D1 => "1d",
        }
    }

    /// Nubra's (symbol, type) for a piece, built by rule from what the hub's
    /// own instrument lists say the token is (see [`nubra_symbol`]).
    fn target(&self, key: &PieceKey) -> Result<(String, &'static str), FetchError> {
        let inst = self.instruments.as_ref().ok_or_else(|| FetchError::Other("instrument lists are not loaded".into()))?;
        let d = inst.describe(&key.id.0).map_err(FetchError::Other)?;
        nubra_symbol(&d).ok_or_else(|| FetchError::Other(format!("{}: no Nubra symbol for {}", key.id.0, d.canonical)))
    }
}

/// Nubra's symbol and type for an instrument (QuantDesk `market::identity`,
/// probed 2026-09-23 and 2026-09-25):
///
/// ```text
/// index / stock        NIFTY / RELIANCE                       INDEX / STOCK
/// NSE/BSE future       NIFTY26SEPFUT                          FUT
/// NSE/BSE option       weekly  NIFTY2691523250CE              OPT
///                      monthly NIFTY26SEP23250CE  (last expiry of its month)
/// MCX future           FUT_CRUDEOIL_20261019                  FUT
/// MCX option           OPT_CRUDEOIL_20261117_CE_745000        OPT   (strike in paise)
/// ```
///
/// Weekly options pack the month as one character (1–9, then O, N, D) so it
/// can't be confused with the day after it. The wrong form returns an empty
/// series rather than an error.
pub fn nubra_symbol(d: &Described) -> Option<(String, &'static str)> {
    const MONTHS: [&str; 12] = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    let name = d.canonical.name_upper();
    let yy = |e: NaiveDate| format!("{:02}", e.year() % 100);
    let mon = |e: NaiveDate| MONTHS[e.month0() as usize];
    let compact = |e: NaiveDate| e.format("%Y%m%d").to_string();
    Some(match &d.canonical {
        Canonical::Underlying { .. } => (name, if d.index { "INDEX" } else { "STOCK" }),
        Canonical::Future { market: Market::Mcx, expiry, .. } => (format!("FUT_{name}_{}", compact(*expiry)), "FUT"),
        Canonical::Future { expiry, .. } => (format!("{name}{}{}FUT", yy(*expiry), mon(*expiry)), "FUT"),
        Canonical::Option { market: Market::Mcx, expiry, strike, right, .. } => {
            (format!("OPT_{name}_{}_{}_{}", compact(*expiry), right.as_str(), (strike * 100.0).round() as i64), "OPT")
        }
        Canonical::Option { expiry, strike, right, .. } => {
            // Whole-number strikes in NSE's own symbols; a fractional one has no form here.
            if strike.fract().abs() > 1e-9 {
                return None;
            }
            let strike = strike.round() as i64;
            let date = if d.monthly {
                format!("{}{}", yy(*expiry), mon(*expiry))
            } else {
                let m = match expiry.month() {
                    10 => "O".to_string(),
                    11 => "N".to_string(),
                    12 => "D".to_string(),
                    m => m.to_string(),
                };
                format!("{}{m}{:02}", yy(*expiry), expiry.day())
            };
            (format!("{name}{date}{strike}{}", right.as_str()), "OPT")
        }
    })
}

#[async_trait]
impl HistoryBroker for Nubra {
    fn name(&self) -> &'static str {
        "nubra"
    }
    fn limiter(&self) -> Arc<Limiter> {
        self.limiter.clone()
    }
    fn supports(&self, key: &PieceKey) -> bool {
        let today = Local::now().date_naive();
        // Docs: intraday intervals → last 3 months; daily and above → up to 10 years.
        let max_days = if key.interval == Interval::D1 { 3650 } else { 90 };
        self.ready()
            && Self::exchange(key.id.segment()).is_some()
            && key.day <= today
            && (today - key.day).num_days() <= max_days
    }

    async fn fetch(&self, key: &PieceKey) -> Result<Vec<Candle>, FetchError> {
        self.fetch_batch(std::slice::from_ref(key)).await.pop().unwrap_or_else(|| Ok(Vec::new()))
    }

    /// Up to 8 instruments in one query (QuantDesk `MAX_LEGS_PER_QUERY`: more
    /// than 8 don't error, the surplus just comes back missing).
    fn max_batch(&self) -> usize {
        8
    }

    /// Futures and options of one exchange, day and interval share a query.
    /// Indices and stocks go alone: one unknown name (India VIX is "invalid
    /// index") fails the whole query, while an unknown option is just empty.
    fn batch_group(&self, key: &PieceKey) -> Option<String> {
        let (exch, _) = Self::exchange(key.id.segment())?;
        let (_, kind) = self.target(key).ok()?;
        matches!(kind, "OPT" | "FUT").then(|| format!("{exch}|{kind}|{}|{}", key.day, Self::interval(key.interval)))
    }

    /// Calendar days one query may cover for one instrument. QuantDesk asks
    /// Nubra for up to 89 days of 1-minute bars in one query; shorter spans
    /// here keep a reply to a few MB (MCX trades ~900 minutes a day).
    fn max_span_days(&self, interval: Interval) -> i64 {
        match interval {
            Interval::M1 => 15,
            Interval::M3 | Interval::M5 => 31,
            _ => 92,
        }
    }

    /// One query for the whole batch: one day of several symbols, or several
    /// days of one symbol (the dispatcher never mixes the two, so the query
    /// asks for nothing that wasn't wanted). The reply is split by IST day.
    async fn fetch_batch(&self, keys: &[PieceKey]) -> Vec<Result<Vec<Candle>, FetchError>> {
        let targets: Vec<Result<(String, &'static str), FetchError>> = keys.iter().map(|k| self.target(k)).collect();
        let mut symbols: Vec<String> = targets.iter().filter_map(|t| t.as_ref().ok().map(|(s, _)| s.clone())).collect();
        symbols.sort();
        symbols.dedup();
        let (Some(first), Some(kind)) = (keys.first(), targets.iter().find_map(|t| t.as_ref().ok().map(|(_, k)| *k))) else {
            return targets.into_iter().map(|t| t.map(|_| Vec::new())).collect();
        };
        let (exch, _) = Self::exchange(first.id.segment()).unwrap();
        let from = keys.iter().map(|k| k.day).min().unwrap_or(first.day);
        let to = keys.iter().map(|k| k.day).max().unwrap_or(first.day);
        let reply = self.timeseries(exch, kind, &symbols, from, to, first.interval).await;
        let mut by_symbol: HashMap<String, BTreeMap<NaiveDate, Vec<Candle>>> = HashMap::new();
        keys.iter()
            .zip(targets)
            .map(|(key, t)| {
                let (symbol, _) = t?;
                let v = reply.as_ref().map_err(Clone::clone)?;
                let days = by_symbol.entry(symbol).or_insert_with_key(|s| parse_candles(v, s));
                Ok(days.remove(&key.day).unwrap_or_default())
            })
            .collect()
    }
}

impl Nubra {
    /// One `charts/multistrike` request: every listed strike's call and put open interest at each
    /// query's instant, for every expiry it names, in one call (QuantDesk
    /// `nubra_strike_oi::multistrike_oi`, the request nubra.io's own OI chart sends). Counted
    /// against the same limiter as candle history, so the OI profile never pushes Nubra past its
    /// published limit. Body and answer shapes: see `crate::oi_profile`.
    pub async fn multistrike(&self, body: &Value) -> Result<Value, String> {
        let mut permit = None;
        for _ in 0..40 {
            match self.limiter.try_acquire() {
                Ok(p) => {
                    permit = Some(p);
                    break;
                }
                Err(wait) => tokio::time::sleep(wait.max(Duration::from_millis(50))).await,
            }
        }
        let _permit = permit.ok_or("nubra is busy; the OI profile will try again")?;
        let (token, device) = self.session().await.map_err(|e| match e {
            FetchError::Auth(m) | FetchError::Other(m) => format!("nubra: {m}"),
            FetchError::RateLimited(_) => "nubra is busy; the OI profile will try again".into(),
        })?;
        let resp = self
            .client
            .post(format!("{}/charts/multistrike?chart=Open_Interest_Change", self.base))
            .header("x-device-id", &device)
            .header("x-app-version", APP_VERSION)
            .header("x-device-os", DEVICE_OS)
            .header("Cookie", format!("authToken={token}; sessionToken={token}; deviceId={device}"))
            .header("Origin", "https://nubra.io")
            .header("Referer", "https://nubra.io/")
            .bearer_auth(&token)
            .json(body)
            .send()
            .await
            .map_err(|e| format!("nubra: {e}"))?;
        let status = resp.status().as_u16();
        if status == 429 {
            self.limiter.penalize(None);
            return Err("nubra rate-limited the OI profile; it will try again".into());
        }
        if status == 440 || status == 401 {
            self.drop_session().await;
            return Err("nubra session expired; logging in again".into());
        }
        let text = resp.text().await.map_err(|e| format!("nubra: {e}"))?;
        if !(200..300).contains(&status) {
            return Err(format!("nubra HTTP {status}: {}", text.chars().take(200).collect::<String>()));
        }
        self.limiter.success();
        serde_json::from_str(&text).map_err(|e| format!("nubra: {e}"))
    }

    /// One `charts/timeseries` query: these symbols, whole IST days `from` to `to`.
    async fn timeseries(&self, exch: &str, kind: &str, symbols: &[String], from: NaiveDate, to: NaiveDate, interval: Interval) -> Result<Value, FetchError> {
        let (token, device) = self.session().await?;
        // Whole IST calendar days, in UTC as Nubra expects (IST midnight is 18:30Z the day before).
        let midnight = |d: NaiveDate| crate::clock::ist().from_local_datetime(&d.and_time(NaiveTime::MIN)).single().expect("IST has no gaps");
        let start = midnight(from).with_timezone(&Utc);
        let end = (midnight(to) + CDur::days(1) - CDur::seconds(1)).with_timezone(&Utc);
        let body = json!({"query": [{
            "exchange": exch, "type": kind, "values": symbols,
            "fields": ["open", "high", "low", "close", "cumulative_volume"],
            "startDate": start.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            "endDate": end.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            "interval": Self::interval(interval), "intraDay": false, "realTime": false,
        }]});

        let resp = self
            .client
            .post(format!("{}/charts/timeseries", self.base))
            .header("x-device-id", &device)
            .header("x-app-version", APP_VERSION)
            .header("x-device-os", DEVICE_OS)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .map_err(|e| FetchError::Other(e.to_string()))?;
        let status = resp.status().as_u16();
        if status == 429 {
            let retry = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .map(Duration::from_secs);
            return Err(FetchError::RateLimited(retry));
        }
        if status == 440 || status == 401 {
            self.drop_session().await;
            return Err(FetchError::Other("nubra session expired; logging in again".into()));
        }
        let v: Value = resp.json().await.map_err(|e| FetchError::Other(e.to_string()))?;
        if !(200..300).contains(&status) {
            return Err(FetchError::Other(format!("HTTP {status}: {}", v.to_string().chars().take(200).collect::<String>())));
        }
        Ok(v)
    }
}

/// `result[0].values = [{SYMBOL: {field: [{ts(ns), v}]}}]` → candles by IST
/// day. Per-bar volume is the difference of cumulative volume, which starts
/// again from 0 each day.
fn parse_candles(v: &Value, symbol: &str) -> BTreeMap<NaiveDate, Vec<Candle>> {
    let mut bars: BTreeMap<i64, [f64; 5]> = BTreeMap::new();
    let Some(groups) = v["result"][0]["values"].as_array() else { return BTreeMap::new() };
    for g in groups {
        let Some(fields) = g.get(symbol) else { continue };
        for (i, f) in ["open", "high", "low", "close", "cumulative_volume"].iter().enumerate() {
            for p in fields[*f].as_array().into_iter().flatten() {
                let (Some(ts), Some(val)) = (p["ts"].as_i64(), p["v"].as_f64()) else { continue };
                let bar = bars.entry(ts / 1_000_000_000).or_insert([f64::NAN; 5]);
                bar[i] = if i < 4 { val / 100.0 } else { val };
            }
        }
    }
    let mut out: BTreeMap<NaiveDate, Vec<Candle>> = BTreeMap::new();
    let mut prev_cum = 0.0;
    for (t, b) in bars.into_iter().filter(|(_, b)| !b[3].is_nan()) {
        let Some(day) = crate::clock::ist().timestamp_opt(t, 0).single().map(|d| d.date_naive()) else { continue };
        let candles = out.entry(day).or_default();
        if candles.is_empty() {
            prev_cum = 0.0; // the day's first bar
        }
        let cum = if b[4].is_nan() { prev_cum } else { b[4] };
        let vol = (cum - prev_cum).max(0.0);
        prev_cum = cum;
        let pick = |x: f64| if x.is_nan() { b[3] } else { x };
        candles.push((t, pick(b[0]), pick(b[1]), pick(b[2]), b[3], vol));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same symbols QuantDesk's naming tests expect (market::identity, nubra_candles).
    #[test]
    fn symbols_by_rule_match_quantdesk() {
        let d = |c: &str, monthly: bool, index: bool| Described { canonical: Canonical::parse(c).unwrap(), index, monthly };
        let sym = |c: &str, monthly: bool| nubra_symbol(&d(c, monthly, false)).unwrap();
        assert_eq!(sym("nse:nifty:2026-09-15:23250:CE", false), ("NIFTY2691523250CE".into(), "OPT"), "weekly");
        assert_eq!(sym("nse:nifty:2026-09-29:23250:CE", true), ("NIFTY26SEP23250CE".into(), "OPT"), "monthly");
        assert_eq!(sym("bse:sensex:2026-12-03:66200:PE", false), ("SENSEX26D0366200PE".into(), "OPT"), "December packs as D");
        assert_eq!(sym("nse:nifty:2026-09-29:FUT", true), ("NIFTY26SEPFUT".into(), "FUT"));
        assert_eq!(sym("mcx:crudeoil:2026-10-19:FUT", true), ("FUT_CRUDEOIL_20261019".into(), "FUT"));
        assert_eq!(sym("mcx:crudeoil:2026-11-17:7450:CE", true), ("OPT_CRUDEOIL_20261117_CE_745000".into(), "OPT"));
        assert_eq!(nubra_symbol(&d("nse:nifty", false, true)).unwrap(), ("NIFTY".into(), "INDEX"));
        assert_eq!(nubra_symbol(&d("nse:reliance", false, false)).unwrap(), ("RELIANCE".into(), "STOCK"));
        assert!(nubra_symbol(&d("nse:wipro:2026-11-26:207.5:CE", true, false)).is_none(), "no form for a fractional strike");
    }

    /// Shape from Nubra's docs (charts/timeseries response), two bars.
    #[test]
    fn parses_timeseries_response() {
        let v = json!({"message": "charts", "result": [{"exchange": "NSE", "type": "STOCK", "values": [
            {"ASIANPAINT": {
                "open":  [{"ts": 1749699900000000000i64, "v": 223900}, {"ts": 1749699960000000000i64, "v": 225000}],
                "high":  [{"ts": 1749699900000000000i64, "v": 225500}, {"ts": 1749699960000000000i64, "v": 225300}],
                "low":   [{"ts": 1749699900000000000i64, "v": 223800}, {"ts": 1749699960000000000i64, "v": 224900}],
                "close": [{"ts": 1749699900000000000i64, "v": 225010}, {"ts": 1749699960000000000i64, "v": 225100}],
                "cumulative_volume": [{"ts": 1749699900000000000i64, "v": 1000}, {"ts": 1749699960000000000i64, "v": 1600}]
            }}
        ]}]});
        let days = parse_candles(&v, "ASIANPAINT");
        let c = &days[&NaiveDate::from_ymd_opt(2025, 6, 12).unwrap()]; // 09:15 IST
        assert_eq!(c.len(), 2);
        assert_eq!(c[0], (1749699900, 2239.0, 2255.0, 2238.0, 2250.1, 1000.0));
        assert_eq!(c[1].5, 600.0);
    }

    /// A multi-day reply is split by IST day, and each day's volume starts from its own 0.
    #[test]
    fn splits_a_multi_day_reply_by_ist_day() {
        let (d1, d2) = (1749699900i64, 1749699900i64 + 86_400); // 09:15 IST on 12 and 13 June
        let pts = |a: i64, b: i64| json!([{"ts": d1 * 1_000_000_000, "v": a}, {"ts": d2 * 1_000_000_000, "v": b}]);
        let v = json!({"result": [{"values": [{"X": {
            "open": pts(100, 200), "high": pts(100, 200), "low": pts(100, 200), "close": pts(100, 200),
            "cumulative_volume": pts(5000, 300)
        }}]}]});
        let days = parse_candles(&v, "X");
        let day = |d: u32| &days[&NaiveDate::from_ymd_opt(2025, 6, d).unwrap()];
        assert_eq!(days.len(), 2);
        assert_eq!(day(12)[0].5, 5000.0);
        assert_eq!(day(13)[0].5, 300.0, "not 300 - 5000 clamped to 0");
        assert_eq!(day(13)[0].4, 2.0);
    }

    #[test]
    fn masks_phone() {
        assert_eq!(masked("9876543210"), "••••••3210");
    }
}
