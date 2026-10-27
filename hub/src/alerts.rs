//! Telegram alerts: a message when MarketHub starts (so restarts and crashes are
//! visible), when a broker has not been OK for 3 minutes (down, or waiting for
//! you, e.g. Nubra needing an OTP), and when it is OK again.
//! Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env; without them it stays quiet.

use crate::api::AppState;
use crate::brokers::nubra::Nubra;
use crate::console::{self, Level};
use crate::creds::CredStore;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

const ALERT_AFTER: Duration = Duration::from_secs(180);
const CHECK_EVERY: Duration = Duration::from_secs(10);

pub async fn run(state: AppState, creds: Arc<CredStore>, nubra: Option<Arc<Nubra>>) {
    let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().expect("http client");
    let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "server".into());
    let mut bad_since: HashMap<String, Instant> = HashMap::new();
    let mut alerted: HashSet<String> = HashSet::new();
    let mut started_sent = false;
    let mut tick = tokio::time::interval(CHECK_EVERY);
    loop {
        tick.tick().await;
        let (Some(bot), Some(chat)) = (creds.get("TELEGRAM_BOT_TOKEN"), creds.get("TELEGRAM_CHAT_ID")) else {
            continue;
        };
        if !started_sent {
            started_sent = send(&http, &bot, &chat, &format!("🟢 MarketHub started on {host}")).await;
        }
        for (text, level) in console::states(&state, &creds, &nubra) {
            let broker = text.split(':').next().unwrap_or(&text).to_string();
            if level == Level::Up {
                bad_since.remove(&broker);
                if alerted.contains(&broker) && send(&http, &bot, &chat, &format!("🟢 {text}")).await {
                    alerted.remove(&broker);
                }
                continue;
            }
            let since = *bad_since.entry(broker.clone()).or_insert_with(Instant::now);
            if since.elapsed() >= ALERT_AFTER && !alerted.contains(&broker) {
                let icon = if level == Level::Down { "🔴" } else { "🟡" };
                let mins = since.elapsed().as_secs() / 60;
                if send(&http, &bot, &chat, &format!("{icon} {text} (for {mins} min) on {host}")).await {
                    alerted.insert(broker);
                }
            }
        }
    }
}

/// True when Telegram accepted the message; otherwise it is retried on the next check.
async fn send(http: &reqwest::Client, bot: &str, chat: &str, text: &str) -> bool {
    let res = http
        .post(format!("https://api.telegram.org/bot{bot}/sendMessage"))
        .json(&serde_json::json!({"chat_id": chat, "text": text}))
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => true,
        Ok(r) => {
            tracing::warn!(status = %r.status(), "telegram refused the alert (check TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
            false
        }
        Err(e) => {
            // without_url: the URL holds the bot token, which must not reach the log.
            tracing::warn!(error = %e.without_url(), "could not reach telegram");
            false
        }
    }
}
