//! IST clock helpers for the daily schedule (pre-market login, list refresh).

use chrono::{DateTime, Datelike, Duration as ChronoDuration, FixedOffset, NaiveTime, TimeZone, Utc, Weekday};
use std::time::Duration;

pub fn ist() -> FixedOffset {
    FixedOffset::east_opt(19_800).expect("IST offset")
}

pub fn ist_now() -> DateTime<FixedOffset> {
    Utc::now().with_timezone(&ist())
}

/// Time until the next `hh:mm` IST on a weekday (markets are shut at weekends).
pub fn until_next_weekday(hour: u32, minute: u32) -> Duration {
    let now = ist_now();
    let at = NaiveTime::from_hms_opt(hour, minute, 0).expect("valid time");
    let mut day = now.date_naive();
    loop {
        let candidate = ist().from_local_datetime(&day.and_time(at)).single().expect("IST has no gaps");
        let weekday = !matches!(candidate.weekday(), Weekday::Sat | Weekday::Sun);
        if weekday && candidate > now {
            return (candidate - now).to_std().unwrap_or(Duration::from_secs(1));
        }
        day += ChronoDuration::days(1);
    }
}

/// Runs `job` every weekday at `hh:mm` IST, forever.
pub fn every_weekday_at<F, Fut>(hour: u32, minute: u32, name: &'static str, job: F)
where
    F: Fn() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(until_next_weekday(hour, minute)).await;
            tracing::info!(job = name, "scheduled pre-market job");
            job().await;
        }
    });
}
