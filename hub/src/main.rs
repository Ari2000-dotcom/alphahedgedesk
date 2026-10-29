// Release builds with the window are a normal Windows app: no console window.
// The server build (--no-default-features) is a console program.
#![cfg_attr(all(windows, not(debug_assertions), feature = "gui"), windows_subsystem = "windows")]

mod admin;
mod alerts;
mod api;
mod brokers;
mod canonical;
mod clock;
mod console;
mod creds;
#[cfg(feature = "gui")]
mod gui;
mod history;
mod instruments;
mod live;
mod model;
mod oi_profile;
mod ratelimit;
mod secure_store;
mod straddle;
mod users;

use brokers::HistoryBroker;
use parking_lot::Mutex;
use ratelimit::LimitSpec;
use serde::Deserialize;
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const LOG_LINES_KEPT: usize = 400;
/// Connections allowed to wait for accept (the OS may cap it lower).
const LISTEN_BACKLOG: u32 = 4096;

#[derive(Deserialize)]
struct Config {
    env_file: Option<String>,
    server: ServerCfg,
    brokers: BrokersCfg,
    #[serde(default)]
    straddle: StraddleCfg,
}
#[derive(Deserialize, Default)]
struct StraddleCfg {
    /// Underlyings kept ready all day (see config.toml).
    #[serde(default)]
    warm: Vec<String>,
}
#[derive(Deserialize)]
struct ServerCfg {
    bind: String,
    /// Users need a key from users.toml for /ws and /history.
    #[serde(default = "yes")]
    require_keys: bool,
    /// Limits per visitor IP when keys aren't required.
    #[serde(default)]
    guest: users::GuestLimits,
    /// CPU threads; default one per core. Lower it to share a small VPS with other programs.
    worker_threads: Option<usize>,
    /// Web pages besides the hub's own site allowed to open /ws from a browser.
    #[serde(default)]
    allowed_origins: Vec<String>,
    /// The site is reached only through Cloudflare: visitors' IPs come from CF-Connecting-IP.
    #[serde(default)]
    behind_cloudflare: bool,
}
fn yes() -> bool {
    true
}
#[derive(Deserialize)]
struct BrokersCfg {
    kotak: KotakCfg,
    nubra: NubraCfg,
    shoonya: ShoonyaCfg,
    sim: SimCfg,
}
#[derive(Deserialize)]
struct KotakCfg {
    enabled: bool,
    history_limits: LimitSpec,
}
#[derive(Deserialize)]
struct NubraCfg {
    enabled: bool,
    base_url: String,
    history_limits: LimitSpec,
}
#[derive(Deserialize)]
struct ShoonyaCfg {
    enabled: bool,
    /// Headless login run when the token is missing or expired; paths relative to config.toml.
    #[serde(default)]
    login_cmd: Vec<String>,
    /// Ask Shoonya for the depth feed instead of touchline (see config.toml).
    #[serde(default)]
    depth_feed: bool,
}
#[derive(Deserialize)]
struct SimCfg {
    enabled: bool,
    history_limits: LimitSpec,
    server_limits: LimitSpec,
    latency_ms: [u64; 2],
    tick_ms: u64,
}

/// Log output goes to the console (when there is one) and into a ring buffer the window shows.
#[derive(Clone)]
struct TeeLog(Arc<Mutex<VecDeque<String>>>);

