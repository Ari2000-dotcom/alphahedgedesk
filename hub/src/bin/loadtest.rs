//! Load tester for MarketHub. Opens many WebSocket users against a hub that runs
//! the simulated feed, and reports what that costs the hub (RAM) and how quickly
//! ticks reach users (delay from the hub publishing a tick to a user receiving it).
//!
//!   1. start the hub:  MarketHub-server.exe loadtest/config.toml   (sim only, no keys, port 8090)
//!   2. run:            loadtest --clients 5000 --topics 10 --instruments 50 --secs 60
//!
//! Users are spread over several local source addresses (127.0.0.1, .2, ...), since
//! Windows allows only ~16k outgoing connections per source address.

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpSocket;
use tokio_tungstenite::tungstenite::Message;

struct Args {
    clients: usize,
    topics: usize,
    instruments: usize,
    secs: u64,
    ramp: usize,
    port: u16,
    sources: usize,
}

fn args() -> Args {
    let argv: Vec<String> = std::env::args().collect();
    let get = |name: &str, default: u64| -> u64 {
        argv.iter().position(|a| a == name).and_then(|i| argv.get(i + 1)).and_then(|v| v.parse().ok()).unwrap_or(default)
    };
    Args {
        clients: get("--clients", 1000) as usize,
        topics: get("--topics", 10) as usize,
        instruments: get("--instruments", 50) as usize,
        secs: get("--secs", 60),
        ramp: get("--ramp", 1000) as usize,
        port: get("--port", 8090) as u16,
        sources: get("--sources", 8).clamp(1, 250) as usize,
    }
}

#[derive(Default)]
struct Stats {
    connected: AtomicU64,
    failed: AtomicU64,
    closed: AtomicU64,
    msgs: AtomicU64,
    /// Sampled delays (ms) since the last report.
    delays: Mutex<Vec<u32>>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The `"ts":` field of a quote, without parsing the whole message.
fn tick_ts(msg: &str) -> Option<i64> {
    let rest = &msg[msg.find("\"ts\":")? + 5..];
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

async fn client(i: usize, a: Arc<Args>, stats: Arc<Stats>) {
    let src = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1 + (i % a.sources) as u8));
    let ws = async {
        let sock = TcpSocket::new_v4()?;
        sock.bind(SocketAddr::new(src, 0))?;
        let stream = sock.connect(SocketAddr::from(([127, 0, 0, 1], a.port))).await?;
        let (ws, _) = tokio_tungstenite::client_async(format!("ws://127.0.0.1:{}/ws", a.port), stream).await?;
        anyhow::Ok(ws)
    }
    .await;
    let mut ws = match ws {
        Ok(ws) => ws,
        Err(_) => {
            stats.failed.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };
    stats.connected.fetch_add(1, Ordering::Relaxed);
    // Each user watches `topics` consecutive instruments starting at its own offset.
    let topics: Vec<String> = (0..a.topics.min(a.instruments)).map(|k| format!("quote:SIM:{}", 1 + (i + k) % a.instruments)).collect();
    let sub = serde_json::json!({"op": "sub", "topics": topics}).to_string();
    if ws.send(Message::Text(sub.into())).await.is_err() {
        stats.closed.fetch_add(1, Ordering::Relaxed);
        return;
    }
    let mut local = 0u64;
    while let Some(Ok(m)) = ws.next().await {
        let Message::Text(t) = m else { continue };
        local += 1;
        // Counting every message on a shared counter would itself be the bottleneck.
        if local % 64 == 0 {
            stats.msgs.fetch_add(64, Ordering::Relaxed);
            if let Some(ts) = tick_ts(t.as_str()) {
                stats.delays.lock().push((now_ms() - ts).max(0) as u32);
            }
        }
    }
    stats.connected.fetch_sub(1, Ordering::Relaxed);
    stats.closed.fetch_add(1, Ordering::Relaxed);
}

fn pct(sorted: &[u32], p: f64) -> u32 {
    if sorted.is_empty() {
        return 0;
    }
    sorted[((sorted.len() - 1) as f64 * p) as usize]
}

async fn hub_mb(http: &reqwest::Client, port: u16) -> Option<f64> {
    let v: serde_json::Value = http.get(format!("http://127.0.0.1:{port}/stats")).send().await.ok()?.json().await.ok()?;
    v["memory_mb"].as_f64()
}

#[tokio::main]
async fn main() {
    let a = Arc::new(args());
    let stats = Arc::new(Stats::default());
    let http = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().expect("http client");
    let idle_mb = hub_mb(&http, a.port).await;
    println!(
        "loadtest: {} users x {} instruments each (of {}), {} s, ramp {}/s; hub RAM before: {:?} MB",
        a.clients, a.topics, a.instruments, a.secs, a.ramp, idle_mb
    );

    let launcher = {
        let (a, stats) = (a.clone(), stats.clone());
        tokio::spawn(async move {
            for i in 0..a.clients {
                tokio::spawn(client(i, a.clone(), stats.clone()));
                if (i + 1) % a.ramp == 0 {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        })
    };

    let start = Instant::now();
    let mut last_msgs = 0u64;
    let mut last_t = Instant::now();
    let mut steady: Vec<(f64, u32, u32, f64)> = Vec::new();
    while start.elapsed() < Duration::from_secs(a.secs) {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let msgs = stats.msgs.load(Ordering::Relaxed);
        let rate = (msgs - last_msgs) as f64 / last_t.elapsed().as_secs_f64();
        last_msgs = msgs;
        last_t = Instant::now();
        let mut d = std::mem::take(&mut *stats.delays.lock());
        d.sort_unstable();
        let (p50, p99, max) = (pct(&d, 0.5), pct(&d, 0.99), d.last().copied().unwrap_or(0));
        let mb = hub_mb(&http, a.port).await;
        let connected = stats.connected.load(Ordering::Relaxed);
        println!(
            "t={:>3}s users={:>6} failed={} closed={}  msgs/s={:>9.0}  delay p50={}ms p99={}ms max={}ms  hub RAM={:?} MB",
            start.elapsed().as_secs(),
            connected,
            stats.failed.load(Ordering::Relaxed),
            stats.closed.load(Ordering::Relaxed),
            rate,
            p50,
            p99,
            max,
            mb
        );
        // Steady state: everyone connected for a full interval.
        if launcher.is_finished() && connected as usize + stats.failed.load(Ordering::Relaxed) as usize >= a.clients {
            steady.push((rate, p50, p99, mb.unwrap_or(0.0)));
        }
    }
    if let Some(&(_, _, _, mb)) = steady.last() {
        let n = steady.len() as f64;
        let rate = steady.iter().map(|s| s.0).sum::<f64>() / n;
        let p50 = steady.iter().map(|s| s.1).max().unwrap_or(0);
        let p99 = steady.iter().map(|s| s.2).max().unwrap_or(0);
        println!(
            "RESULT users={} failed={} msgs/s={:.0} delay p50<={}ms p99<={}ms hub RAM={:.1} MB ({:.1} KB/user)",
            stats.connected.load(Ordering::Relaxed),
            stats.failed.load(Ordering::Relaxed),
            rate,
            p50,
            p99,
            mb,
            (mb - idle_mb.unwrap_or(0.0)) * 1024.0 / a.clients.max(1) as f64
        );
    }
    std::process::exit(0);
}
