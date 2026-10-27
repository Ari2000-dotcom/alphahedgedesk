//! Headless (server/VPS) mode: no window. Status goes to the console as one
//! coloured line — green = up, amber = waiting / needs something, red = down —
//! printed whenever anything changes and once a minute otherwise. Credentials
//! come from the .env file, which is watched: edit it and brokers reconnect.

use crate::api::{self, AppState};
use crate::brokers::{nubra::Nubra, shoonya};
use crate::creds::CredStore;
use std::io::IsTerminal;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

#[derive(Clone, Copy, PartialEq)]
pub enum Level {
    Up,
    Wait,
    Down,
}

/// Colours on a terminal, or when MARKETHUB_COLOR=1 (e.g. under systemd, read with `journalctl -o cat`).
pub fn color_enabled() -> bool {
    if std::env::var_os("NO_COLOR").is_some() {
        return false;
    }
    let on = std::io::stdout().is_terminal() || std::env::var("MARKETHUB_COLOR").is_ok_and(|v| v == "1");
    if on {
        enable_vt();
    }
    on
}

/// Old Windows consoles show escape codes as text unless VT processing is switched on.
#[cfg(windows)]
fn enable_vt() {
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_OUTPUT_HANDLE,
    };
    // SAFETY: plain console calls on this process's own stdout handle.
    unsafe {
        let h = GetStdHandle(STD_OUTPUT_HANDLE);
        let mut mode = 0;
        if GetConsoleMode(h, &mut mode) != 0 {
            SetConsoleMode(h, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
        }
    }
}
#[cfg(not(windows))]
fn enable_vt() {}

fn paint(text: &str, level: Level, color: bool) -> String {
    if !color {
        let tag = match level {
            Level::Up => "UP",
            Level::Wait => "WAIT",
            Level::Down => "DOWN",
        };
        return format!("{text} [{tag}]");
    }
    let code = match level {
        Level::Up => "32",
        Level::Wait => "33",
        Level::Down => "31",
    };
    format!("\x1b[1;{code}m●\x1b[0m \x1b[{code}m{text}\x1b[0m")
}

/// One "broker: state" line per broker, e.g. ("nubra: logged in", Up). Also used for alerts.
pub fn states(state: &AppState, creds: &CredStore, nubra: &Option<Arc<Nubra>>) -> Vec<(String, Level)> {
    let s = api::stats_json(state);
    let mut out = Vec::new();
    if let Some(up) = s["live"]["feeds"]["shoonya"].as_bool() {
        out.push(if up {
            ("shoonya: connected".to_string(), Level::Up)
        } else if shoonya::LOGGING_IN.load(std::sync::atomic::Ordering::Relaxed) {
            ("shoonya: logging in (headless browser, ~20 s)".to_string(), Level::Wait)
        } else if s["uptime_s"].as_u64().unwrap_or(0) < 15 {
            ("shoonya: connecting…".to_string(), Level::Wait)
        } else if shoonya::can_auto_login(creds) {
            ("shoonya: down — reconnecting".to_string(), Level::Down)
        } else if creds.is_set("SHOONYA_ACCESS_TOKEN") {
            ("shoonya: down — token expired? (no password/TOTP for auto-login)".to_string(), Level::Down)
        } else {
            ("shoonya: no credentials in .env".to_string(), Level::Wait)
        });
    }
    if s["history"]["brokers"]["kotak"].is_object() {
        out.push(if creds.is_set("NEO_CONSUMER_KEY") {
            ("kotak: ready".to_string(), Level::Up)
        } else {
            ("kotak: consumer key not set".to_string(), Level::Wait)
        });
    }
    if let Some(nb) = nubra {
        let st = nb.status.read().clone();
        let level = if st.starts_with("logged in") || st.starts_with("ready") {
            Level::Up
        } else if st.starts_with("login failed") {
            Level::Down
        } else {
            Level::Wait
        };
        out.push((format!("nubra: {st}"), level));
    }
    if let Some(up) = s["live"]["feeds"]["sim"].as_bool() {
        out.push(("sim: running".to_string(), if up { Level::Up } else { Level::Down }));
    }
    out
}

pub async fn status_loop(state: AppState, creds: Arc<CredStore>, nubra: Option<Arc<Nubra>>, color: bool) {
    let mut last: Vec<(String, Level)> = Vec::new();
    let mut printed = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;
        let now = states(&state, &creds, &nubra);
        if now == last && printed.elapsed() < Duration::from_secs(60) {
            continue;
        }
        let mem = memory_stats::memory_stats().map(|m| format!("{:.1} MB", m.physical_mem as f64 / 1048576.0)).unwrap_or_default();
        let line: Vec<String> = now.iter().map(|(t, l)| paint(t, *l, color)).collect();
        let users = state.clients.load(std::sync::atomic::Ordering::Relaxed);
        println!("[status] {}   users {users}   ram {mem}", line.join("   "));
        last = now;
        printed = Instant::now();
    }
}

/// Re-reads .env whenever it changes (and once at start), so the VPS is managed by editing that file.
pub async fn watch_env(creds: Arc<CredStore>, path: PathBuf) {
    let mut seen: Option<SystemTime> = None;
    loop {
        let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        if modified.is_some() && modified != seen {
            seen = modified;
            match creds.reload_env(&path) {
                Ok(0) => {}
                Ok(n) => tracing::info!(fields = n, file = %path.display(), ".env changed; credentials updated"),
                Err(e) => tracing::warn!(error = %e, "could not apply .env"),
            }
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Ctrl+C, or SIGTERM from systemd / `kill`.
pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await.ok();
}
