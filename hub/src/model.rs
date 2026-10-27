use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::fmt;

/// Broker-independent instrument id: `<SEGMENT>:<exchange token>`, e.g. `NSE_EQ:2885`,
/// `MCX_FO:573422`, `SIM:1`. Exchange tokens are identical across brokers.
#[derive(Clone, Debug, Hash, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct InstrumentId(pub String);

impl InstrumentId {
    pub fn parse(s: &str) -> Option<Self> {
        let (seg, tok) = s.split_once(':')?;
        (!seg.is_empty() && !tok.is_empty()).then(|| Self(s.to_string()))
    }
    pub fn segment(&self) -> &str {
        self.0.split_once(':').map(|(s, _)| s).unwrap_or("")
    }
    pub fn token(&self) -> &str {
        self.0.split_once(':').map(|(_, t)| t).unwrap_or("")
    }
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Interval {
    M1,
    M3,
    M5,
    M15,
    M30,
    M60,
    D1,
}

impl Interval {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "1m" => Self::M1,
            "3m" => Self::M3,
            "5m" => Self::M5,
            "15m" => Self::M15,
            "30m" => Self::M30,
            "60m" | "1h" => Self::M60,
            "1d" | "D" => Self::D1,
            _ => return None,
        })
    }
    pub fn minutes(self) -> u32 {
        match self {
            Self::M1 => 1,
            Self::M3 => 3,
            Self::M5 => 5,
            Self::M15 => 15,
            Self::M30 => 30,
            Self::M60 => 60,
            Self::D1 => 375,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::M1 => "1m",
            Self::M3 => "3m",
            Self::M5 => "5m",
            Self::M15 => "15m",
            Self::M30 => "30m",
            Self::M60 => "60m",
            Self::D1 => "1d",
        }
    }
}

/// `[epoch_seconds, open, high, low, close, volume]`, serialized as a compact array.
pub type Candle = (i64, f64, f64, f64, f64, f64);

/// The unit of history work: one instrument, one interval, one trading day.
/// Every user request is cut into these, so overlapping requests share pieces.
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct PieceKey {
    pub id: InstrumentId,
    pub interval: Interval,
    pub day: NaiveDate,
}

impl fmt::Display for PieceKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}|{}|{}", self.id.0, self.interval.as_str(), self.day)
    }
}

#[derive(Clone, Debug)]
pub struct Tick {
    pub id: InstrumentId,
    pub ltp: f64,
    /// Traded quantity today (cumulative), when the feed sends it.
    pub volume: Option<f64>,
    /// Best bid / ask, when the feed sends them.
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub ts_ms: i64,
    pub src: &'static str,
    /// The broker repeating its last known state (Shoonya's reply to a subscribe),
    /// not a new update from the exchange: outside market hours it is yesterday's price.
    pub replay: bool,
}
