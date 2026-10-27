//! Local-only endpoints for the server build, which has no window: Nubra's
//! one-time OTP login and saving broker fields (used by "Nubra Login.bat").
//! Requests from any other machine are refused, even if `bind` is opened up,
//! and so are requests relayed by a proxy here (Caddy, a Cloudflare Tunnel).
//!
//!   POST /admin/creds          {"NUBRA_PHONE": "...", "NUBRA_MPIN": "..."}
//!   GET  /admin/nubra/status
//!   POST /admin/nubra/send-otp
//!   POST /admin/nubra/verify   {"otp": "123456"}
//!   POST /admin/nubra/test

use crate::brokers::nubra::Nubra;
use crate::creds::CredStore;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

#[derive(Clone)]
struct Admin {
    creds: Arc<CredStore>,
    nubra: Option<Arc<Nubra>>,
}

pub fn router(creds: Arc<CredStore>, nubra: Option<Arc<Nubra>>) -> Router {
    Router::new()
        .route("/admin/creds", post(save_creds))
        .route("/admin/nubra/status", get(nubra_status))
        .route("/admin/nubra/send-otp", post(send_otp))
        .route("/admin/nubra/verify", post(verify))
        .route("/admin/nubra/test", post(test))
        .with_state(Admin { creds, nubra })
        .layer(middleware::from_fn(local_only))
}

async fn local_only(ConnectInfo(addr): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    if !crate::api::is_local(addr, req.headers()) {
        return (StatusCode::FORBIDDEN, "admin endpoints work only on the hub machine itself").into_response();
    }
    next.run(req).await
}

fn reply(r: Result<String, String>) -> Response {
    match r {
        Ok(message) => Json(json!({"ok": true, "message": message})).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": error}))).into_response(),
    }
}

fn nubra(a: &Admin) -> Result<Arc<Nubra>, String> {
    a.nubra.clone().ok_or_else(|| "Nubra is disabled in config.toml".to_string())
}

async fn save_creds(State(a): State<Admin>, Json(body): Json<HashMap<String, String>>) -> Response {
    let updates: Vec<(String, String)> = body.into_iter().collect();
    reply(a.creds.set_many(&updates).map(|n| format!("saved {n} field(s)")))
}

async fn nubra_status(State(a): State<Admin>) -> Response {
    reply(nubra(&a).map(|n| n.status.read().clone()))
}

async fn send_otp(State(a): State<Admin>) -> Response {
    let r = match nubra(&a) {
        Ok(n) => n.send_otp().await.map(|to| format!("OTP sent to {to}")),
        Err(e) => Err(e),
    };
    reply(r)
}

#[derive(Deserialize)]
struct Otp {
    otp: String,
}

async fn verify(State(a): State<Admin>, Json(b): Json<Otp>) -> Response {
    let r = match nubra(&a) {
        Ok(n) => n.verify_otp(&b.otp).await.map(|_| "Nubra logged in. Device login saved: MPIN only from now on".to_string()),
        Err(e) => Err(e),
    };
    reply(r)
}

async fn test(State(a): State<Admin>) -> Response {
    let r = match nubra(&a) {
        Ok(n) => n.test_login().await.map(|_| "Nubra login OK".to_string()),
        Err(e) => Err(e),
    };
    reply(r)
}
