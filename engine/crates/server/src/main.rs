//! QuantHaHa API 服务：REST + WebSocket。
//!
//! 端点：
//!   GET  /api/klines?symbol=BTCUSDT&interval=1h&days=365
//!   GET  /api/factors?symbol=&interval=&days=&period=14
//!   POST /api/backtest      { symbol, interval, days, spec }
//!   POST /api/evolve        { symbol, interval, days, config? }   (长任务，返回任务id)
//!   GET  /api/evolve/status
//!   GET  /api/champion
//!   GET  /ws                实时行情 + 进化进度推送

mod state;
mod routes;

use axum::routing::{get, post};
use axum::Router;
use state::AppState;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,server=debug".into()),
        )
        .init();

    let data_dir = std::env::var("QHH_DATA_DIR").unwrap_or_else(|_| "data".into());
    let state = Arc::new(AppState::new(&data_dir)?);

    // 启动实时行情流（默认主流币）
    state.start_market_stream(vec![
        "BTCUSDT".into(),
        "ETHUSDT".into(),
        "SOLUSDT".into(),
    ]);

    let app = Router::new()
        .route("/api/health", get(routes::health))
        .route("/api/klines", get(routes::klines))
        .route("/api/factors", get(routes::factors))
        .route("/api/backtest", post(routes::backtest))
        .route("/api/evolve", post(routes::evolve_start))
        .route("/api/evolve/status", get(routes::evolve_status))
        .route("/api/champion", get(routes::champion))
        .route("/ws", get(routes::ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = "0.0.0.0:8787";
    tracing::info!("listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
