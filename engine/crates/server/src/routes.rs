//! HTTP / WS 路由处理。

use crate::state::{now_ms, AppState, EvolveStatus};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use qbacktest::CostModel;
use qcore::Interval;
use qevolve::EvolveConfig;
use qstrategy::StrategySpec;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

type AppResult<T> = Result<T, (StatusCode, String)>;

fn bad(msg: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, msg.to_string())
}
fn internal(e: impl ToString) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

pub async fn health() -> impl IntoResponse {
    Json(json!({"ok": true, "ts": now_ms()}))
}

fn env_f64(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// 按资产类别返回（每年bar数, 成本模型）。
/// 加密 24/7：365.25 天年化，taker 费率；股票/ETF：252 交易日年化，低佣金+滑点。
pub fn market_params(symbol: &str, interval: Interval) -> (f64, CostModel) {
    if qdata::is_crypto(symbol) {
        (
            (365.25 * 86_400_000.0) / interval.millis() as f64,
            CostModel {
                fee_rate: 0.001,
                slippage: 0.0005,
                ..Default::default()
            },
        )
    } else {
        let bars_per_trading_day = match interval {
            Interval::D1 => 1.0,
            Interval::H4 => 1.625,
            Interval::H1 => 6.5,
            Interval::M15 => 26.0,
            Interval::M5 => 78.0,
            Interval::M1 => 390.0,
        };
        // 股票默认按 moomoo 美股口径：零佣金零平台费，仅卖出侧监管费
        // (SEC ~0.0000278 + FINRA TAF) ≈ 单边均摊 0.2bp；滑点 3bp 保守
        // 可用 QHH_STOCK_FEE / QHH_STOCK_SLIPPAGE 覆盖
        (
            252.0 * bars_per_trading_day,
            CostModel {
                fee_rate: env_f64("QHH_STOCK_FEE", 0.00002),
                slippage: env_f64("QHH_STOCK_SLIPPAGE", 0.0003),
                ..Default::default()
            },
        )
    }
}

#[derive(Deserialize)]
pub struct KlineQuery {
    symbol: String,
    #[serde(default = "default_interval")]
    interval: String,
    #[serde(default = "default_days")]
    days: i64,
}
fn default_interval() -> String {
    "1h".into()
}
fn default_days() -> i64 {
    365
}

async fn load_klines(
    state: &AppState,
    q: &KlineQuery,
) -> AppResult<(Vec<qcore::Kline>, Interval)> {
    let interval = Interval::parse(&q.interval).ok_or_else(|| bad("bad interval"))?;
    let end = now_ms();
    let start = end - q.days * 86_400_000;
    let klines = state
        .store
        .get(&q.symbol.to_uppercase(), interval, start, end)
        .await
        .map_err(internal)?;
    Ok((klines, interval))
}

pub async fn klines(
    State(state): State<Arc<AppState>>,
    Query(q): Query<KlineQuery>,
) -> AppResult<impl IntoResponse> {
    let (klines, _) = load_klines(&state, &q).await?;
    Ok(Json(klines))
}

// 注意：axum Query + serde(flatten) 对数字字段会 400（serde_urlencoded 限制），
// 必须平铺字段
#[derive(Deserialize)]
pub struct FactorQuery {
    symbol: String,
    #[serde(default = "default_interval")]
    interval: String,
    #[serde(default = "default_days")]
    days: i64,
    #[serde(default = "default_period")]
    period: usize,
}
fn default_period() -> usize {
    14
}

pub async fn factors(
    State(state): State<Arc<AppState>>,
    Query(q): Query<FactorQuery>,
) -> AppResult<impl IntoResponse> {
    let base = KlineQuery {
        symbol: q.symbol.clone(),
        interval: q.interval.clone(),
        days: q.days,
    };
    let (klines, _) = load_klines(&state, &base).await?;
    let times: Vec<i64> = klines.iter().map(|k| k.open_time).collect();
    let mut out = serde_json::Map::new();
    out.insert("times".into(), json!(times));
    for kind in qfactors::ALL_FACTORS {
        let vals = qfactors::compute(kind, q.period, &klines);
        // NaN → null
        let vals: Vec<Option<f64>> = vals
            .iter()
            .map(|v| if v.is_nan() { None } else { Some(*v) })
            .collect();
        out.insert(
            serde_json::to_value(kind).unwrap().as_str().unwrap().to_string(),
            json!(vals),
        );
    }
    Ok(Json(serde_json::Value::Object(out)))
}

#[derive(Deserialize)]
pub struct BacktestReq {
    symbol: String,
    #[serde(default = "default_interval")]
    interval: String,
    #[serde(default = "default_days")]
    days: i64,
    spec: StrategySpec,
    /// 自定义成本模型（缺省用资产类别默认值）
    #[serde(default)]
    cost: Option<CostModel>,
}

pub async fn backtest(
    State(state): State<Arc<AppState>>,
    Json(req): Json<BacktestReq>,
) -> AppResult<impl IntoResponse> {
    let q = KlineQuery {
        symbol: req.symbol,
        interval: req.interval,
        days: req.days,
    };
    let (klines, interval) = load_klines(&state, &q).await?;
    if klines.len() < 300 {
        return Err(bad("not enough data"));
    }
    let (bars_per_year, default_cost) = market_params(&q.symbol, interval);
    let cost = req.cost.unwrap_or(default_cost);
    let targets = req.spec.signals(&klines);
    let sigs = qbacktest::to_signals(&klines, &targets);
    let result = qbacktest::run(&klines, &sigs, cost, bars_per_year, 1);
    // 等距抽样资金曲线，最多2000点，避免巨大payload
    let step = (result.equity.len() / 2000).max(1);
    let equity: Vec<_> = result.equity.iter().step_by(step).collect();
    Ok(Json(json!({
        "metrics": result.metrics,
        "equity": equity,
    })))
}

#[derive(Deserialize)]
pub struct EvolveReq {
    symbol: String,
    #[serde(default = "default_interval")]
    interval: String,
    #[serde(default = "default_days")]
    days: i64,
    #[serde(default)]
    config: Option<EvolveConfig>,
}

pub async fn evolve_start(
    State(state): State<Arc<AppState>>,
    Json(req): Json<EvolveReq>,
) -> AppResult<impl IntoResponse> {
    {
        let st = state.evolve_status.lock().unwrap();
        if matches!(*st, EvolveStatus::Running { .. }) {
            return Err(bad("evolve already running"));
        }
    }
    let q = KlineQuery {
        symbol: req.symbol.clone(),
        interval: req.interval.clone(),
        days: req.days,
    };
    let (klines, interval) = load_klines(&state, &q).await?;
    let (bars_per_year, cost) = market_params(&q.symbol, interval);
    let explicit_cfg = req.config.is_some();
    let mut cfg = req.config.unwrap_or_default();
    cfg.bars_per_year = bars_per_year;
    if !explicit_cfg {
        cfg.cost = cost;
    }

    // CPU 密集型任务放 blocking 线程，不阻塞 tokio
    crate::state::launch_evolve(
        state.clone(),
        req.symbol.to_uppercase(),
        req.interval.clone(),
        klines,
        cfg,
    );

    Ok(Json(json!({"started": true})))
}

pub async fn evolve_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let st = state.evolve_status.lock().unwrap().clone();
    Json(st)
}

