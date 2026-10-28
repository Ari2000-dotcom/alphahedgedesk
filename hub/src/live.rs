//! Live engine: one broker subscription per instrument, shared by every user.
//! Each update is encoded once and the same bytes go to all subscribers.
//!
//! Delivery is "latest value wins" (conflation): every user has a Mailbox that
//! holds at most one pending update per instrument. A new tick replaces the
//! one not yet sent, so a slow user never builds a backlog and never slows
//! anyone else; the user's single writer task sends whatever is newest.
//!
//! Locking: the topic table is only write-locked when an instrument is added
//! or removed. A tick takes a read lock on the table and the lock of its own
//! instrument only, so ticks on different instruments never wait for each other.
//!
//! Topics are named canonically (`quote:nse:nifty:2026-10-27:25000:CE`, see
//! canonical.rs); the broker's token is looked up once when the topic is
//! created and kept in a reverse map, so a tick (which arrives with the
//! broker's id) finds its topics directly. The raw form (`quote:NSE_EQ:26000`,
//! `quote:SIM:1`) still works.

use crate::canonical::Canonical;
use crate::instruments::Instruments;
use crate::model::{InstrumentId, Tick};
use axum::extract::ws::Utf8Bytes;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Notify};

/// How long a topic stays subscribed at the broker after its last watcher leaves,
/// so a quick reload doesn't churn the broker subscription.
const UNSUB_GRACE: Duration = Duration::from_secs(30);

/// Instruments the hub holds at the brokers at once, for everyone together. Each is one broker
/// subscription, shared by every user watching it, so this only bites when many people watch many
/// different things (a crowd opening option chains on dozens of underlyings). Past it a new
/// instrument is refused with a plain message; ones already held keep working and are shared.
const MAX_LIVE_TOPICS: usize = 3000;

pub enum FeedCmd {
    Sub(InstrumentId),
    Unsub(InstrumentId),
}

/// One user's pending live updates: at most one per instrument, newest wins.
pub struct Mailbox {
    pending: Mutex<HashMap<Arc<str>, Utf8Bytes>>,
    notify: Notify,
}

impl Mailbox {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { pending: Mutex::new(HashMap::new()), notify: Notify::new() })
    }

    /// Returns true when it replaced an update the user had not been sent yet.
    pub(crate) fn offer(&self, topic: &Arc<str>, msg: Utf8Bytes) -> bool {
        let mut p = self.pending.lock();
        let was_empty = p.is_empty();
        let replaced = p.insert(topic.clone(), msg).is_some();
        drop(p);
        if was_empty {
            // Stores a permit if the writer isn't waiting yet, so no wake-up is lost.
            self.notify.notify_one();
        }
        replaced
    }

    /// Resolves when there is something to send.
    pub async fn ready(&self) {
        self.notify.notified().await
    }

    /// Moves everything pending into `out` (which should be empty), reusing both maps.
    pub fn drain_into(&self, out: &mut HashMap<Arc<str>, Utf8Bytes>) {
        std::mem::swap(&mut *self.pending.lock(), out);
    }
}

struct TopicState {
    seq: u64,
    last: Option<Utf8Bytes>,
    subs: Vec<Arc<Mailbox>>,
}

struct Topic {
    name: Arc<str>,
    feed: &'static str,
    id: InstrumentId,
    state: Mutex<TopicState>,
}

#[derive(Default)]
pub struct LiveStats {
    pub published: AtomicU64,
    pub deliveries: AtomicU64,
    /// Updates replaced by a newer one before the user was sent them.
    pub conflated: AtomicU64,
}

#[derive(Serialize)]
struct QuoteMsg<'a> {
    t: &'static str,
    topic: &'a str,
    seq: u64,
    ltp: f64,
    v: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bid: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ask: Option<f64>,
    /// Open interest (a derivative leg only) and yesterday's close, for the OI profile.
    #[serde(skip_serializing_if = "Option::is_none")]
    oi: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    poi: Option<f64>,
    /// Only sent when true: the broker's last known state, not a live update.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    replay: bool,
    ts: i64,
    src: &'static str,
}

#[derive(Default)]
struct Topics {
    by_name: HashMap<String, Arc<Topic>>,
    /// Broker feed id (`NSE_FO:43721`) to the topics it feeds: a canonical and a
    /// raw topic for the same instrument share one broker subscription.
    by_feed: HashMap<String, Vec<Arc<Topic>>>,
}

pub struct LiveHub {
    topics: RwLock<Topics>,
    feeds: HashMap<&'static str, mpsc::UnboundedSender<FeedCmd>>,
    feed_up: RwLock<HashMap<&'static str, bool>>,
    instruments: Option<Arc<Instruments>>,
    pub stats: LiveStats,
}

impl LiveHub {
    pub fn new(feeds: HashMap<&'static str, mpsc::UnboundedSender<FeedCmd>>, instruments: Option<Arc<Instruments>>) -> Arc<Self> {
        Arc::new(Self {
            topics: RwLock::new(Topics::default()),
            feeds,
            feed_up: RwLock::new(HashMap::new()),
            instruments,
            stats: LiveStats::default(),
        })
    }

