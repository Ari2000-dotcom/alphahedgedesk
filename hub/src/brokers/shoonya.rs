//! Shoonya live feed (NorenWSAPI, plain JSON). Reconnects and resubscribes
//! everything automatically, and reconnects at once when its credentials are
//! changed in the app. Shoonya sends only changed fields in `tf` updates, so
//! the last known ltp/volume per token is merged in.
//!
//! Login (Shoonya's official headless method): with user id, password, TOTP
//! secret, client id and API secret saved, the feed runs `login_cmd`
//! (shoonya_auto_login.py: headless Chrome on the OAuth page, then GenAcsTok)
//! whenever it has no token or the token is refused, e.g. after the daily
//! expiry. Chrome runs only for those few seconds. Shoonya has no token
//! renewal, so a fresh login is the only way. Without those fields the feed
//! uses an access token pasted in the app.

use crate::creds::CredStore;
use crate::live::{FeedCmd, LiveHub};
use crate::model::{Candle, InstrumentId, Tick};
use futures_util::{SinkExt, StreamExt};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

const WS_URL: &str = "wss://api.shoonya.com/NorenWSAPI/";
const TP_SERIES_URL: &str = "https://api.shoonya.com/NorenWClientAPI/TPSeries";
/// The heartbeat Shoonya's SDK sends (`run_forever(ping_interval=3, ping_payload='{"t":"h"}')`).
const HEARTBEAT: &str = r#"{"t":"h"}"#;
const HEARTBEAT_EVERY: Duration = Duration::from_secs(3);
/// After a drop: retry at once-ish; if drops repeat quickly, back off up to the cap.
const RECONNECT_FIRST: Duration = Duration::from_millis(500);
const RECONNECT_CAP: Duration = Duration::from_secs(15);
/// A session that lasted this long counts as healthy: the next drop retries fast again.
const HEALTHY_SESSION: Duration = Duration::from_secs(60);
/// Fields the login script needs; passed to it as environment variables.
const LOGIN_KEYS: [&str; 5] = ["SHOONYA_UID", "SHOONYA_PASSWORD", "SHOONYA_TOTP_SECRET", "SHOONYA_CLIENT_ID", "SHOONYA_API_SECRET"];
/// Chrome start + page + up to two TOTP attempts fits well inside this.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);

/// True while the headless login runs, so status shows "logging in" rather than "down".
pub static LOGGING_IN: AtomicBool = AtomicBool::new(false);

/// How to run the headless login: program + args, run from `dir`.
#[derive(Clone)]
pub struct LoginCmd {
    pub cmd: Vec<String>,
    pub dir: PathBuf,
}

fn exch(seg: &str) -> Option<&'static str> {
    Some(match seg {
        "MCX_FO" => "MCX",
        "NSE_FO" => "NFO",
        "BSE_FO" => "BFO",
        "NSE_EQ" => "NSE",
        "BSE_EQ" => "BSE",
        _ => return None,
    })
}

fn segment(exch: &str) -> Option<&'static str> {
    Some(match exch {
        "MCX" => "MCX_FO",
        "NFO" => "NSE_FO",
        "BFO" => "BSE_FO",
        "NSE" => "NSE_EQ",
        "BSE" => "BSE_EQ",
        _ => return None,
    })
}

fn key(id: &InstrumentId) -> Option<String> {
    Some(format!("{}|{}", exch(id.segment())?, id.token()))
}

enum End {
    /// Hub shutting down.
    Closed,
    /// Credentials were changed in the app: reconnect immediately.
    CredsChanged,
    /// The broker refused the session (token expired/invalid).
    Rejected,
    /// Network drop or protocol error.
    Dropped(anyhow::Error),
    /// 08:45 IST on a weekday: start the trading day on a fresh login, not on
    /// yesterday's token (which would only be found expired at the open).
    PreMarket,
}

/// Fresh login this long before the 09:15 open.
const PRE_MARKET: (u32, u32) = (8, 45);

