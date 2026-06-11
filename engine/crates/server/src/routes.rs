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
            Interval::Mon1 => 1.0 / 21.0,
            Interval::W1 => 0.2,
            Interval::D1 => 1.0,
            Interval::H4 => 1.625,
            Interval::H2 => 3.25,
            Interval::H1 => 6.5,
            Interval::M30 => 13.0,
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

/// 技术分析全集：权威指标 + 趋势 + 经典/冠军双层买卖点（默认拉 730 天保证 MA200 有值）。
pub async fn ta(
    State(state): State<Arc<AppState>>,
    Query(q): Query<KlineQuery>,
) -> AppResult<impl IntoResponse> {
    let (klines, interval) = load_klines(&state, &q).await?;
    if klines.len() < 300 {
        return Err(bad("not enough data"));
    }
    let key = crate::state::champ_key(&q.symbol.to_uppercase(), interval.as_binance());
    let champion = {
        let champs = state.champions.lock().unwrap();
        champs
            .get(&key)
            .and_then(|c| c.spec.clone())
            .map(|spec| (key.clone(), spec))
    };
    let resp = crate::ta::build(&klines, champion.as_ref().map(|(k, s)| (k.clone(), s)));
    Ok(Json(resp))
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
    // 周/月线全历史也只有几百根bar，门槛按周期放宽
    let min_bars = match interval {
        Interval::W1 | Interval::Mon1 => 100,
        _ => 300,
    };
    if klines.len() < min_bars {
        return Err(bad(format!(
            "数据不足：{} 根bar（需≥{}），请增大回看天数",
            klines.len(),
            min_bars
        )));
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

#[derive(Deserialize)]
pub struct SweepReq {
    /// 不传 = ta_stats 全宇宙 + 3 个加密币
    pub symbols: Option<Vec<String>>,
    #[serde(default = "default_interval_1d_sweep")]
    pub interval: String,
    #[serde(default = "default_sweep_days")]
    pub days: i64,
}
fn default_interval_1d_sweep() -> String {
    "1d".into()
}
fn default_sweep_days() -> i64 {
    3650
}

pub fn default_sweep_symbols() -> Vec<String> {
    let mut v: Vec<String> = crate::ta_stats::UNIVERSE.iter().map(|s| s.to_string()).collect();
    v.extend(["BTCUSDT", "ETHUSDT", "SOLUSDT"].map(String::from));
    v
}

/// 全宇宙进化扫描：顺序对每个标的跑 evolve（margin+floor 闸门晋升）
pub async fn evolve_sweep_start(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SweepReq>,
) -> AppResult<impl IntoResponse> {
    {
        let st = state.sweep_status.lock().unwrap();
        if matches!(*st, crate::state::SweepStatus::Running { .. }) {
            return Err(bad("sweep already running"));
        }
    }
    let symbols = req.symbols.unwrap_or_else(default_sweep_symbols);
    let total = symbols.len();
    crate::state::launch_sweep(state, symbols, req.interval, req.days);
    Ok(Json(json!({"started": true, "total": total})))
}

pub async fn evolve_sweep_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let st = state.sweep_status.lock().unwrap().clone();
    Json(st)
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
    const ALLOC_USD: f64 = 10_000.0; // 每槽名义资金（与 moomoo 桥接 ALLOC_USD 同口径）
    let sessions = state.paper.lock().unwrap().clone();
    let augmented: serde_json::Map<String, serde_json::Value> = sessions
        .iter()
        .map(|(k, s)| {
            let mut v = serde_json::to_value(s).unwrap_or(json!({}));
            // 建仓日期：当前方向的起点（最近一次从空仓/反向翻转建仓的时刻）
            let cur_sign = s.position.signum();
            let mut entry_ms = s.started_ms;
            if cur_sign != 0.0 {
                for t in s.trades.iter().rev() {
                    let to_sign = t.to_position.signum();
                    if to_sign != cur_sign {
                        break; // 更早的持仓方向不同，建仓点已确定
                    }
                    if t.from_position.abs() < 1e-9 || t.from_position.signum() != cur_sign {
                        entry_ms = t.time; // 从0或反向进入当前方向
                        break;
                    }
                    entry_ms = t.time; // 同向加减仓，继续向前找起点
                }
            }
            if let Some(obj) = v.as_object_mut() {
                obj.insert("entry_ms".into(), json!(entry_ms));
                obj.insert("alloc_usd".into(), json!(ALLOC_USD));
                // 整数股（向零取整，与 moomoo 桥接下单口径一致）
                let shares = if s.last_price > 0.0 {
                    (s.position * ALLOC_USD * s.equity / s.last_price).trunc()
                } else {
                    0.0
                };
                obj.insert("shares_equiv".into(), json!(shares));
                obj.insert(
                    "notional_usd".into(),
                    json!(s.position.abs() * ALLOC_USD * s.equity),
                );
            }
            (k.clone(), v)
        })
        .collect();
    Json(json!({"active": !augmented.is_empty(), "sessions": augmented}))
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

pub async fn portfolio(State(state): State<Arc<AppState>>) -> AppResult<impl IntoResponse> {
    let p = crate::plan::build_portfolio(&state).await.map_err(internal)?;
    Ok(Json(p))
}

#[derive(Deserialize)]
pub struct MineReq {
    #[serde(default = "default_mine_days")]
    days: i64,
    #[serde(default)]
    config: Option<qmine::MineConfig>,
}
fn default_mine_days() -> i64 {
    3650
}

pub async fn mine_start(
    State(state): State<Arc<AppState>>,
    Json(req): Json<MineReq>,
) -> AppResult<impl IntoResponse> {
    {
        let st = state.mine_status.lock().unwrap();
        if matches!(*st, crate::mine_job::MineStatus::Running { .. }) {
            return Err(bad("mining already running"));
        }
    }
    let panel = crate::mine_job::build_panel(&state, req.days)
        .await
        .map_err(internal)?;
    let cfg = req.config.unwrap_or_default();
    let (n_sym, n_dates) = (panel.n_symbols(), panel.n_dates());
    crate::mine_job::launch_mine(state.clone(), panel, cfg);
    Ok(Json(json!({"started": true, "universe": n_sym, "dates": n_dates})))
}

pub async fn mine_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let st = state.mine_status.lock().unwrap().clone();
    Json(st)
}

pub async fn factors_mined(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(crate::mine_job::load_library(&state))
}

#[derive(Deserialize)]
pub struct FactorStrategyReq {
    #[serde(default = "default_mine_days")]
    days: i64,
    #[serde(default)]
    config: Option<qmine::CsBtConfig>,
}

/// 因子库 → 横截面多空策略回测；按留出期切分报告（与挖掘同一 20% 切分）
pub async fn factor_strategy(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FactorStrategyReq>,
) -> AppResult<impl IntoResponse> {
    let lib = crate::mine_job::load_library(&state);
    if lib.is_empty() {
        return Err(bad("因子库为空，先 POST /api/mine 挖掘"));
    }
    let panel = crate::mine_job::build_panel(&state, req.days)
        .await
        .map_err(internal)?;
    let cfg = req.config.unwrap_or_default();
    let exprs: Vec<qmine::Expr> = lib.iter().map(|f| f.ast.clone()).collect();
    let result = tokio::task::spawn_blocking(move || qmine::backtest_cs(&panel, &exprs, &cfg))
        .await
        .map_err(internal)?;

    let n = result.daily_rets.len();
    let holdout_start = n - (n as f64 * 0.2) as usize;
    let seg_metrics = |t0: usize, t1: usize| {
        let rets = &result.daily_rets[t0..t1];
        let mut eq = 1.0;
        let curve: Vec<qcore::EquityPoint> = (t0..t1)
            .map(|t| {
                eq *= 1.0 + result.daily_rets[t];
                qcore::EquityPoint {
                    time: result.dates[t],
                    equity: eq,
                    position: 0.0,
                    price: 0.0,
                }
            })
            .collect();
        qbacktest::compute_metrics(rets, &curve, 252.0, result.n_rebalances as u64, 0, 1)
    };
    let full = seg_metrics(130, n);
    let search = seg_metrics(130, holdout_start);
    let holdout = seg_metrics(holdout_start, n);

    // 等距抽样净值
    let step = (n / 1500).max(1);
    let equity: Vec<serde_json::Value> = (0..n)
        .step_by(step)
        .map(|t| json!({"time": result.dates[t], "equity": result.equity[t]}))
        .collect();
    Ok(Json(json!({
        "factors_used": lib.iter().map(|f| &f.expression).collect::<Vec<_>>(),
        "metrics_full": full,
        "metrics_search": search,
        "metrics_holdout": holdout,
        "holdout_start_ms": result.dates[holdout_start],
        "avg_turnover": result.avg_turnover_per_rebalance,
        "names_per_side": result.names_per_side,
        "equity": equity,
        "note": "美元中性多空组合(±0.5)，5bp/边成本；metrics_holdout 为挖掘从未接触的最近20%时段"
    })))
}

#[derive(Deserialize)]
pub struct UniversePlanReq {
    /// 多/空各取几只
    #[serde(default = "default_topk")]
    k: usize,
    #[serde(default = "default_plan_capital")]
    capital_usd: f64,
    #[serde(default = "default_true")]
    include_shorts: bool,
}
fn default_topk() -> usize {
    5
}
fn default_plan_capital() -> f64 {
    10_000.0
}
fn default_true() -> bool {
    true
}

/// 全池 Top-K 计划：52股票池因子排序 → 选股 → 分数/波动率加权配仓
pub async fn universe_plan(
    State(state): State<Arc<AppState>>,
    Json(req): Json<UniversePlanReq>,
) -> AppResult<impl IntoResponse> {
    let lib = crate::mine_job::load_library(&state);
    if lib.is_empty() {
        return Err(bad("因子库为空，先在因子Lab挖掘"));
    }
    let panel = crate::mine_job::build_panel(&state, 600).await.map_err(internal)?;
    let exprs: Vec<qmine::Expr> = lib.iter().map(|f| f.ast.clone()).collect();
    let (z, panel) = tokio::task::spawn_blocking(move || {
        let z = qmine::combined_z(&panel, &exprs);
        (z, panel)
    })
    .await
    .map_err(internal)?;

    // 最近覆盖足够的横截面日期
    let mut t = panel.n_dates() - 1;
    let count_at =
        |t: usize| (0..panel.n_symbols()).filter(|s| z[*s][t].is_finite()).count();
    while t > 0 && count_at(t) < 10 {
        t -= 1;
    }

    // 每标的: score + 20日年化波动 + 最新收盘
    struct Cand {
        symbol: String,
        score: f64,
        vol_annual: f64,
        last_close: f64,
    }
    let mut cands: Vec<Cand> = Vec::new();
    for s in 0..panel.n_symbols() {
        let score = z[s][t];
        if !score.is_finite() {
            continue;
        }
        let rets: Vec<f64> = panel.ret1[s][t.saturating_sub(20)..=t]
            .iter()
            .copied()
            .filter(|r| r.is_finite())
            .collect();
        if rets.len() < 10 {
            continue;
        }
        let m = rets.iter().sum::<f64>() / rets.len() as f64;
        let sd =
            (rets.iter().map(|r| (r - m).powi(2)).sum::<f64>() / (rets.len() as f64 - 1.0)).sqrt();
        let last_close = panel.close[s][t];
        if !last_close.is_finite() || sd <= 0.0 {
            continue;
        }
        cands.push(Cand {
            symbol: panel.symbols[s].clone(),
            score,
            vol_annual: sd * 252.0f64.sqrt(),
            last_close,
        });
    }
    cands.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());

    let longs: Vec<&Cand> = cands.iter().filter(|c| c.score > 0.0).take(req.k).collect();
    let shorts: Vec<&Cand> = if req.include_shorts {
        cands.iter().rev().filter(|c| c.score < 0.0).take(req.k).collect()
    } else {
        Vec::new()
    };
    let (long_budget, short_budget) = if shorts.is_empty() {
        (req.capital_usd, 0.0)
    } else {
        (req.capital_usd * 0.6, req.capital_usd * 0.4)
    };

    // 分数/波动率加权 + 单票 30% 上限
    let make_picks = |side: &str, set: &[&Cand], budget: f64| -> Vec<serde_json::Value> {
        let raw: Vec<f64> = set.iter().map(|c| c.score.abs() / c.vol_annual.max(0.05)).collect();
        let total: f64 = raw.iter().sum();
        // capped 权重再归一，保证预算用满且单票≤30%
        let capped: Vec<f64> = raw.iter().map(|x| (x / total.max(1e-12)).min(0.30)).collect();
        let norm: f64 = capped.iter().sum::<f64>().max(1e-12);
        set.iter()
            .zip(&capped)
            .map(|(c, w)| {
                let dollars = budget * w / norm;
                let shares = (dollars / c.last_close).floor() as i64;
                serde_json::json!({
                    "symbol": c.symbol,
                    "side": side,
                    "score": c.score,
                    "vol_annual": c.vol_annual,
                    "weight_in_side": w / norm,
                    "dollars": dollars,
                    "shares": shares,
                    "last_close": c.last_close,
                    "option_hint": if side == "long" {
                        format!("替代表达: BUY CALL |Δ|≈0.35, 到期≥{}天", (lib[0].horizon as f64 * 1.5).ceil() as i64)
                    } else {
                        format!("替代表达: BUY PUT |Δ|≈0.35, 到期≥{}天", (lib[0].horizon as f64 * 1.5).ceil() as i64)
                    },
                })
            })
            .collect()
    };

    let avg_ic = lib.iter().map(|f| f.holdout_ic).sum::<f64>() / lib.len() as f64;
    Ok(Json(json!({
        "as_of": panel.dates[t],
        "horizon_days": lib.first().map_or(5, |f| f.horizon),
        "capital_usd": req.capital_usd,
        "longs": make_picks("long", &longs, long_budget),
        "shorts": make_picks("short", &shorts, short_budget),
        "sizing_rule": "权重 ∝ 因子分/年化波动（分数强且波动低者多配），单票≤30%，多头60%/空头40%预算",
        "confidence": {
            "n_factors": lib.len(),
            "avg_holdout_ic": avg_ic,
            "note": "横截面相对强弱信号（留出IC≈该值）；预测的是组内相对表现，非绝对涨跌"
        }
    })))
}

