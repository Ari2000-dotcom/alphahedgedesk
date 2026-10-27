//! Kotak Neo history: `GET market-data/1.0/historical/details`, authenticated
//! with the consumer key only (no login session needed). No MCX history.

use super::{FetchError, HistoryBroker};
use crate::creds::CredStore;
use crate::model::{Candle, Interval, PieceKey};
use crate::ratelimit::{LimitSpec, Limiter};
use async_trait::async_trait;
use chrono::{DateTime, Local};
use std::sync::Arc;
use std::time::Duration;

const BASE: &str = "https://mis.kotaksecurities.com";

pub struct Kotak {
    client: reqwest::Client,
    /// The consumer key is read per call, so a key saved in the app works at once.
    creds: Arc<CredStore>,
    limiter: Arc<Limiter>,
}

impl Kotak {
    pub fn new(creds: Arc<CredStore>, limits: &LimitSpec) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .pool_max_idle_per_host(8)
                .build()
                .expect("http client"),
            creds,
            limiter: Limiter::new("kotak.history", limits),
        }
    }

    fn segment(seg: &str) -> Option<&'static str> {
        Some(match seg {
            "NSE_EQ" => "nse_cm",
            "NSE_FO" => "nse_fo",
            "BSE_EQ" => "bse_cm",
            "BSE_FO" => "bse_fo",
            _ => return None,
        })
    }

    /// Interval code and how many days back Kotak serves it (from their docs).
    fn interval(i: Interval) -> (&'static str, i64) {
        match i {
            Interval::M1 => ("1min", 30),
            Interval::M3 => ("3min", 30),
            Interval::M5 => ("5min", 30),
            Interval::M15 => ("15min", 60),
            Interval::M30 => ("30min", 90),
            Interval::M60 => ("60min", 90),
            Interval::D1 => ("D", 180),
        }
    }
}

#[async_trait]
impl HistoryBroker for Kotak {
    fn name(&self) -> &'static str {
        "kotak"
    }
    fn limiter(&self) -> Arc<Limiter> {
        self.limiter.clone()
    }
    fn supports(&self, key: &PieceKey) -> bool {
        let today = Local::now().date_naive();
        let (_, max_days) = Self::interval(key.interval);
        self.creds.is_set("NEO_CONSUMER_KEY")
            && Self::segment(key.id.segment()).is_some()
            && key.day <= today
            && (today - key.day).num_days() <= max_days
    }

    async fn fetch(&self, key: &PieceKey) -> Result<Vec<Candle>, FetchError> {
        let consumer_key = self.creds.get("NEO_CONSUMER_KEY").ok_or(FetchError::Auth("consumer key not set".into()))?;
        let seg = Self::segment(key.id.segment()).ok_or(FetchError::Other("segment".into()))?;
        let (iv, _) = Self::interval(key.interval);
        let day = key.day.format("%Y-%m-%d").to_string();
        let resp = self
            .client
            .get(format!("{BASE}/market-data/1.0/historical/details"))
            .header("Authorization", &consumer_key)
            .query(&[
                ("neosymbol", format!("{seg}|{}", key.id.token())),
                ("interval", iv.to_string()),
                ("fromdate", day.clone()),
                ("todate", day),
            ])
            .send()
            .await
            .map_err(|e| FetchError::Other(e.to_string()))?;

        let status = resp.status();
        if status.as_u16() == 429 {
            let retry = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .map(Duration::from_secs);
            return Err(FetchError::RateLimited(retry));
        }
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(FetchError::Auth(format!("HTTP {status}")));
        }
        let body: serde_json::Value = resp.json().await.map_err(|e| FetchError::Other(e.to_string()))?;
        if !status.is_success() {
            return Err(FetchError::Other(format!("HTTP {status}: {}", truncate(&body.to_string()))));
        }

        let rows = body["data"]["candles"].as_array().cloned().unwrap_or_default();
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let Some(a) = r.as_array() else { continue };
            let Some(ts) = a.first().and_then(|v| v.as_str()) else { continue };
            let Ok(t) = DateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S%z") else { continue };
            let n = |i: usize| a.get(i).and_then(|v| v.as_f64()).unwrap_or(0.0);
            out.push((t.timestamp(), n(1), n(2), n(3), n(4), n(5)));
        }
        Ok(out)
    }
}

fn truncate(s: &str) -> String {
    s.chars().take(200).collect()
}