/// Shoonya's own fields; saves that touch only other brokers don't disturb the feed.
const OWN_KEYS: [&str; 7] = [
    "SHOONYA_UID",
    "SHOONYA_PASSWORD",
    "SHOONYA_TOTP_SECRET",
    "SHOONYA_CLIENT_ID",
    "SHOONYA_API_SECRET",
    "SHOONYA_ACCESS_TOKEN",
    "SHOONYA_ACTID",
];

/// Resolves when one of Shoonya's own fields changes (true) or the store closes (false).
async fn own_change(ver: &mut watch::Receiver<u64>, creds: &CredStore, before: &[Option<String>]) -> bool {
    loop {
        if ver.changed().await.is_err() {
            return false;
        }
        if creds.snapshot(&OWN_KEYS) != before {
            return true;
        }
    }
}

/// While disconnected, keep tracking subscriptions and wake on new credentials or timeout.
async fn idle(
    rx: &mut mpsc::UnboundedReceiver<FeedCmd>,
    subs: &mut HashSet<InstrumentId>,
    ver: &mut watch::Receiver<u64>,
    creds: &CredStore,
    wait: Option<Duration>,
) -> bool {
    let before = creds.snapshot(&OWN_KEYS);
    let sleep = async {
        match wait {
            Some(d) => tokio::time::sleep(d).await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(FeedCmd::Sub(id)) => { subs.insert(id); }
                Some(FeedCmd::Unsub(id)) => { subs.remove(&id); }
                None => return false,
            },
            r = own_change(ver, creds, &before) => return r,
            _ = &mut sleep => return true,
        }
    }
}

pub async fn run_feed(hub: Arc<LiveHub>, mut rx: mpsc::UnboundedReceiver<FeedCmd>, creds: Arc<CredStore>, login: Option<LoginCmd>) {
    let mut subs: HashSet<InstrumentId> = HashSet::new();
    let mut ver = creds.subscribe();
    let mut auth_backoff = Duration::from_secs(30);
    // Wait before reconnecting after a network drop; doubles while drops come quickly.
    let mut drop_backoff = RECONNECT_FIRST / 2;
    // Token the broker last refused, so it is replaced by a fresh login instead of retried.
    let mut stale: Option<String> = None;
    if login.is_none() && can_auto_login(&creds) {
        tracing::warn!("shoonya login fields are saved but config.toml has no login_cmd; auto-login is off");
    }
    loop {
        let auto = login.is_some() && can_auto_login(&creds);
        let saved = creds.get("SHOONYA_ACCESS_TOKEN").filter(|t| stale.as_ref() != Some(t));
        let Some(uid) = creds.get("SHOONYA_UID").filter(|_| auto || saved.is_some()) else {
            hub.set_feed_status("shoonya", false);
            tracing::info!("shoonya credentials not set; feed waiting for them");
            if !idle(&mut rx, &mut subs, &mut ver, &creds, None).await {
                return;
            }
            continue;
        };
        let mut fresh = false;
        let token = match (saved, &login) {
            (Some(t), _) => t,
            (None, Some(l)) => {
                tracing::info!("shoonya: logging in (headless browser)…");
                LOGGING_IN.store(true, Ordering::Relaxed);
                let result = browser_login(l, &creds).await;
                LOGGING_IN.store(false, Ordering::Relaxed);
                match result {
                    Ok(t) => {
                        fresh = true;
                        t
                    }
                    Err(e) => {
                        let w = auth_backoff;
                        auth_backoff = (auth_backoff * 2).min(Duration::from_secs(600));
                        tracing::warn!(error = %e, retry_in = ?w, "shoonya auto-login failed");
                        hub.set_feed_status("shoonya", false);
                        if !idle(&mut rx, &mut subs, &mut ver, &creds, Some(w)).await {
                            return;
                        }
                        continue;
                    }
                }
            }
            (None, None) => unreachable!("uid is only Some when a token or auto-login exists"),
        };
        let actid = creds.get("SHOONYA_ACTID").unwrap_or_else(|| uid.clone());
        ver.borrow_and_update();

        let started = std::time::Instant::now();
        let wait = match session(&hub, &mut rx, &mut ver, &creds, &uid, &actid, &token, &mut subs).await {
            End::Closed => return,
            End::CredsChanged => {
                tracing::info!("shoonya credentials changed; reconnecting now");
                auth_backoff = Duration::from_secs(30);
                continue;
            }
            End::PreMarket => {
                if auto {
                    tracing::info!("shoonya pre-market: fresh login before the open");
                    stale = Some(token);
                } else {
                    tracing::info!("shoonya pre-market: reconnecting before the open");
                }
                auth_backoff = Duration::from_secs(30);
                continue;
            }
            // Saved token expired (they last a trading day): log in again straight away.
            End::Rejected if auto && !fresh => {
                tracing::info!("shoonya refused the saved token; logging in again");
                stale = Some(token);
                continue;
            }
            End::Rejected => {
                let w = auth_backoff;
                auth_backoff = (auth_backoff * 2).min(Duration::from_secs(600));
                stale = Some(token);
                if auto {
                    tracing::warn!(retry_in = ?w, "shoonya refused even a fresh login token");
                } else {
                    tracing::warn!(retry_in = ?w, "shoonya refused the token: expired or invalid — save a new one, or the login fields for auto-login");
                }
                Some(w)
            }
            End::Dropped(e) => {
                drop_backoff = if started.elapsed() >= HEALTHY_SESSION { RECONNECT_FIRST } else { (drop_backoff * 2).min(RECONNECT_CAP) };
                tracing::warn!(error = %e, retry_in = ?drop_backoff, "shoonya feed dropped; reconnecting");
                Some(drop_backoff)
            }
        };
        hub.set_feed_status("shoonya", false);
        if !idle(&mut rx, &mut subs, &mut ver, &creds, wait).await {
            return;
        }
    }
}