    /// Which live feed serves an instrument.
    fn route(&self, id: &InstrumentId) -> Option<&'static str> {
        let feed = match id.segment() {
            "SIM" => "sim",
            "MCX_FO" | "NSE_FO" | "BSE_FO" | "NSE_EQ" | "BSE_EQ" => "shoonya",
            _ => return None,
        };
        self.feeds.contains_key(feed).then_some(feed)
    }

    /// The broker feed id behind a topic: canonical names are looked up, raw ids used as they are.
    fn feed_id(&self, topic: &str) -> Result<InstrumentId, String> {
        let name = topic.strip_prefix("quote:").ok_or("topics start with quote:")?;
        if name.starts_with("nse:") || name.starts_with("bse:") || name.starts_with("mcx:") {
            let c = Canonical::parse(name)?;
            let inst = self.instruments.as_ref().ok_or("instrument lists are not available")?;
            let id = inst.resolve(&c)?;
            return InstrumentId::parse(&id).ok_or_else(|| format!("{c}: bad feed id {id}"));
        }
        InstrumentId::parse(name).ok_or_else(|| "unknown topic; use quote:nse:nifty or quote:<SEGMENT>:<token>".into())
    }

    /// Adds the mailbox as a watcher; returns the latest value so the user sees data immediately.
    pub fn subscribe(&self, topic: &str, mailbox: &Arc<Mailbox>) -> Result<Option<Utf8Bytes>, String> {
        if let Some(t) = self.topics.read().by_name.get(topic).cloned() {
            let mut st = t.state.lock();
            st.subs.push(mailbox.clone());
            return Ok(st.last.clone());
        }
        // Resolved before taking the write lock: it may read a chain from disk.
        let id = self.feed_id(topic)?;
        let feed = self.route(&id).ok_or("no live feed for this segment")?;
        let mut topics = self.topics.write();
        // Someone may have created it between the two locks.
        if let Some(t) = topics.by_name.get(topic) {
            let mut st = t.state.lock();
            st.subs.push(mailbox.clone());
            return Ok(st.last.clone());
        }
        if topics.by_name.len() >= MAX_LIVE_TOPICS {
            return Err("the hub is watching as many instruments as it can right now; try again in a minute".into());
        }
        if !topics.by_feed.contains_key(&id.0) {
            let _ = self.feeds[feed].send(FeedCmd::Sub(id.clone()));
        }
        let state = Mutex::new(TopicState { seq: 0, last: None, subs: vec![mailbox.clone()] });
        let t = Arc::new(Topic { name: Arc::from(topic), feed, id: id.clone(), state });
        topics.by_name.insert(topic.to_string(), t.clone());
        topics.by_feed.entry(id.0).or_default().push(t);
        Ok(None)
    }

    pub fn unsubscribe(self: &Arc<Self>, topic: &str, mailbox: &Arc<Mailbox>) {
        let Some(t) = self.topics.read().by_name.get(topic).cloned() else { return };
        let mut st = t.state.lock();
        st.subs.retain(|m| !Arc::ptr_eq(m, mailbox));
        if !st.subs.is_empty() {
            return;
        }
        drop(st);
        let hub = self.clone();
        let topic = topic.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(UNSUB_GRACE).await;
            let mut topics = hub.topics.write();
            let idle = topics.by_name.get(&topic).map(|t| t.state.lock().subs.is_empty()).unwrap_or(false);
            if !idle {
                return;
            }
            let t = topics.by_name.remove(&topic).unwrap();
            let last_for_feed = match topics.by_feed.get_mut(&t.id.0) {
                Some(v) => {
                    v.retain(|x| !Arc::ptr_eq(x, &t));
                    v.is_empty()
                }
                None => true,
            };
            if last_for_feed {
                topics.by_feed.remove(&t.id.0);
                let _ = hub.feeds[t.feed].send(FeedCmd::Unsub(t.id.clone()));
            }
        });
    }

    /// Encode once per topic, keep as latest, put the same bytes in every watcher's mailbox.
    pub fn publish(&self, tick: &Tick) {
        let Some(targets) = self.topics.read().by_feed.get(&tick.id.0).cloned() else { return };
        for t in targets {
            let mut st = t.state.lock();
            st.seq += 1;
            let msg = QuoteMsg {
                t: "q",
                topic: &t.name,
                seq: st.seq,
                ltp: tick.ltp,
                v: tick.volume,
                bid: tick.bid,
                ask: tick.ask,
                oi: tick.oi,
                poi: tick.prev_oi,
                replay: tick.replay,
                ts: tick.ts_ms,
                src: tick.src,
            };
            let bytes = Utf8Bytes::from(serde_json::to_string(&msg).unwrap());
            st.last = Some(bytes.clone());
            let mut replaced = 0u64;
            for m in &st.subs {
                replaced += m.offer(&t.name, bytes.clone()) as u64;
            }
            let n = st.subs.len() as u64;
            drop(st);
            self.stats.published.fetch_add(1, Ordering::Relaxed);
            self.stats.deliveries.fetch_add(n, Ordering::Relaxed);
            self.stats.conflated.fetch_add(replaced, Ordering::Relaxed);
        }
    }

    pub fn set_feed_status(&self, feed: &'static str, up: bool) {
        self.feed_up.write().insert(feed, up);
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let topics = self.topics.read();
        serde_json::json!({
            "topics": topics.by_name.len(),
            "broker_subscriptions": topics.by_feed.len(),
            "watchers": topics.by_name.values().map(|t| t.state.lock().subs.len()).sum::<usize>(),
            "published": self.stats.published.load(Ordering::Relaxed),
            "deliveries": self.stats.deliveries.load(Ordering::Relaxed),
            "conflated": self.stats.conflated.load(Ordering::Relaxed),
            "feeds": self.feeds.keys().map(|f| (f.to_string(), self.feed_up.read().get(f).copied().unwrap_or(*f == "sim"))).collect::<HashMap<_, _>>(),
        })
    }
}
