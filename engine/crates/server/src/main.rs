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

mod mine_job;
mod optbt;
mod paper;
mod plan;
mod routes;
mod sectors;
mod state;
mod ta;
mod ta_stats;

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

    // 统计缓存预热：重启清空内存缓存后，后台先算好 1d 规则统计（~10s），
    // 避免技术分析页首开撞冷缓存
    {
        let st = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            // 1d 用户最常用先预热；1h 冷算 ~47s 也提前付掉
            for interval in ["1d", "1h"] {
                if let Ok(r) = ta_stats::compute(&st, interval).await {
                    if let Ok(val) = serde_json::to_value(&r) {
                        st.ta_stats_cache
                            .lock()
                            .unwrap()
                            .insert(interval.into(), (state::now_ms(), val));
                        tracing::info!(interval, "ta_stats cache warmed");
                    }
                }
            }
        });
    }

    // 交易计划预热：冷算要把全部冠军标的尾刷依次过 Yahoo 限频闸门（可达30s），
    // 启动时先付掉这笔钱，前端首开即中 SWR 缓存
    {
        let st = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            match plan::cached_plans(&st).await {
                Ok(p) => tracing::info!(slots = p.len(), "trade plans cache warmed"),
                Err(e) => tracing::warn!(error = %e, "trade plans warmup failed"),
            }
        });
    }

    // 因子面板重接口预热（factor_forecast / universe_plan 冷算 8-12s）
    {
        let st = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
            routes::warm_factor_caches(st).await;
        });
    }

    // 板块报告预热（冷算 ~20s，同样不让首个访问者扛）
    {
        let st = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            if st.sector_cache.lock().unwrap().is_some() {
                return;
            }
            match sectors::build_report(&st).await {
                Ok(report) => {
                    if let Ok(val) = serde_json::to_value(&report) {
                        *st.sector_cache.lock().unwrap() = Some((state::now_ms(), val));
                        tracing::info!("sector report cache warmed");
                    }
                }
                Err(e) => tracing::warn!(error = %e, "sector report warmup failed"),
            }
        });
    }

    // 自动扫描调度器：每 QHH_AUTOSWEEP_HOURS 小时全宇宙进化扫描（默认 24，0=关闭）
    {
        let st = state.clone();
        tokio::spawn(async move {
            let hours: u64 = std::env::var("QHH_AUTOSWEEP_HOURS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(24);
            if hours == 0 {
                return;
            }
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(hours * 3600)).await;
                let running = matches!(
                    *st.sweep_status.lock().unwrap(),
                    state::SweepStatus::Running { .. }
                );
                if running {
                    continue;
                }
                tracing::info!("auto-sweep starting (every {hours}h)");
                state::launch_sweep(
                    st.clone(),
                    routes::default_sweep_symbols(),
                    "1d".into(),
                    3650,
                );
            }
        });
    }

    // 自动再训练调度器：每 QHH_AUTORETRAIN_HOURS 小时（默认 6，0=关闭）
    // 用最新数据重跑 walk-forward 进化，冠军仅在留出集胜出时热更新
    spawn_auto_retrain(state.clone());

    // 实时模拟盘：冠军策略接实时行情，mark-to-market + 周期调仓
    paper::start_paper_engine(state.clone());

    // 美股盘中报价轮询：为有模拟盘会话的股票每15s合成 Trade 事件
    // （Yahoo 无免费 WS；复用 Market 事件管道驱动前端闪价与模拟盘 mark）
    spawn_stock_quote_poller(state.clone());

    let app = Router::new()
        .route("/api/health", get(routes::health))
        .route("/api/klines", get(routes::klines))
        .route("/api/factors", get(routes::factors))
        .route("/api/ta", get(routes::ta))
        .route("/api/ta/stats", get(routes::ta_stats))
        .route("/api/ta/modulation_check", get(routes::ta_modulation_check))
        .route("/api/backtest", post(routes::backtest))
        .route("/api/evolve", post(routes::evolve_start))
        .route("/api/evolve/status", get(routes::evolve_status))
        .route("/api/evolve_sweep", post(routes::evolve_sweep_start))
        .route("/api/evolve_sweep/status", get(routes::evolve_sweep_status))
        .route("/api/champion", get(routes::champion))
        .route("/api/paper", get(routes::paper))
        .route("/api/sectors", get(routes::sectors))
        .route("/api/plan", get(routes::plan))
        .route("/api/search", get(routes::search))
        .route("/api/portfolio", get(routes::portfolio))
        .route("/api/options_backtest", post(routes::options_backtest))
        .route("/api/mine", post(routes::mine_start))
        .route("/api/mine/status", get(routes::mine_status))
        .route("/api/factors_mined", get(routes::factors_mined))
        .route("/api/factor_strategy", post(routes::factor_strategy))
        .route("/api/factor_forecast", get(routes::factor_forecast))
        .route("/api/universe_plan", post(routes::universe_plan))
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

use paper::us_market_open;

fn spawn_stock_quote_poller(state: Arc<AppState>) {
    tokio::spawn(async move {
        let yahoo = qdata::YahooClient::new();
        // 60s：日线策略的盘中标记不需要更细粒度；41标的×400ms闸门≈17s，
        // 15s周期会让Yahoo配额永久饱和（曾致盘中持续限流）
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            if !us_market_open() {
                continue;
            }
            let mut symbols: Vec<String> = state
                .paper
                .lock()
                .unwrap()
                .values()
                .map(|s| s.symbol.clone())
                .filter(|s| !qdata::is_crypto(s))
                .collect();
            symbols.sort();
            symbols.dedup();
            for sym in symbols {
                match yahoo.last_price(&sym).await {
                    Ok((t, price)) => {
                        let time = if t > 0 { t } else { state::now_ms() };
                        let _ = state.ws_tx.send(state::WsMessage::Market(
                            qcore::MarketEvent::Trade {
                                symbol: sym,
                                time,
                                price,
                                qty: 0.0,
                                is_buyer_maker: false,
                            },
                        ));
                    }
                    Err(e) => tracing::debug!(sym, error = %e, "quote poll failed"),
                }
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