/// One trading day's 1-minute candles of an instrument, by feed id (`NSE_IDX:26017`),
/// from Shoonya's TPSeries with the live feed's token. Used for India VIX, which
/// neither history broker serves (Nubra: "invalid index"; Kotak: no indices).
pub async fn day_minutes(creds: &CredStore, feed_id: &str, day: chrono::NaiveDate) -> Result<Vec<Candle>, String> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = CLIENT.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(15)).build().expect("http client"));
    let id = InstrumentId(feed_id.to_string());
    let exch = exch(id.segment()).ok_or_else(|| format!("{feed_id}: not a Shoonya segment"))?;
    let uid = creds.get("SHOONYA_UID").ok_or("shoonya: no user id")?;
    let token = creds.get("SHOONYA_ACCESS_TOKEN").ok_or("shoonya: not logged in")?;
    let ist = chrono::FixedOffset::east_opt(5 * 3600 + 1800).unwrap();
    let at = |h: u32| day.and_hms_opt(h, 0, 0).and_then(|t| t.and_local_timezone(ist).single()).map(|t| t.timestamp()).unwrap_or(0);
    let body = serde_json::json!({
        "ordersource": "API", "uid": uid, "exch": exch, "token": id.token(),
        "st": at(0).to_string(), "et": at(23).to_string(), "intrv": "1",
    });
    let text = client
        .post(TP_SERIES_URL)
        .bearer_auth(token)
        .body(format!("jData={body}"))
        .send()
        .await
        .map_err(|e| format!("shoonya TPSeries: {e}"))?
        .text()
        .await
        .map_err(|e| format!("shoonya TPSeries: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|_| format!("shoonya TPSeries: {}", text.chars().take(200).collect::<String>()))?;
    // A list of minutes, newest first; an error is an object ({"stat":"Not_Ok","emsg":..}).
    let Some(rows) = v.as_array() else {
        return Err(format!("shoonya TPSeries: {}", v["emsg"].as_str().unwrap_or("no data")));
    };
    let num = |r: &serde_json::Value, f: &str| r[f].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    let mut out: Vec<Candle> = rows
        .iter()
        .filter_map(|r| {
            // `ssboe`: the minute's start, epoch seconds.
            let t = r["ssboe"].as_str()?.parse::<i64>().ok()?;
            Some((t, num(r, "into"), num(r, "inth"), num(r, "intl"), num(r, "intc"), num(r, "intv")))
        })
        .collect();
    out.sort_by_key(|c| c.0);
    Ok(out)
}

/// Whether every field the headless login needs is saved.
pub fn can_auto_login(creds: &CredStore) -> bool {
    LOGIN_KEYS.iter().all(|k| creds.is_set(k))
}

/// Runs the login script; it prints `{"access_token": .., "actid": ..}`. Saves and returns the token.
async fn browser_login(l: &LoginCmd, creds: &CredStore) -> anyhow::Result<String> {
    let (prog, args) = l.cmd.split_first().ok_or_else(|| anyhow::anyhow!("login_cmd is empty"))?;
    // A relative program path is relative to config.toml, like the script path after it.
    let prog = if prog.contains(['/', '\\']) { l.dir.join(prog) } else { PathBuf::from(prog) };
    let mut c = tokio::process::Command::new(&prog);
    c.args(args).current_dir(&l.dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
    for k in LOGIN_KEYS {
        if let Some(v) = creds.get(k) {
            c.env(k, v);
        }
    }
    let out = tokio::time::timeout(LOGIN_TIMEOUT, c.output())
        .await
        .map_err(|_| anyhow::anyhow!("login took over {}s", LOGIN_TIMEOUT.as_secs()))?
        .map_err(|e| anyhow::anyhow!("cannot run {}: {e}", prog.display()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no error text");
        anyhow::bail!("{last}");
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = stdout
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str(l).ok())
        .ok_or_else(|| anyhow::anyhow!("login script printed no result"))?;
    let token = v["access_token"].as_str().filter(|t| !t.is_empty()).ok_or_else(|| anyhow::anyhow!("login returned no access token"))?;
    let mut updates = vec![("SHOONYA_ACCESS_TOKEN".to_string(), token.to_string())];
    if let Some(a) = v["actid"].as_str().filter(|a| !a.is_empty()) {
        updates.push(("SHOONYA_ACTID".to_string(), a.to_string()));
    }
    creds.set_many(&updates).map_err(anyhow::Error::msg)?;
    tracing::info!("shoonya auto-login OK; new token saved");
    Ok(token.to_string())
}

#[allow(clippy::too_many_arguments)]
async fn session(
    hub: &Arc<LiveHub>,
    rx: &mut mpsc::UnboundedReceiver<FeedCmd>,
    ver: &mut watch::Receiver<u64>,
    creds: &CredStore,
    uid: &str,
    actid: &str,
    token: &str,
    subs: &mut HashSet<InstrumentId>,
) -> End {
    match session_inner(hub, rx, ver, creds, uid, actid, token, subs).await {
        Ok(end) => end,
        Err(e) => End::Dropped(e),
    }
}

#[allow(clippy::too_many_arguments)]
async fn session_inner(
    hub: &Arc<LiveHub>,
    rx: &mut mpsc::UnboundedReceiver<FeedCmd>,
    ver: &mut watch::Receiver<u64>,
    creds: &CredStore,
    uid: &str,
    actid: &str,
    token: &str,
    subs: &mut HashSet<InstrumentId>,
) -> anyhow::Result<End> {
    let before = creds.snapshot(&OWN_KEYS);
    let (ws, _) = tokio_tungstenite::connect_async(WS_URL).await?;
    let (mut tx, mut rxw) = ws.split();
    let connect = serde_json::json!({"t": "a", "uid": uid, "actid": actid, "source": "API", "accesstoken": token});
    tx.send(Message::Text(connect.to_string().into())).await?;

    let ack = tokio::time::timeout(Duration::from_secs(10), rxw.next()).await?;
    let ok = match ack {
        Some(Ok(Message::Text(t))) => {
            let v: serde_json::Value = serde_json::from_str(t.as_str())?;
            v["t"] == "ak" && v["s"].as_str().map(|s| s.eq_ignore_ascii_case("ok")).unwrap_or(false)
        }
        _ => false,
    };
    if !ok {
        return Ok(End::Rejected);
    }
    hub.set_feed_status("shoonya", true);
    tracing::info!(resubscribing = subs.len(), "shoonya feed connected");

    if !subs.is_empty() {
        let k: Vec<String> = subs.iter().filter_map(key).collect();
        tx.send(Message::Text(serde_json::json!({"t": "t", "k": k.join("#")}).to_string().into())).await?;
    }

    // Last known (ltp, volume, bid, ask, oi, prev_oi) per instrument: `tf` updates carry only what changed.
    let mut last: HashMap<String, (f64, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>)> = HashMap::new();
    // Shoonya's own SDK heartbeats every 3 s with a ping carrying {"t":"h"}; with
    // a 20 s empty ping their gateway reset the connection every few minutes.
    let mut ping = tokio::time::interval(HEARTBEAT_EVERY);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let pre_market = tokio::time::sleep(crate::clock::until_next_weekday(PRE_MARKET.0, PRE_MARKET.1));
    tokio::pin!(pre_market);
    loop {
        tokio::select! {
            r = own_change(ver, creds, &before) => {
                return Ok(if r { End::CredsChanged } else { End::Closed });
            }
            _ = &mut pre_market => return Ok(End::PreMarket),
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { return Ok(End::Closed) };
                let (t, id) = match cmd { FeedCmd::Sub(id) => ("t", id), FeedCmd::Unsub(id) => ("u", id) };
                let Some(k) = key(&id) else { continue };
                if t == "t" { subs.insert(id); } else { subs.remove(&id); }
                tx.send(Message::Text(serde_json::json!({"t": t, "k": k}).to_string().into())).await?;
            }
            _ = ping.tick() => { tx.send(Message::Ping(HEARTBEAT.as_bytes().to_vec().into())).await?; }
            msg = rxw.next() => {
                let msg = msg.ok_or_else(|| anyhow::anyhow!("closed"))??;
                let Message::Text(t) = msg else { continue };
                let v: serde_json::Value = match serde_json::from_str(t.as_str()) { Ok(v) => v, Err(_) => continue };
                let kind = v["t"].as_str().unwrap_or("");
                if kind != "tk" && kind != "tf" { continue; }
                let (Some(e), Some(tk)) = (v["e"].as_str(), v["tk"].as_str()) else { continue };
                let num = |f: &str| v[f].as_str().and_then(|s| s.parse::<f64>().ok());
                // `tk` answers a subscribe with the last known state (yesterday's, before
                // the open); only a `tf` that moves price, volume or the quote is live.
                let replay = kind == "tk" || ["lp", "v", "bp1", "sp1"].iter().all(|f| num(f).is_none());
                let entry = last.entry(format!("{e}|{tk}")).or_insert((0.0, None, None, None, None, None));
                if let Some(lp) = num("lp") { entry.0 = lp; }
                if let Some(vol) = num("v") { entry.1 = Some(vol); }
                // Best bid / ask; 0 means no order on that side.
                if let Some(b) = num("bp1") { entry.2 = (b > 0.0).then_some(b); }
                if let Some(a) = num("sp1") { entry.3 = (a > 0.0).then_some(a); }
                // Open interest (a derivative leg only): `oi` now, `poi` yesterday's close.
                if let Some(oi) = num("oi") { entry.4 = Some(oi); }
                if let Some(poi) = num("poi") { entry.5 = Some(poi); }
                if entry.0 == 0.0 { continue; }
                let Some(seg) = segment(e) else { continue };
                hub.publish(&Tick {
                    id: InstrumentId(format!("{seg}:{tk}")),
                    ltp: entry.0,
                    volume: entry.1,
                    bid: entry.2,
                    ask: entry.3,
                    oi: entry.4,
                    prev_oi: entry.5,
                    ts_ms: chrono::Utc::now().timestamp_millis(),
                    src: "shoonya",
                    replay,
                });
            }
        }
    }
}