/// F5: 用因子库当前值预测未来 horizon 日的横截面相对强弱
pub async fn factor_forecast(State(state): State<Arc<AppState>>) -> AppResult<impl IntoResponse> {
    let lib = crate::mine_job::load_library(&state);
    if lib.is_empty() {
        return Err(bad("因子库为空，先 POST /api/mine 挖掘"));
    }
    let panel = crate::mine_job::build_panel(&state, 600).await.map_err(internal)?;
    let exprs: Vec<qmine::Expr> = lib.iter().map(|f| f.ast.clone()).collect();
    let z = tokio::task::spawn_blocking({
        let panel = panel.clone();
        move || qmine::combined_z(&panel, &exprs)
    })
    .await
    .map_err(internal)?;
    // 最新日期可能只有部分标的有bar（盘前/数据时差），向前找覆盖足够的横截面
    let mut t = panel.n_dates() - 1;
    let count_at = |t: usize| (0..panel.n_symbols()).filter(|s| z[*s][t].is_finite()).count();
    while t > 0 && count_at(t) < 10 {
        t -= 1;
    }
    let mut scores: Vec<(String, f64)> = panel
        .symbols
        .iter()
        .enumerate()
        .filter_map(|(s, sym)| {
            let v = z[s][t];
            if v.is_finite() {
                Some((sym.clone(), v))
            } else {
                None
            }
        })
        .collect();
    scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let avg_ic = lib.iter().map(|f| f.holdout_ic).sum::<f64>() / lib.len() as f64;
    let horizon = lib.first().map_or(5, |f| f.horizon);
    Ok(Json(json!({
        "as_of": panel.dates[t],
        "horizon_days": horizon,
        "rankings": scores.iter().map(|(s, v)| json!({"symbol": s, "score": v})).collect::<Vec<_>>(),
        "confidence": {
            "avg_holdout_ic": avg_ic,
            "n_factors": lib.len(),
            "interpretation": format!(
                "留出期日均RankIC≈{:.3}：排序具有统计意义但单期噪声大，\
                 只宜作横截面相对强弱参考（前1/5 vs 后1/5），不是个股绝对涨跌预测",
                avg_ic
            ),
        },
    })))
}

