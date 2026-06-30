//! A basic localhost control-API HTTP server.
//!
//! HilbertRaum ships its own renderer UI, so this is intentionally minimal — it is NOT the
//! old SPA host. It exposes: health/info, an Electron "ready" hook that closes the splash,
//! and the update status/check/apply hooks the loader's self-updater drives. No services,
//! no embedded SPA, no proxy — nothing from mac-mgmt. It binds loopback only.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use loader_core::lifecycle::AppHandle;
use loader_core::{kill_spinner, update, SpinnerHandle};

/// Everything the handlers need: the run's shared handles + a few facts. Cheap to clone
/// (all `Arc`/`Copy`), as axum clones it per request.
#[derive(Clone)]
pub struct ControlState {
    pub brand: &'static str,
    pub version: &'static str,
    pub drive_root: String,
    pub spinner: SpinnerHandle,
    pub updater: update::Handle,
    pub apply_requested: Arc<AtomicBool>,
    pub app: AppHandle,
}

pub fn router(state: ControlState) -> Router {
    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/info", get(info))
        .route("/api/ready", post(ready))
        .route("/api/update", get(update_status))
        .route("/api/update/check", post(update_check))
        .route("/api/update/apply", post(update_apply))
        .with_state(state)
}

async fn info(State(s): State<ControlState>) -> Json<Value> {
    let running = s.app.lock().unwrap().is_some();
    Json(json!({
        "brand": s.brand,
        "version": s.version,
        "drive_root": s.drive_root,
        "app_running": running,
        "update": serde_json::to_value(s.updater.status()).unwrap_or(Value::Null),
    }))
}

/// The app signals it has painted → close the splash. (HilbertRaum does not call this today;
/// the launcher also closes the splash on a short timer. Kept for an app that wants to.)
async fn ready(State(s): State<ControlState>) -> &'static str {
    kill_spinner(&s.spinner);
    "ok"
}

async fn update_status(State(s): State<ControlState>) -> Json<Value> {
    Json(serde_json::to_value(s.updater.status()).unwrap_or(Value::Null))
}

async fn update_check(State(s): State<ControlState>) -> &'static str {
    tokio::spawn(update::check_and_predownload(s.updater.clone()));
    "checking"
}

/// Request an apply and end the session: set the flag the lifecycle reads after the session,
/// then terminate Electron so `run_session`'s wait returns → Teardown + Apply run.
async fn update_apply(State(s): State<ControlState>) -> &'static str {
    s.apply_requested.store(true, Ordering::SeqCst);
    if let Some(child) = s.app.lock().unwrap().as_mut() {
        let _ = child.kill();
    }
    "applying"
}

/// Bind on loopback (an ephemeral port unless `port` is non-zero) and spawn the server on
/// the current tokio runtime. Returns the bound URL.
pub async fn serve(state: ControlState, port: u16) -> std::io::Result<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let url = format!("http://{}", listener.local_addr()?);
    let app = router(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(url)
}
