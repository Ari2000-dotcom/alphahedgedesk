//! Broker credentials, encrypted on disk (DPAPI) and changeable while running.
//!
//! Brokers read their credentials from here at the moment they need them, and
//! watch `subscribe()` so a save reconnects them straight away, no restart.
//! On first start the values are imported once from the old `.env` file.

use crate::secure_store;
use parking_lot::RwLock;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::watch;

/// (broker, key, label, secret). Secrets are never shown again once saved.
pub const FIELDS: &[(&str, &str, &str, bool)] = &[
    ("kotak", "NEO_CONSUMER_KEY", "Consumer key", true),
    ("nubra", "NUBRA_PHONE", "Mobile number", false),
    ("nubra", "NUBRA_MPIN", "MPIN", true),
    ("nubra", "NUBRA_TOTP_SECRET", "TOTP secret (optional)", true),
    ("shoonya", "SHOONYA_UID", "User id", false),
    ("shoonya", "SHOONYA_PASSWORD", "Password", true),
    ("shoonya", "SHOONYA_TOTP_SECRET", "TOTP secret (base32, ~32 chars)", true),
    ("shoonya", "SHOONYA_CLIENT_ID", "Client id (e.g. FA12345_U)", false),
    ("shoonya", "SHOONYA_API_SECRET", "API secret", true),
    ("shoonya", "SHOONYA_ACCESS_TOKEN", "Access token (filled by login)", true),
    ("shoonya", "SHOONYA_ACTID", "Account id (filled by login)", false),
    ("alerts", "TELEGRAM_BOT_TOKEN", "Telegram bot token", true),
    ("alerts", "TELEGRAM_CHAT_ID", "Telegram chat id", false),
];

/// Other names a .env may use for a field (Shoonya's docs say SHOONYA_USER_ID).
fn canonical(key: String) -> String {
    match key.as_str() {
        "SHOONYA_USER_ID" => "SHOONYA_UID".to_string(),
        _ => key,
    }
}

pub struct CredStore {
    path: PathBuf,
    map: RwLock<BTreeMap<String, String>>,
    version: watch::Sender<u64>,
}

impl CredStore {
    pub fn open(path: PathBuf, import_from: &Path) -> Arc<Self> {
        let mut map: BTreeMap<String, String> = BTreeMap::new();
        let mut imported = false;
        if let Ok(sealed) = std::fs::read(&path) {
            match secure_store::unprotect(&sealed).ok().and_then(|p| serde_json::from_slice(&p).ok()) {
                Some(m) => map = m,
                None => tracing::warn!(file = %path.display(), "saved credentials could not be decrypted (another Windows user?); starting empty"),
            }
        }
        // Bring over fields the store doesn't have yet from the old .env file
        // (first start, or new fields added in a later version). Saved values always win.
        if let Ok(iter) = dotenvy::from_path_iter(import_from) {
            for (k, v) in iter.flatten().map(|(k, v)| (canonical(k), v)) {
                let v = v.trim().trim_matches(['\'', '"']).to_string();
                if FIELDS.iter().any(|f| f.1 == k) && !v.is_empty() && !map.contains_key(&k) {
                    map.insert(k, v);
                    imported = true;
                }
            }
        }
        let store = Arc::new(Self { path, map: RwLock::new(map), version: watch::channel(0).0 });
        if imported {
            tracing::info!(from = %import_from.display(), "imported credentials from .env into encrypted store");
            if let Err(e) = store.persist() {
                tracing::warn!(error = %e, "could not save imported credentials");
            }
        }
        store
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.map.read().get(key).filter(|v| !v.is_empty()).cloned()
    }

    pub fn is_set(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// Values of several keys at once, to tell whether a broker's own fields changed.
    pub fn snapshot(&self, keys: &[&str]) -> Vec<Option<String>> {
        keys.iter().map(|k| self.get(k)).collect()
    }

    /// Saves the given values (blank = leave unchanged) and wakes every broker.
    pub fn set_many(&self, updates: &[(String, String)]) -> Result<usize, String> {
        let mut n = 0;
        {
            let mut m = self.map.write();
            for (k, v) in updates {
                let v = v.trim();
                if v.is_empty() {
                    continue;
                }
                if !FIELDS.iter().any(|f| f.1 == k) {
                    return Err(format!("unknown field {k}"));
                }
                m.insert(k.clone(), v.to_string());
                n += 1;
            }
        }
        if n > 0 {
            self.persist()?;
            self.version.send_modify(|v| *v += 1);
            tracing::info!(fields = n, "credentials saved; reconnecting affected brokers");
        }
        Ok(n)
    }

    /// Headless mode: the .env file is the source of truth, so its values replace
    /// saved ones — except tokens the hub fills in itself, which .env only seeds.
    pub fn reload_env(&self, path: &Path) -> Result<usize, String> {
        const AUTO_FILLED: [&str; 2] = ["SHOONYA_ACCESS_TOKEN", "SHOONYA_ACTID"];
        let iter = dotenvy::from_path_iter(path).map_err(|e| e.to_string())?;
        let updates: Vec<(String, String)> = iter
            .flatten()
            .map(|(k, v)| (canonical(k), v.trim().trim_matches(['\'', '"']).to_string()))
            .filter(|(k, v)| {
                FIELDS.iter().any(|f| f.1 == k)
                    && !v.is_empty()
                    && self.get(k).as_deref() != Some(v.as_str())
                    && !(AUTO_FILLED.contains(&k.as_str()) && self.is_set(k))
            })
            .collect();
        self.set_many(&updates)
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.version.subscribe()
    }

    fn persist(&self) -> Result<(), String> {
        let plain = serde_json::to_vec(&*self.map.read()).map_err(|e| e.to_string())?;
        let sealed = secure_store::protect(&plain)?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        // Temp-then-rename: a crash mid-write never leaves half a file.
        let tmp = self.path.with_extension("bin.tmp");
        std::fs::write(&tmp, sealed).map_err(|e| e.to_string())?;
        // No DPAPI off Windows: at least keep the file readable by this user only.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}