impl Write for TeeLog {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // No console in the windowed release build: stdout may be closed, which is fine.
        let _ = std::io::stdout().write_all(buf);
        let mut q = self.0.lock();
        for line in String::from_utf8_lossy(buf).lines().filter(|l| !l.trim().is_empty()) {
            if q.len() >= LOG_LINES_KEPT {
                q.pop_front();
            }
            q.push_back(line.to_string());
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        let _ = std::io::stdout().flush();
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for TeeLog {
    type Writer = TeeLog;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// config.toml: the path given, else the working folder, else next to the exe
/// or up to three folders above it (so double-clicking the exe works).
fn find_config() -> anyhow::Result<PathBuf> {
    if let Some(p) = std::env::args().skip(1).find(|a| !a.starts_with("--")) {
        return Ok(PathBuf::from(p));
    }
    let mut candidates = vec![PathBuf::from("config.toml")];
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        for _ in 0..4 {
            if let Some(d) = dir {
                candidates.push(d.join("config.toml"));
                dir = d.parent().map(Path::to_path_buf);
            }
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| anyhow::anyhow!("config.toml not found next to MarketHub.exe or in the current folder"))
}

/// Everything the window needs from the running hub.
pub struct Hub {
    pub state: api::AppState,
    pub creds: Arc<creds::CredStore>,
    pub nubra: Option<Arc<brokers::nubra::Nubra>>,
    pub logs: Arc<Mutex<VecDeque<String>>>,
    pub bind: String,
    pub data_dir: PathBuf,
    pub env_path: PathBuf,
}

async fn start_hub(logs: Arc<Mutex<VecDeque<String>>>) -> anyhow::Result<Hub> {
    let path = find_config()?;
    let cfg: Config = toml::from_str(&std::fs::read_to_string(&path)?)?;
    // canonicalize() on Windows adds a `\\?\` prefix; strip it so paths read normally.
    let canonical = PathBuf::from(path.canonicalize()?.to_string_lossy().trim_start_matches(r"\\?\").to_string());
    let config_dir = canonical.parent().map(Path::to_path_buf).unwrap_or_default();
    let data_dir = config_dir.join("data");
    tracing::info!(config = %canonical.display(), "starting MarketHub");

    // Encrypted credential store; imports the old .env once on first start.
    let env_path = config_dir.join(cfg.env_file.as_deref().unwrap_or(".env"));
    let creds = creds::CredStore::open(data_dir.join("credentials.bin"), &env_path);

    // Instrument lists (canonical names ↔ broker tokens): the live feed resolves
    // through them, and Nubra builds its symbols from them.
    let instruments = (cfg.brokers.shoonya.enabled || cfg.brokers.nubra.enabled)
        .then(|| instruments::Instruments::new(data_dir.join("instruments")));
    if let Some(inst) = &instruments {
        let inst = inst.clone();
        tokio::spawn(async move { inst.ensure_fresh().await });
    }

    // ---- history brokers, in strict preference order: Nubra for all history
    // (NSE, BSE, MCX; one source keeps a day's numbers consistent), Kotak only
    // when Nubra fails a piece. Live data comes from Shoonya (below). ----
    let mut hist_brokers: Vec<Arc<dyn HistoryBroker>> = Vec::new();
    let nubra = cfg.brokers.nubra.enabled.then(|| {
        brokers::nubra::Nubra::new(
            cfg.brokers.nubra.base_url.clone(),
            creds.clone(),
            data_dir.join("nubra-device-login.bin"),
            &cfg.brokers.nubra.history_limits,
            instruments.clone(),
        )
    });
    if let Some(n) = &nubra {
        hist_brokers.push(n.clone());
    }
    if cfg.brokers.kotak.enabled {
        hist_brokers.push(Arc::new(brokers::kotak::Kotak::new(creds.clone(), &cfg.brokers.kotak.history_limits)));
    }
    let sim = cfg.brokers.sim.enabled.then(|| {
        Arc::new(brokers::sim::Sim::new(&cfg.brokers.sim.history_limits, &cfg.brokers.sim.server_limits, cfg.brokers.sim.latency_ms))
    });
    if let Some(s) = &sim {
        hist_brokers.push(s.clone());
    }

    // ---- live feeds ----
    let mut feed_tx = HashMap::new();
    let mut feed_rx = HashMap::new();
    for (name, on) in [("shoonya", cfg.brokers.shoonya.enabled), ("sim", sim.is_some())] {
        if on {
            let (tx, rx) = mpsc::unbounded_channel();
            feed_tx.insert(name, tx);
            feed_rx.insert(name, rx);
        }
    }
    // Instrument lists (canonical names → broker tokens), only with a real feed.
    let live = live::LiveHub::new(feed_tx, instruments.clone());
    if let Some(rx) = feed_rx.remove("shoonya") {
        brokers::shoonya::use_depth_feed(cfg.brokers.shoonya.depth_feed);
        let login = (!cfg.brokers.shoonya.login_cmd.is_empty())
            .then(|| brokers::shoonya::LoginCmd { cmd: cfg.brokers.shoonya.login_cmd.clone(), dir: config_dir.clone() });
        tokio::spawn(brokers::shoonya::run_feed(live.clone(), rx, creds.clone(), login));
    }
    if let Some(rx) = feed_rx.remove("sim") {
        tokio::spawn(brokers::sim::run_feed(live.clone(), rx, cfg.brokers.sim.tick_ms));
    }

    let hist = history::HistoryEngine::new(hist_brokers);
    let vix_creds = cfg.brokers.shoonya.enabled.then(|| creds.clone());
    let straddles = instruments.as_ref().map(|i| straddle::StraddleHub::new(live.clone(), i.clone(), hist.clone(), vix_creds));

    // Popular straddles ready before anyone asks: now, and every weekday at 08:55
    // IST so they record from the open.
    if let (Some(hub), Some(inst)) = (&straddles, &instruments) {
        let warm = cfg.straddle.warm.clone();
        if !warm.is_empty() {
            let (hub_now, inst_now, warm_now) = (hub.clone(), inst.clone(), warm.clone());
            tokio::spawn(async move {
                inst_now.ensure_fresh().await;
                hub_now.warm(&warm_now).await;
            });
            let hub = hub.clone();
            clock::every_weekday_at(8, 55, "warm straddles", move || {
                let (hub, warm) = (hub.clone(), warm.clone());
                async move { hub.warm(&warm).await }
            });
        }
    }

    // Pre-market, every weekday (Shoonya's own fresh login is at 08:45, in its feed):
    // the day's instrument lists (published ~07:25), and a Nubra login ready
    // before the first backfill needs it.
    if let Some(inst) = &instruments {
        let inst = inst.clone();
        clock::every_weekday_at(7, 45, "instrument lists", move || {
            let inst = inst.clone();
            async move { inst.ensure_fresh().await }
        });
    }
    if let Some(nb) = &nubra {
        let nb = nb.clone();
        clock::every_weekday_at(8, 50, "nubra login", move || {
            let nb = nb.clone();
            async move {
                match nb.test_login().await {
                    Ok(()) => tracing::info!("nubra ready for the open"),
                    Err(e) => tracing::warn!(error = %e, "nubra pre-market login failed"),
                }
            }
        });
    }
    // The OI profile reads Nubra's whole-chain OI against the instrument lists' strikes.
    let oi = match (&nubra, &instruments) {
        (Some(n), Some(i)) => Some(oi_profile::OiProfiles::new(n.clone(), i.clone())),
        _ => None,
    };
    let state = api::AppState {
        live,
        hist,
        instruments,
        straddles,
        oi,
        users: users::Users::open(config_dir.join("users.toml"), cfg.server.require_keys, cfg.server.guest.clone()),
        started: Instant::now(),
        clients: Arc::new(AtomicU64::new(0)),
        extra: Arc::new(move || match &sim {
            Some(s) => serde_json::json!({"sim_server": {
                "calls_received": s.calls.load(Ordering::Relaxed),
                "limit_violations": s.violations.load(Ordering::Relaxed),
            }}),
            None => serde_json::json!({}),
        }),
        allowed_origins: Arc::new(cfg.server.allowed_origins.clone()),
        behind_cloudflare: cfg.server.behind_cloudflare,
    };
    if cfg.server.behind_cloudflare {
        tracing::info!("behind Cloudflare: visitor IPs come from CF-Connecting-IP (the site must be reachable only through Cloudflare)");
    }

    // A previous copy may still hold the port for a moment.
    let mut tries = 0;
    let listener = loop {
        match listen(&cfg.server.bind) {
            Ok(l) => break l,
            Err(e) if tries < 40 => {
                tries += 1;
                if tries == 1 {
                    tracing::warn!(error = %e, "port busy; waiting for it to free up");
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            Err(e) => anyhow::bail!("cannot listen on {}: {e} (is MarketHub already running?)", cfg.server.bind),
        }
    };
    tracing::info!(api = %format!("http://{}", cfg.server.bind), "hub listening");
    let app = api::router(state.clone())
        .merge(admin::router(creds.clone(), nubra.clone()))
        .into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move {
        // No Nagle delay: small quote messages go out at once instead of waiting to be combined.
        use axum::serve::ListenerExt;
        let listener = listener.tap_io(|tcp| {
            let _ = tcp.set_nodelay(true);
        });
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!(error = %e, "API server stopped");
        }
    });

    Ok(Hub { state, creds, nubra, logs, bind: cfg.server.bind, data_dir, env_path })
}

/// Listens with a long queue of not-yet-accepted connections, so a burst of
/// users arriving at once (e.g. at market open) waits instead of being refused.
fn listen(bind: &str) -> std::io::Result<tokio::net::TcpListener> {
    let addr: SocketAddr = bind
        .parse()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bind must be IP:port, e.g. 127.0.0.1:8080"))?;
    let sock = if addr.is_ipv4() { tokio::net::TcpSocket::new_v4()? } else { tokio::net::TcpSocket::new_v6()? };
    // On Windows this flag would let another program take the port, so only elsewhere.
    #[cfg(not(windows))]
    sock.set_reuseaddr(true)?;
    sock.bind(addr)?;
    sock.listen(LISTEN_BACKLOG)
}

/// `--instruments`: checks/downloads the instrument lists and prints what is there.
fn check_instruments() -> anyhow::Result<()> {
    let config = find_config()?;
    let dir = config.canonicalize()?.parent().map(|d| d.join("data").join("instruments")).unwrap_or_default();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    rt.block_on(async {
        let mem = || memory_stats::memory_stats().map(|m| m.physical_mem as f64 / 1048576.0).unwrap_or(0.0);
        let t = Instant::now();
        let inst = instruments::Instruments::new(dir.clone());
        println!("loaded from disk in {:?}; RAM {:.1} MB", t.elapsed(), mem());
        let t = Instant::now();
        inst.refresh().await;
        println!("check/download took {:?}; RAM {:.1} MB", t.elapsed(), mem());
        println!("{}", serde_json::to_string_pretty(&inst.summary())?);
        for id in ["nse:nifty", "bse:sensex", "mcx:crudeoil", "nse:reliance"] {
            let c = canonical::Canonical::parse(id).map_err(anyhow::Error::msg)?;
            let Some(u) = inst.get(c.market(), &c.name_upper()) else {
                println!("{id}: not found");
                continue;
            };
            let exp = u.expiries[0];
            let t = Instant::now();
            let chain = inst.chain(u.market, &u.name, exp)?;
            let read = t.elapsed();
            let reference = u.reference_for(exp).map(|r| r.to_string()).unwrap_or_default();
            let mid = &chain[chain.len() / 2];
            let t = Instant::now();
            let leg = canonical::Canonical::parse(&mid.call).map_err(anyhow::Error::msg)?;
            let feed = inst.resolve(&leg).map_err(anyhow::Error::msg)?;
            println!(
                "{}: {} expiries, nearest {exp}, {} strikes, lot {}, chain read {read:?}\n   reference {reference} -> {:?}\n   leg {} -> {feed} (resolved in {:?}, from cache)",
                u.id,
                u.expiries.len(),
                chain.len(),
                u.lot,
                canonical::Canonical::parse(&reference).ok().map(|r| inst.resolve(&r)),
                mid.call,
                t.elapsed()
            );
        }
        let vix = canonical::Canonical::parse("nse:indiavix").map_err(anyhow::Error::msg)?;
        println!("nse:indiavix -> {:?}", inst.resolve(&vix));
        println!("search \"BANK\": {:?}", inst.search("BANK", 5).iter().map(|u| u.id.clone()).collect::<Vec<_>>());
        println!("RAM at end {:.1} MB", mem());
        anyhow::Ok(())
    })
}

/// `--chain <underlying> [expiry]`: reads the instrument file on disk (no network, no broker) and
/// prints how many strikes each of the next expiries has and where they start and end.
fn show_chain() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let at = args.iter().position(|a| a == "--chain").unwrap_or(0);
    let id = args.get(at + 1).ok_or_else(|| anyhow::anyhow!("usage: --chain <underlying>, e.g. --chain bse:sensex"))?;
    let config = find_config()?;
    let dir = config.canonicalize()?.parent().map(|d| d.join("data").join("instruments")).unwrap_or_default();
    let inst = instruments::Instruments::new(dir);
    let c = canonical::Canonical::parse(id).map_err(anyhow::Error::msg)?;
    let u = inst.get(c.market(), &c.name_upper()).ok_or_else(|| anyhow::anyhow!("{id}: not found in the instrument lists"))?;
    println!("{}: {} expiries, lot {}", u.id, u.expiries.len(), u.lot);
    for exp in u.expiries.iter().take(5) {
        let chain = inst.chain(u.market, &u.name, *exp)?;
        let strikes: Vec<f64> = chain.iter().map(|s| s.strike).collect();
        let step = if strikes.len() > 1 { strikes[1] - strikes[0] } else { 0.0 };
        println!("  {exp}: {} strikes, {:?} .. {:?}, first step {step}", strikes.len(), strikes.first(), strikes.last());
    }
    Ok(())
}

/// CPU threads for the hub: `worker_threads` in config.toml, else one per CPU core.
fn worker_threads() -> usize {
    let configured = find_config()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| toml::from_str::<Config>(&t).ok())
        .and_then(|c| c.server.worker_threads);
    configured.unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2)).max(1)
}

fn main() -> anyhow::Result<()> {
    if std::env::args().any(|a| a == "--new-key") {
        println!("{}", users::new_key());
        return Ok(());
    }
    if std::env::args().any(|a| a == "--instruments") {
        return check_instruments();
    }
    if std::env::args().any(|a| a == "--chain") {
        return show_chain();
    }
    // Without the window feature there is nothing else to be.
    let headless = !cfg!(feature = "gui") || std::env::args().any(|a| a == "--headless");
    let color = headless && console::color_enabled();
    let logs = Arc::new(Mutex::new(VecDeque::with_capacity(LOG_LINES_KEPT)));
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_ansi(color)
        .with_writer(TeeLog(logs.clone()))
        .init();

    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(worker_threads()).enable_all().build()?;

    let hub = match rt.block_on(start_hub(logs)) {
        Ok(hub) => hub,
        Err(e) => {
            tracing::error!(error = %e, "MarketHub could not start");
            #[cfg(feature = "gui")]
            if !headless {
                return gui::run_error(format!("{e:#}"));
            }
            return Err(e);
        }
    };
    rt.spawn(alerts::run(hub.state.clone(), hub.creds.clone(), hub.nubra.clone()));
    #[cfg(feature = "gui")]
    if !headless {
        return gui::run(hub, rt.handle().clone());
    }

    tracing::info!(env = %hub.env_path.display(), "running headless (no window); edit .env to change credentials; Ctrl+C to stop");
    rt.spawn(console::watch_env(hub.creds.clone(), hub.env_path.clone()));
    rt.spawn(console::status_loop(hub.state.clone(), hub.creds.clone(), hub.nubra.clone(), color));
    rt.block_on(console::shutdown_signal());
    tracing::info!("stopping");
    drop(hub);
    Ok(())
}