#[derive(Deserialize)]
pub struct OptBtReq {
    symbol: String,
    #[serde(default = "default_days")]
    days: i64,
    /// 股票信号策略；缺省用该 symbol 的注册表冠军
    #[serde(default)]
    spec: Option<StrategySpec>,
    #[serde(default)]
    params: Option<crate::optbt::OptBtParams>,
}

pub async fn options_backtest(
    State(state): State<Arc<AppState>>,
    Json(req): Json<OptBtReq>,
) -> AppResult<impl IntoResponse> {
    let symbol = req.symbol.to_uppercase();
    if qdata::is_crypto(&symbol) {
        return Err(bad("options backtest is stocks-only"));
    }
    let spec = match req.spec {
        Some(s) => s,
        None => {
            let champs = state.champions.lock().unwrap();
            champs
                .get(&crate::state::champ_key(&symbol, "1d"))
                .and_then(|c| c.spec.clone())
                .ok_or_else(|| bad("该标的无冠军策略，请在请求中提供 spec 或先跑进化"))?
        }
    };
    let q = KlineQuery {
        symbol: symbol.clone(),
        interval: "1d".into(),
        days: req.days,
    };
    let (klines, _) = load_klines(&state, &q).await?;
    if klines.len() < 300 {
        return Err(bad("not enough data"));
    }
    // 持有期估计与交易计划一致
    let horizon = crate::plan::spec_horizon_days(&spec);
    let params = req.params.unwrap_or_default();
    let result = tokio::task::spawn_blocking(move || {
        crate::optbt::run(&klines, &spec, horizon, &params)
    })
    .await
    .map_err(internal)?;
    // 抽样曲线
    let step = (result.equity.len() / 2000).max(1);
    let equity: Vec<_> = result.equity.iter().step_by(step).collect();
    Ok(Json(json!({
        "metrics": result.metrics,
        "equity": equity,
        "trades": result.trades,
        "total_fees_usd": result.total_fees_usd,
        "note": result.note,
    })))
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

#[derive(Deserialize)]
pub struct TaStatsQuery {
    #[serde(default = "default_stats_interval")]
    interval: String,
    /// 提供时返回该标的专属统计（任意标的含加密币）
    symbol: Option<String>,
}
fn default_stats_interval() -> String {
    "1d".into()
}

/// 技术规则历史统计：52标的全历史，按周期分别计算并缓存6小时
pub async fn ta_stats(
    State(state): State<Arc<AppState>>,
    Query(q): Query<TaStatsQuery>,
) -> AppResult<impl IntoResponse> {
    let cache_key = match &q.symbol {
        Some(sym) => format!("{}|{}", q.interval, sym.to_uppercase()),
        None => q.interval.clone(),
    };
    {
        let cache = state.ta_stats_cache.lock().unwrap();
        if let Some((ts, val)) = cache.get(&cache_key) {
            if now_ms() - ts < crate::ta_stats::CACHE_TTL_MS {
                return Ok(Json(val.clone()));
            }
        }
    }
    let val = match &q.symbol {
        Some(sym) => {
            let r = crate::ta_stats::compute_symbol(&state, &q.interval, &sym.to_uppercase())
                .await
                .map_err(bad)?;
            serde_json::to_value(&r).map_err(internal)?
        }
        None => {
            let r = crate::ta_stats::compute(&state, &q.interval).await.map_err(bad)?;
            serde_json::to_value(&r).map_err(internal)?
        }
    };
    state
        .ta_stats_cache
        .lock()
        .unwrap()
        .insert(cache_key, (now_ms(), val.clone()));
    Ok(Json(val))
}

#[derive(Deserialize)]
pub struct ModCheckQuery {
    symbol: String,
    #[serde(default = "default_interval_1d")]
    interval: String,
    #[serde(default = "default_mod_days")]
    days: i64,
}
fn default_interval_1d() -> String {
    "1d".into()
}
fn default_mod_days() -> i64 {
    1460
}

/// 经典信号仓位调制 A/B 验证：同一冠军策略，base vs 调制后，全套回测指标对比
pub async fn ta_modulation_check(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ModCheckQuery>,
) -> AppResult<impl IntoResponse> {
    let key = format!("{}|{}", q.symbol.to_uppercase(), q.interval);
    let spec = {
        let champs = state.champions.lock().unwrap();
        champs
            .get(&key)
            .and_then(|c| c.spec.clone())
            .ok_or_else(|| bad(format!("{key} 无冠军策略")))?
    };
    let kq = KlineQuery {
        symbol: q.symbol.clone(),
        interval: q.interval.clone(),
        days: q.days,
    };
    let (klines, interval) = load_klines(&state, &kq).await?;
    if klines.len() < 300 {
        return Err(bad("not enough data"));
    }
    let (bars_per_year, cost) = market_params(&q.symbol, interval);
    let base = spec.signals(&klines);
    let factors = crate::paper::ta_modulation_factors(&klines, &base);
    let apply = |sel: &dyn Fn(f64) -> f64| -> Vec<f64> {
        base.iter()
            .zip(&factors)
            .map(|(p, f)| (p * sel(*f)).clamp(-1.0, 1.0))
            .collect()
    };
    let boosted = factors.iter().filter(|f| **f > 1.0).count();
    let cut = factors.iter().filter(|f| **f < 1.0).count();

    let run = |targets: &[f64]| {
        let sigs = qbacktest::to_signals(&klines, targets);
        qbacktest::run(&klines, &sigs, cost, bars_per_year, 1).metrics
    };
    Ok(Json(json!({
        "key": key,
        "bars": klines.len(),
        "boosted_bars": boosted,
        "cut_bars": cut,
        "base": run(&base),
        "modulated": run(&apply(&|f| f)),
        "boost_only": run(&apply(&|f: f64| f.max(1.0))),
        "cut_only": run(&apply(&|f: f64| f.min(1.0))),
    })))
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
