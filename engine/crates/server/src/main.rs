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

mod paper;
mod routes;
mod sectors;
mod state;

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

    // 自动再训练调度器：每 QHH_AUTORETRAIN_HOURS 小时（默认 6，0=关闭）
    // 用最新数据重跑 walk-forward 进化，冠军仅在留出集胜出时热更新
    spawn_auto_retrain(state.clone());

    // 实时模拟盘：冠军策略接实时行情，mark-to-market + 周期调仓
    paper::start_paper_engine(state.clone());

    let app = Router::new()
        .route("/api/health", get(routes::health))
        .route("/api/klines", get(routes::klines))
        .route("/api/factors", get(routes::factors))
        .route("/api/backtest", post(routes::backtest))
        .route("/api/evolve", post(routes::evolve_start))
        .route("/api/evolve/status", get(routes::evolve_status))
        .route("/api/champion", get(routes::champion))
        .route("/api/paper", get(routes::paper))
        .route("/api/sectors", get(routes::sectors))
        .route("/ws", get(routes::ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = "0.0.0.0:8787";
    tracing::info!("listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn spawn_auto_retrain(state: Arc<AppState>) {
    let hours: u64 = std::env::var("QHH_AUTORETRAIN_HOURS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(6);
    if hours == 0 {
        tracing::info!("auto-retrain disabled");
        return;
    }
    let symbol = std::env::var("QHH_AUTORETRAIN_SYMBOL").unwrap_or_else(|_| "BTCUSDT".into());
    let interval_s = std::env::var("QHH_AUTORETRAIN_INTERVAL").unwrap_or_else(|_| "4h".into());
    let days: i64 = std::env::var("QHH_AUTORETRAIN_DAYS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(730);

    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(hours * 3600));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await; // 第一次立即触发的 tick 跳过，等满一个周期
        loop {
            tick.tick().await;
            if matches!(
                *state.evolve_status.lock().unwrap(),
                state::EvolveStatus::Running { .. }
            ) {
                tracing::info!("auto-retrain skipped: evolve already running");
                continue;
            }
            let Some(interval) = qcore::Interval::parse(&interval_s) else {
                tracing::error!(interval_s, "auto-retrain: bad interval");
                return;
            };
            let end = state::now_ms();
            let start = end - days * 86_400_000;
            match state.store.get(&symbol, interval, start, end).await {
                Ok(klines) => {
                    let mut cfg = auto_cfg_for(interval);
                    let (bpy, cost) = routes::market_params(&symbol, interval);
                    cfg.bars_per_year = bpy;
                    cfg.cost = cost;
                    tracing::info!(symbol, interval_s, bars = klines.len(), "auto-retrain starting");
                    state::launch_evolve(
                        state.clone(),
                        symbol.clone(),
                        interval_s.clone(),
                        klines,
                        cfg,
                    );
                }
                Err(e) => tracing::error!(error = %e, "auto-retrain: data fetch failed"),
            }
        }
    });
}

/// 按周期自适应的窗口配置：训练≈1年、验证≈3个月、留出≈1.5个月
fn auto_cfg_for(interval: qcore::Interval) -> qevolve::EvolveConfig {
    let bars_per_day = 86_400_000 / interval.millis();
    qevolve::EvolveConfig {
        train_bars: (bars_per_day * 365) as usize,
        valid_bars: (bars_per_day * 90) as usize,
        holdout_bars: (bars_per_day * 45) as usize,
        ..Default::default()
    }
}
