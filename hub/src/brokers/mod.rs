pub mod kotak;
pub mod nubra;
pub mod shoonya;
pub mod sim;

use crate::model::{Candle, Interval, PieceKey};
use crate::ratelimit::Limiter;
use async_trait::async_trait;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone)]
pub enum FetchError {
    /// Broker said "too many requests"; optional Retry-After.
    RateLimited(Option<Duration>),
    /// Session/credentials problem: retrying the same call will not help.
    Auth(String),
    Other(String),
}

/// A broker that can serve history pieces. Live feeds are separate tasks
/// (see `live::FeedCmd`) because they are long-lived connections.
#[async_trait]
pub trait HistoryBroker: Send + Sync {
    fn name(&self) -> &'static str;
    fn limiter(&self) -> Arc<Limiter>;
    /// Whether this broker can serve the piece at all (segment, interval, depth).
    fn supports(&self, key: &PieceKey) -> bool;
    /// Fetch one piece (one instrument, one interval, one day).
    async fn fetch(&self, key: &PieceKey) -> Result<Vec<Candle>, FetchError>;

    /// How many instruments of one day one call can carry (Nubra: 8 per query).
    fn max_batch(&self) -> usize {
        1
    }

    /// Pieces of one day with the same group can share one call; `None` = never batched.
    fn batch_group(&self, _key: &PieceKey) -> Option<String> {
        None
    }

    /// Calendar days one call can cover for one instrument (Nubra: a query
    /// takes a date range). Above 1, several days of an instrument share a call.
    fn max_span_days(&self, _interval: Interval) -> i64 {
        1
    }

    /// Several pieces in one call: one day of instruments of one group, or
    /// several days of one instrument within `max_span_days` (never both at
    /// once). One result per key, in order.
    async fn fetch_batch(&self, keys: &[PieceKey]) -> Vec<Result<Vec<Candle>, FetchError>> {
        let mut out = Vec::with_capacity(keys.len());
        for k in keys {
            out.push(self.fetch(k).await);
        }
        out
    }
}