pub async fn champion(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let champs = state.champions.lock().unwrap().clone();
    Json(champs)
}

pub async fn paper(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let sessions = state.paper.lock().unwrap().clone();
    Json(json!({"active": !sessions.is_empty(), "sessions": sessions}))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
}

pub async fn search(Query(q): Query<SearchQuery>) -> AppResult<impl IntoResponse> {
    if q.q.trim().len() < 2 {
        return Ok(Json(json!([])));
    }
    let hits = qdata::YahooClient::new()
        .search(q.q.trim())
        .await
        .map_err(internal)?;
    Ok(Json(serde_json::to_value(hits).map_err(internal)?))
}

pub async fn plan(State(state): State<Arc<AppState>>) -> AppResult<impl IntoResponse> {
    let plans = crate::plan::build_plans(&state).await.map_err(internal)?;
    Ok(Json(plans))
}

pub async fn sectors(State(state): State<Arc<AppState>>) -> AppResult<impl IntoResponse> {
    // 10分钟内存缓存：板块报告要打几十个 Yahoo 请求
    {
        let cache = state.sector_cache.lock().unwrap();
        if let Some((ts, val)) = cache.as_ref() {
            if now_ms() - ts < crate::sectors::CACHE_TTL_MS {
                return Ok(Json(val.clone()));
            }
        }
    }
    let report = crate::sectors::build_report(&state).await.map_err(internal)?;
    let val = serde_json::to_value(&report).map_err(internal)?;
    *state.sector_cache.lock().unwrap() = Some((now_ms(), val.clone()));
    Ok(Json(val))
}

pub async fn ws_handler(
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_loop(socket, state))
}

async fn ws_loop(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.ws_tx.subscribe();
    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(m) => {
                        let Ok(text) = serde_json::to_string(&m) else { continue };
                        if socket.send(Message::Text(text)).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
}
