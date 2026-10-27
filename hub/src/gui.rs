//! MarketHub's desktop window (egui). The hub runs in the same process; closing
//! the window stops it.

use crate::creds::FIELDS;
use crate::{api, Hub};
use eframe::egui::{self, Color32, RichText};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

const OK: Color32 = Color32::from_rgb(63, 185, 80);
const WARN: Color32 = Color32::from_rgb(210, 153, 34);
const BAD: Color32 = Color32::from_rgb(248, 81, 73);
const MUTED: Color32 = Color32::from_rgb(139, 152, 168);

#[derive(PartialEq, Clone, Copy)]
enum Tab {
    Overview,
    Brokers,
    Logs,
}

type Slot = Arc<Mutex<Option<Result<String, String>>>>;

struct App {
    hub: Hub,
    rt: tokio::runtime::Handle,
    tab: Tab,
    stats: Value,
    stats_at: Instant,
    edits: HashMap<&'static str, String>,
    notice: Option<(bool, String)>,
    otp: String,
    task: Slot,
    busy: Option<&'static str>,
}

pub fn run(hub: Hub, rt: tokio::runtime::Handle) -> anyhow::Result<()> {
    let opts = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("MarketHub")
            .with_inner_size([1120.0, 740.0])
            .with_min_inner_size([760.0, 480.0]),
        ..Default::default()
    };
    eframe::run_native(
        "MarketHub",
        opts,
        Box::new(move |cc| {
            cc.egui_ctx.set_visuals(egui::Visuals::dark());
            Ok(Box::new(App {
                hub,
                rt,
                tab: Tab::Overview,
                stats: Value::Null,
                stats_at: Instant::now() - Duration::from_secs(5),
                edits: HashMap::new(),
                notice: None,
                otp: String::new(),
                task: Arc::new(Mutex::new(None)),
                busy: None,
            }))
        }),
    )
    .map_err(|e| anyhow::anyhow!("window: {e}"))
}

/// Shown instead of the main window when the hub cannot start (e.g. config missing).
pub fn run_error(message: String) -> anyhow::Result<()> {
    let opts = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_title("MarketHub — could not start").with_inner_size([620.0, 220.0]),
        ..Default::default()
    };
    eframe::run_native(
        "MarketHub",
        opts,
        Box::new(move |cc| {
            cc.egui_ctx.set_visuals(egui::Visuals::dark());
            Ok(Box::new(ErrorApp(message)))
        }),
    )
    .map_err(|e| anyhow::anyhow!("window: {e}"))
}

struct ErrorApp(String);
impl eframe::App for ErrorApp {
    fn update(&mut self, ctx: &egui::Context, _: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading(RichText::new("MarketHub could not start").color(BAD));
            ui.add_space(8.0);
            ui.label(&self.0);
        });
    }
}

fn n(v: &Value) -> String {
    match v.as_f64() {
        Some(x) if x.fract() == 0.0 => format!("{}", x as i64),
        Some(x) => format!("{x:.1}"),
        None => "–".into(),
    }
}

fn uptime(s: u64) -> String {
    let (h, m) = (s / 3600, s % 3600 / 60);
    if h > 0 { format!("{h}h {m}m") } else { format!("{m}m {}s", s % 60) }
}

fn kpi(ui: &mut egui::Ui, value: String, label: &str, color: Option<Color32>) {
    egui::Frame::group(ui.style()).inner_margin(10.0).show(ui, |ui| {
        ui.set_min_width(170.0);
        ui.vertical(|ui| {
            let mut t = RichText::new(value).size(24.0).strong();
            if let Some(c) = color {
                t = t.color(c);
            }
            ui.label(t);
            ui.label(RichText::new(label).color(MUTED).small());
        });
    });
}

