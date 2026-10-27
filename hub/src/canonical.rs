//! Canonical instrument names: one permanent, broker-independent name per
//! instrument. Users, the frontend and every topic use these; what a broker
//! calls the same thing (Shoonya's `NFO|43721`, ...) stays inside the hub.
//!
//! ```text
//! underlying / spot   nse:nifty            bse:sensex          nse:reliance
//! India VIX           nse:indiavix
//! future              mcx:crudeoil:2026-11-19:FUT
//! option              nse:nifty:2026-10-27:25000:CE
//! ```
//!
//! Same shape as QuantDesk's `market::identity` (`nifty:2026-09-29:23250:CE`)
//! with the market in front, because this hub spans NSE, BSE and MCX and some
//! names exist on two of them (BANKINDIA trades options on NSE and BSE).
//! Market and underlying are lowercase; FUT/CE/PE are uppercase; strikes are
//! printed without trailing zeros (25000, 207.5).

use chrono::NaiveDate;
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Market {
    Nse,
    Bse,
    Mcx,
}

impl Market {
    pub fn as_str(self) -> &'static str {
        match self {
            Market::Nse => "nse",
            Market::Bse => "bse",
            Market::Mcx => "mcx",
        }
    }

    fn parse(s: &str) -> Option<Market> {
        Some(match s {
            "nse" => Market::Nse,
            "bse" => Market::Bse,
            "mcx" => Market::Mcx,
            _ => return None,
        })
    }

    /// Where its options and futures trade, in the symbol files' naming.
    pub fn derivatives_exchange(self) -> &'static str {
        match self {
            Market::Nse => "NFO",
            Market::Bse => "BFO",
            Market::Mcx => "MCX",
        }
    }

    pub fn from_derivatives_exchange(exchange: &str) -> Option<Market> {
        Some(match exchange {
            "NFO" => Market::Nse,
            "BFO" => Market::Bse,
            "MCX" => Market::Mcx,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Right {
    Call,
    Put,
}

impl Right {
    pub fn as_str(self) -> &'static str {
        match self {
            Right::Call => "CE",
            Right::Put => "PE",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Canonical {
    /// The underlying itself: an index or stock spot (`nse:nifty`).
    Underlying { market: Market, name: String },
    Future { market: Market, name: String, expiry: NaiveDate },
    Option { market: Market, name: String, expiry: NaiveDate, strike: f64, right: Right },
}

/// A strike as printed in a canonical name: no trailing zeros.
pub fn strike_text(strike: f64) -> String {
    let s = format!("{strike:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

impl Canonical {
    pub fn market(&self) -> Market {
        match self {
            Canonical::Underlying { market, .. } | Canonical::Future { market, .. } | Canonical::Option { market, .. } => *market,
        }
    }

    /// The underlying's name in the symbol files' (uppercase) form.
    pub fn name_upper(&self) -> String {
        match self {
            Canonical::Underlying { name, .. } | Canonical::Future { name, .. } | Canonical::Option { name, .. } => name.to_ascii_uppercase(),
        }
    }

    pub fn parse(s: &str) -> Result<Canonical, String> {
        let parts: Vec<&str> = s.split(':').collect();
        let market = parts.first().and_then(|m| Market::parse(m)).ok_or_else(|| format!("`{s}`: must start with nse:, bse: or mcx:"))?;
        let name = parts.get(1).filter(|n| !n.is_empty()).ok_or_else(|| format!("`{s}`: no underlying name"))?;
        if name.chars().any(|c| c.is_ascii_uppercase()) {
            return Err(format!("`{s}`: underlying names are lowercase"));
        }
        let name = name.to_string();
        let expiry = |i: usize| -> Result<NaiveDate, String> {
            NaiveDate::parse_from_str(parts[i], "%Y-%m-%d").map_err(|_| format!("`{s}`: expiry must be YYYY-MM-DD"))
        };
        match parts.len() {
            2 => Ok(Canonical::Underlying { market, name }),
            4 if parts[3] == "FUT" => Ok(Canonical::Future { market, name, expiry: expiry(2)? }),
            5 => {
                let strike: f64 = parts[3].parse().map_err(|_| format!("`{s}`: bad strike"))?;
                let right = match parts[4] {
                    "CE" => Right::Call,
                    "PE" => Right::Put,
                    _ => return Err(format!("`{s}`: option type must be CE or PE")),
                };
                Ok(Canonical::Option { market, name, expiry: expiry(2)?, strike, right })
            }
            _ => Err(format!("`{s}`: use market:name, market:name:YYYY-MM-DD:FUT or market:name:YYYY-MM-DD:strike:CE|PE")),
        }
    }
}

impl fmt::Display for Canonical {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Canonical::Underlying { market, name } => write!(f, "{}:{name}", market.as_str()),
            Canonical::Future { market, name, expiry } => write!(f, "{}:{name}:{expiry}:FUT", market.as_str()),
            Canonical::Option { market, name, expiry, strike, right } => {
                write!(f, "{}:{name}:{expiry}:{}:{}", market.as_str(), strike_text(*strike), right.as_str())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        for s in ["nse:nifty", "bse:sensex", "nse:indiavix", "mcx:crudeoil:2026-11-19:FUT", "nse:nifty:2026-10-27:25000:CE", "nse:wipro:2026-11-26:207.5:PE"] {
            assert_eq!(Canonical::parse(s).unwrap().to_string(), s);
        }
    }

    #[test]
    fn rejects_bad_names() {
        for s in ["nifty", "NSE:nifty", "nse:NIFTY", "nse:nifty:2026-10-27", "nse:nifty:27-10-2026:FUT", "nse:nifty:2026-10-27:x:CE", "nse:nifty:2026-10-27:25000:XX"] {
            assert!(Canonical::parse(s).is_err(), "{s} should be rejected");
        }
    }

    #[test]
    fn strikes_print_without_trailing_zeros() {
        assert_eq!(strike_text(25000.0), "25000");
        assert_eq!(strike_text(207.5), "207.5");
        assert_eq!(strike_text(0.25), "0.25");
    }
}