impl App {
    fn spawn<F>(&mut self, what: &'static str, fut: F)
    where
        F: std::future::Future<Output = Result<String, String>> + Send + 'static,
    {
        let slot = self.task.clone();
        self.busy = Some(what);
        self.rt.spawn(async move {
            let r = fut.await;
            *slot.lock() = Some(r);
        });
    }

    fn poll_task(&mut self) {
        if let Some(r) = self.task.lock().take() {
            self.notice = Some(match r {
                Ok(m) => (true, m),
                Err(m) => (false, m),
            });
            self.busy = None;
        }
    }

    fn header(&self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.label(RichText::new("•").size(22.0).color(OK));
            ui.label(RichText::new("MarketHub").size(18.0).strong());
            ui.label(RichText::new(format!("API  http://{}", self.hub.bind)).color(MUTED));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let s = &self.stats;
                ui.label(format!("Users {}", n(&s["clients"])));
                ui.separator();
                let mem = s["memory_mb"].as_f64().map(|m| format!("{m:.0} MB / 200 MB")).unwrap_or("–".into());
                ui.label(format!("Memory {mem}"));
                ui.separator();
                ui.label(format!("Uptime {}", uptime(s["uptime_s"].as_u64().unwrap_or(0))));
            });
        });
    }

    fn overview(&self, ui: &mut egui::Ui) {
        let s = &self.stats;
        let h = &s["history"];
        let rl = h["rate_limited_by_broker"].as_u64().unwrap_or(0);
        ui.horizontal_wrapped(|ui| {
            kpi(ui, rl.to_string(), "Broker \"too many requests\" (must be 0)", Some(if rl == 0 { OK } else { BAD }));
            kpi(ui, n(&h["broker_calls_ok"]), "History broker calls", None);
            kpi(ui, n(&h["merged_into_existing_fetch"]), "Requests merged (calls saved)", None);
            kpi(ui, n(&s["live"]["deliveries"]), "Live messages delivered", None);
            kpi(ui, format!("{} / {}", n(&s["live"]["topics"]), n(&s["live"]["watchers"])), "Live topics / watchers", None);
        });
        ui.add_space(10.0);

        ui.columns(2, |cols| {
            egui::Frame::group(cols[0].style()).inner_margin(12.0).show(&mut cols[0], |ui| {
                ui.label(RichText::new("HISTORY BROKERS · RATE LIMITS").color(MUTED).small().strong());
                ui.add_space(6.0);
                if let Some(brokers) = h["brokers"].as_object() {
                    for (name, b) in brokers {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(name).strong());
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                if b["paused"].as_bool() == Some(true) {
                                    ui.label(RichText::new("paused").color(WARN));
                                } else if b["penalties"].as_u64().unwrap_or(0) > 0 {
                                    ui.label(RichText::new(format!("{} penalties", b["penalties"])).color(WARN));
                                } else {
                                    ui.label(RichText::new("healthy").color(OK));
                                }
                            });
                        });
                        ui.label(
                            RichText::new(format!(
                                "calls {} · in flight {} · speed {:.0}%",
                                n(&b["granted"]),
                                n(&b["in_flight"]),
                                b["rate_factor"].as_f64().unwrap_or(1.0) * 100.0
                            ))
                            .color(MUTED)
                            .small(),
                        );
                        for w in b["windows"].as_array().into_iter().flatten() {
                            let used = w["used"].as_f64().unwrap_or(0.0);
                            let allowed = w["allowed"].as_f64().unwrap_or(1.0).max(1.0);
                            let label = match w["window_s"].as_u64() {
                                Some(1) => "per second",
                                Some(60) => "per minute",
                                _ => "per hour",
                            };
                            ui.add(egui::ProgressBar::new((used / allowed) as f32).text(format!("{label}: {used:.0} / {allowed:.0}")));
                        }
                        ui.separator();
                    }
                }
            });
            egui::Frame::group(cols[1].style()).inner_margin(12.0).show(&mut cols[1], |ui| {
                ui.label(RichText::new("LIVE FEEDS").color(MUTED).small().strong());
                if let Some(feeds) = s["live"]["feeds"].as_object() {
                    for (f, up) in feeds {
                        let up = up.as_bool() == Some(true);
                        ui.horizontal(|ui| {
                            ui.label(RichText::new("•").size(20.0).color(if up { OK } else { BAD }));
                            ui.label(f);
                            ui.label(RichText::new(if up { "connected" } else { "down (see Logs)" }).color(MUTED));
                        });
                    }
                }
                ui.add_space(10.0);
                ui.label(RichText::new("HISTORY ENGINE").color(MUTED).small().strong());
                egui::Grid::new("hist").num_columns(2).striped(true).show(ui, |ui| {
                    let mut row = |k: &str, v: String| {
                        ui.label(k);
                        ui.label(v);
                        ui.end_row();
                    };
                    row("Pieces requested by users", n(&h["requested_pieces"]));
                    row("Broker calls made", n(&h["broker_calls_ok"]));
                    row("Merged into a running fetch", n(&h["merged_into_existing_fetch"]));
                    row("Waiting in queue", n(&h["pending_pieces"]));
                    row("Errors / failed pieces", format!("{} / {}", n(&h["errors"]), n(&h["failed_pieces"])));
                    if s["extra"]["sim_server"].is_object() {
                        row("Sim broker limit violations", n(&s["extra"]["sim_server"]["limit_violations"]));
                    }
                    row("Live updates merged (newest wins)", n(&s["live"]["conflated"]));
                });
            });
        });
    }

    fn brokers(&mut self, ui: &mut egui::Ui) {
        if let Some((ok, msg)) = &self.notice {
            ui.label(RichText::new(msg).color(if *ok { OK } else { BAD }));
            ui.add_space(6.0);
        }
        ui.label(
            RichText::new(format!(
                "Saved encrypted for this Windows user in {}. Secrets are never shown again; leave a field blank to keep it. Save applies immediately.",
                self.hub.data_dir.display()
            ))
            .color(MUTED)
            .small(),
        );
        ui.add_space(8.0);

        let feeds = self.stats["live"]["feeds"].clone();
        egui::ScrollArea::vertical().auto_shrink([false; 2]).show(ui, |ui| {
            for broker in ["kotak", "nubra", "shoonya"] {
                let title = match broker {
                    "kotak" => "Kotak Neo — history (NSE/BSE)",
                    "nubra" => "Nubra — history (NSE/BSE/MCX)",
                    _ => "Shoonya — live feed",
                };
                egui::Frame::group(ui.style()).inner_margin(12.0).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(title).strong().size(15.0));
                        let (txt, color) = match broker {
                            "kotak" if self.hub.creds.is_set("NEO_CONSUMER_KEY") => ("ready".to_string(), OK),
                            "kotak" => ("consumer key not set".to_string(), WARN),
                            "nubra" => match &self.hub.nubra {
                                Some(nb) => {
                                    let st = nb.status.read().clone();
                                    let c = if st.starts_with("logged in") || st.starts_with("ready") {
                                        OK
                                    } else if st.starts_with("login failed") {
                                        BAD
                                    } else {
                                        WARN
                                    };
                                    (st, c)
                                }
                                None => ("disabled in config.toml".to_string(), MUTED),
                            },
                            _ => match feeds["shoonya"].as_bool() {
                                Some(true) => ("connected".to_string(), OK),
                                Some(false) if crate::brokers::shoonya::LOGGING_IN.load(std::sync::atomic::Ordering::Relaxed) => {
                                    ("logging in (headless browser, ~20 s)".to_string(), WARN)
                                }
                                Some(false) if crate::brokers::shoonya::can_auto_login(&self.hub.creds) => {
                                    ("down — reconnecting (see Logs)".to_string(), BAD)
                                }
                                Some(false) => ("down — token expired? save a new one, or fill the auto-login fields".to_string(), BAD),
                                None => ("disabled".to_string(), MUTED),
                            },
                        };
                        ui.label(RichText::new(format!("• {txt}")).color(color));
                    });
                    ui.add_space(6.0);
                    egui::Grid::new(broker).num_columns(3).spacing([12.0, 6.0]).show(ui, |ui| {
                        for (b, key, label, secret) in FIELDS.iter().filter(|f| f.0 == broker) {
                            let _ = b;
                            ui.label(*label);
                            let set = self.hub.creds.is_set(key);
                            let entry = self.edits.entry(key).or_insert_with(|| {
                                if *secret { String::new() } else { self.hub.creds.get(key).unwrap_or_default() }
                            });
                            let hint = if *secret && set { "saved — type to replace" } else { "" };
                            ui.add(egui::TextEdit::singleline(entry).password(*secret).hint_text(hint).desired_width(320.0));
                            ui.label(if set { RichText::new("✔ saved").color(OK) } else { RichText::new("not set").color(WARN) });
                            ui.end_row();
                        }
                    });
                    ui.add_space(6.0);
                    ui.horizontal(|ui| {
                        if ui.add_enabled(self.busy.is_none(), egui::Button::new("Save & reconnect")).clicked() {
                            let updates: Vec<(String, String)> = FIELDS
                                .iter()
                                .filter(|f| f.0 == broker)
                                .filter_map(|f| self.edits.get(f.1).map(|v| (f.1.to_string(), v.clone())))
                                .collect();
                            self.notice = Some(match self.hub.creds.set_many(&updates) {
                                Ok(0) => (true, "Nothing changed.".into()),
                                Ok(k) => (true, format!("{broker}: saved {k} field(s) — reconnecting now.")),
                                Err(e) => (false, e),
                            });
                            for f in FIELDS.iter().filter(|f| f.0 == broker && f.3) {
                                self.edits.insert(f.1, String::new());
                            }
                        }
                        if broker == "nubra" {
                            if let Some(nb) = self.hub.nubra.clone() {
                                if ui.add_enabled(self.busy.is_none(), egui::Button::new("Test login")).clicked() {
                                    self.spawn("nubra-test", async move { nb.test_login().await.map(|_| "Nubra login OK.".into()) });
                                }
                            }
                        }
                    });

                    if broker == "nubra" {
                        if let Some(nb) = self.hub.nubra.clone() {
                            ui.add_space(8.0);
                            ui.label(RichText::new("One-time OTP (once per computer — after this, login needs only the MPIN)").color(MUTED).small());
                            ui.horizontal(|ui| {
                                let nb1 = nb.clone();
                                if ui.add_enabled(self.busy.is_none(), egui::Button::new("Send OTP")).clicked() {
                                    self.spawn("nubra-otp", async move { nb1.send_otp().await.map(|to| format!("OTP sent to {to}. Enter it and press Verify.")) });
                                }
                                ui.add(egui::TextEdit::singleline(&mut self.otp).hint_text("OTP from SMS").desired_width(120.0));
                                if ui.add_enabled(self.busy.is_none() && !self.otp.trim().is_empty(), egui::Button::new("Verify")).clicked() {
                                    let code = std::mem::take(&mut self.otp);
                                    self.spawn("nubra-verify", async move {
                                        nb.verify_otp(&code).await.map(|_| "Nubra logged in. Device login saved — no OTP needed from now on.".into())
                                    });
                                }
                                if let Some(what) = self.busy {
                                    ui.spinner();
                                    ui.label(RichText::new(what).color(MUTED).small());
                                }
                            });
                        }
                    }
                });
                ui.add_space(10.0);
            }
        });
    }

    fn logs(&self, ui: &mut egui::Ui) {
        let lines: Vec<String> = self.hub.logs.lock().iter().cloned().collect();
        egui::ScrollArea::vertical().auto_shrink([false; 2]).stick_to_bottom(true).show(ui, |ui| {
            for l in lines {
                let color = if l.contains("ERROR") { BAD } else if l.contains(" WARN ") { WARN } else { Color32::LIGHT_GRAY };
                ui.label(RichText::new(l).monospace().size(12.0).color(color));
            }
        });
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _: &mut eframe::Frame) {
        if self.stats_at.elapsed() >= Duration::from_secs(1) {
            self.stats = api::stats_json(&self.hub.state);
            self.stats_at = Instant::now();
        }
        self.poll_task();

        egui::TopBottomPanel::top("top").show(ctx, |ui| {
            ui.add_space(6.0);
            self.header(ui);
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.selectable_value(&mut self.tab, Tab::Overview, "Overview");
                ui.selectable_value(&mut self.tab, Tab::Brokers, "Brokers & credentials");
                ui.selectable_value(&mut self.tab, Tab::Logs, "Logs");
            });
            ui.add_space(4.0);
        });
        egui::CentralPanel::default().show(ctx, |ui| match self.tab {
            Tab::Overview => self.overview(ui),
            Tab::Brokers => self.brokers(ui),
            Tab::Logs => self.logs(ui),
        });

        ctx.request_repaint_after(if self.busy.is_some() { Duration::from_millis(150) } else { Duration::from_millis(500) });
    }
}
