//! 实时模拟盘（paper trading）引擎——多会话版。
//!
//! 注册表中每个冠军（symbol|interval 槽位）各开一个会话：
//! - 价格标记：订阅实时成交，按最新价 mark-to-market，节流推送净值点
//!   （股票暂无实时流，会话只在新日线收盘时更新）
//! - 调仓：每 30s 检查各冠军周期是否有新收盘bar，有则重算信号，
//!   仓位变化按最新价成交并扣手续费+滑点（与回测同一成本模型）
//! - 冠军热更新：spec 变了就重置对应会话；冠军被移除则关会话

use crate::state::{champ_key, now_ms, AppState, WsMessage};
use qcore::{EquityPoint, Interval};
use qstrategy::StrategySpec;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

/// 信号重算所需历史bar数（最大 lookback 200 + 热身余量）
const HISTORY_BARS: i64 = 500;
/// 净值点推送节流（毫秒）
const MARK_THROTTLE_MS: i64 = 3000;
const MAX_CURVE_POINTS: usize = 5000;

fn env_var(key: &str) -> Option<String> {
    std::env::var(key).ok().or_else(|| {
        key.strip_prefix("QT_")
            .and_then(|suffix| std::env::var(format!("QHH_{suffix}")).ok())
    })
}

fn stock_long_only() -> bool {
    env_var("QT_STOCK_LONG_ONLY").map_or(true, |v| v != "0")
}

/// 粗略的美股盘中判断（UTC 周一~周五 13:30–20:00；不处理假日与夏令时1小时偏差）
pub fn us_market_open() -> bool {
    let secs = now_ms() / 1000;
    let days = secs / 86_400;
    // 1970-01-01 是周四：dow 0=Thu 1=Fri 2=Sat 3=Sun 4=Mon 5=Tue 6=Wed
    let dow = days % 7;
    if dow == 2 || dow == 3 {
        return false;
    }
    let tod = secs % 86_400;
    (13 * 3600 + 1800..20 * 3600).contains(&tod)
}

/// 盘中再决策周期（分钟）：盘中每 N 分钟用最新价作临时收盘正式重算信号并调仓。
/// 股票仅美股盘中，加密全天；周期 ≤30 分钟的槽位跳过。QT_INTRADAY_MINUTES=0 关闭。
pub fn intraday_minutes() -> u64 {
    env_var("QT_INTRADAY_MINUTES")
        .and_then(|v| v.parse().ok())
        .unwrap_or(30)
}

/// 盘中调仓死区：目标仓位变化小于该值不动作（防盘中噪声反复刷手续费）
fn intraday_min_delta() -> f64 {
    env_var("QT_INTRADAY_MIN_DELTA")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.10)
}

/// 经典信号仓位调制开关。**默认关闭**：4年A/B回测显示共振调制在6冠军槽
/// 无一致增益（SPY 1.60→1.52 / QQQ 0.53→0.39，boost/cut单腿也不行）——
/// 经典信号共振不含冠军策略之外的增量信息。设 QT_TA_MOD=1 可实验性开启。
fn ta_modulation_enabled() -> bool {
    env_var("QT_TA_MOD").map_or(false, |v| v == "1")
}

/// 经典信号共振 → 逐bar仓位调制系数（与klines等长）。
/// 近5根bar内出现过"≥2条同向规则共振"的bar：与持仓同向 → ×1.2（顺势确认加仓），
/// 与持仓反向 → ×0.8（警示减仓）；两者皆有则相乘（净效果×0.96，近似中性）。
/// 调制后仓位仍 clamp 在 [-1,1]。卖出类信号只用于减仓，从不翻空。
pub fn ta_modulation_factors(klines: &[qcore::Kline], base: &[f64]) -> Vec<f64> {
    let n = klines.len();
    let hits = qfactors::ta_rules::classic_rule_events(klines);
    let (mut buy_cnt, mut sell_cnt) = (vec![0usize; n], vec![0usize; n]);
    for h in &hits {
        if h.side > 0 {
            buy_cnt[h.idx] += 1;
        } else {
            sell_cnt[h.idx] += 1;
        }
    }
    const W: usize = 5;
    (0..n)
        .map(|i| {
            let pos = base[i];
            if pos.abs() < 1e-9 {
                return 1.0;
            }
            let lo = i.saturating_sub(W - 1);
            let strong_buy = (lo..=i).any(|j| buy_cnt[j] >= 2);
            let strong_sell = (lo..=i).any(|j| sell_cnt[j] >= 2);
            let (with, against) = if pos > 0.0 {
                (strong_buy, strong_sell)
            } else {
                (strong_sell, strong_buy)
            };
            let mut f = 1.0;
            if with {
                f *= 1.2;
            }
            if against {
                f *= 0.8;
            }
            f
        })
        .collect()
}

fn cost_per_unit_turnover(symbol: &str) -> f64 {
    // 与回测同一成本模型（crate::routes::market_params）
    if qdata::is_crypto(symbol) {
        0.001 + 0.0005
    } else {
        let c = crate::routes::market_params(symbol, qcore::Interval::D1).1;
        c.fee_rate + c.slippage
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaperTrade {
    pub time: i64,
    pub price: f64,
    pub from_position: f64,
    pub to_position: f64,
    pub cost: f64,
    /// true = 盘中再决策成交（非 bar 收盘的正式决策点）
    #[serde(default)]
    pub intraday: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaperSession {
    pub symbol: String,
    pub interval: String,
    pub spec: StrategySpec,
    pub started_ms: i64,
    pub equity: f64,
    pub position: f64,
    pub last_price: f64,
    /// 最近一根已执行信号的收盘bar open_time
    pub last_bar_open: i64,
    /// 当前生效的经典信号仓位调制系数（1.0=中性；1.2顺势共振/0.8反向警示）
    #[serde(default = "default_ta_mod")]
    pub ta_mod: f64,
    #[serde(skip)]
    pub last_push_ms: i64,
    pub curve: VecDeque<EquityPoint>,
    pub trades: Vec<PaperTrade>,
}

/// 启动模拟盘引擎（两个任务：价格标记 + 调仓检查）
fn default_ta_mod() -> f64 {
    1.0
}

pub fn start_paper_engine(state: Arc<AppState>) {
    // 任务1：实时价格 mark-to-market（命中所有同 symbol 的会话）
    let st = state.clone();
    tokio::spawn(async move {
        let mut rx = st.ws_tx.subscribe();
        loop {
            let msg = match rx.recv().await {
                Ok(m) => m,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            };
            let WsMessage::Market(qcore::MarketEvent::Trade { symbol, time, price, .. }) = msg
            else {
                continue;
            };
            let mut updates: Vec<WsMessage> = Vec::new();
            {
                let mut guard = st.paper.lock().unwrap();
                for (key, sess) in guard.iter_mut() {
                    if sess.symbol != symbol || sess.last_price <= 0.0 {
                        continue;
                    }
                    // 增量 mark：equity *= 1 + pos × 价格变化率
                    sess.equity *= 1.0 + sess.position * (price / sess.last_price - 1.0);
                    sess.last_price = price;
                    if time - sess.last_push_ms < MARK_THROTTLE_MS {
                        continue;
                    }
                    sess.last_push_ms = time;
                    let pt = EquityPoint {
                        time,
                        equity: sess.equity,
                        position: sess.position,
                        price,
                    };
                    sess.curve.push_back(pt);
                    while sess.curve.len() > MAX_CURVE_POINTS {
                        sess.curve.pop_front();
                    }
                    updates.push(WsMessage::Paper {
                        key: key.clone(),
                        symbol: sess.symbol.clone(),
                        interval: sess.interval.clone(),
                        time: pt.time,
                        equity: pt.equity,
                        position: pt.position,
                        price: pt.price,
                    });
                }
            }
            for u in updates {
                let _ = st.ws_tx.send(u);
            }
        }
    });

    // 任务2：周期bar收盘 → 重算信号调仓；同时跟踪冠军热更新
    let st2 = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut n: u64 = 0;
        loop {
            tick.tick().await;
            if let Err(e) = rebalance_tick(&st2).await {
                tracing::warn!(error = %e, "paper rebalance tick failed");
            }
            // 每 5 分钟落盘一次会话（重启恢复净值）
            n += 1;
            if n % 10 == 0 {
                st2.save_paper();
            }
        }
    });

    // 任务3：盘中再决策——每 QT_INTRADAY_MINUTES 分钟把当前未收盘 bar 以
    // 最新价作临时收盘，正式重算信号并调仓（带死区）。收盘决策路径不受影响。
    let minutes = intraday_minutes();
    if minutes > 0 {
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(minutes * 60));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            tick.tick().await; // 跳过启动立即触发的首个 tick
            loop {
                tick.tick().await;
                if let Err(e) = intraday_tick(&state).await {
                    tracing::warn!(error = %e, "intraday decision tick failed");
                }
            }
        });
    }
}

fn max_dd_limit() -> f64 {
    env_var("QT_MAX_DD")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.15)
}

/// 组合回撤熔断（机构 kill-switch）：全部会话平均净值相对历史峰值
/// 回撤超过 QT_MAX_DD（默认15%）时，停止开新仓、全部目标仓位清零，
/// 直到人工干预（删除 data/risk_halt 文件）或回撤恢复到一半以内。
fn check_kill_switch(state: &Arc<AppState>) -> bool {
    let halt_file = state.paper_path.with_file_name("risk_halt");
    let peak_file = state.paper_path.with_file_name("equity_peak");
    let agg = {
        let guard = state.paper.lock().unwrap();
        if guard.is_empty() {
            return false;
        }
        guard.values().map(|s| s.equity).sum::<f64>() / guard.len() as f64
    };
    let mut peak: f64 = std::fs::read_to_string(&peak_file)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(1.0);
    if agg > peak {
        peak = agg;
        let _ = std::fs::write(&peak_file, format!("{peak}"));
    }
    let dd = 1.0 - agg / peak;
    let limit = max_dd_limit();
    if halt_file.exists() {
        // 已熔断：回撤恢复到限值一半以内自动解除
        if dd < limit / 2.0 {
            let _ = std::fs::remove_file(&halt_file);
            tracing::warn!(dd, "风控熔断解除：回撤已恢复");
            return false;
        }
        return true;
    }
    if dd > limit {
        let _ = std::fs::write(&halt_file, format!("dd={dd:.4} limit={limit} agg={agg:.4} peak={peak:.4}"));
        tracing::error!(dd, limit, "⚠️ 组合回撤熔断触发：全部目标仓位清零，删除 data/risk_halt 可人工恢复");
        return true;
    }
    false
}

fn champion_snapshot(state: &Arc<AppState>) -> Vec<(String, String, String, StrategySpec)> {
    let champs = state.champions.lock().unwrap();
    champs
        .iter()
        .filter_map(|(key, rec)| {
            rec.spec
                .as_ref()
                .map(|s| (key.clone(), rec.symbol.clone(), rec.interval.clone(), s.clone()))
        })
        .collect()
}

/// 目标仓位管线（收盘与盘中两条决策路径共用）：
/// NaN清零 → clamp → 正股只多 → 经典信号调制 → 回撤熔断清零
fn decide_target(
    spec: &StrategySpec,
    klines: &[qcore::Kline],
    symbol: &str,
    risk_halted: bool,
) -> (f64, f64) {
    let targets = spec.signals(klines);
    let target = targets.last().copied().unwrap_or(0.0);
    let mut target = if target.is_nan() { 0.0 } else { target.clamp(-1.0, 1.0) };
    if !qdata::is_crypto(symbol) && stock_long_only() {
        target = target.max(0.0);
    }
    let mut ta_mod = 1.0f64;
    if ta_modulation_enabled() {
        let factors = ta_modulation_factors(klines, &targets);
        ta_mod = factors.last().copied().unwrap_or(1.0);
        target = (target * ta_mod).clamp(-1.0, 1.0);
    }
    if risk_halted {
        target = 0.0;
    }
    (target, ta_mod)
}

async fn rebalance_tick(state: &Arc<AppState>) -> anyhow::Result<()> {
    let halted = check_kill_switch(state);
    let champions = champion_snapshot(state);

    // 冠军被移除的会话清理
    {
        let mut guard = state.paper.lock().unwrap();
        let live: Vec<String> = champions.iter().map(|(k, ..)| k.clone()).collect();
        guard.retain(|k, _| live.contains(k));
    }

    for (key, symbol, interval_s, spec) in champions {
        if let Err(e) = rebalance_one(state, &key, &symbol, &interval_s, &spec, halted).await {
            tracing::warn!(key, error = %e, "paper rebalance failed for session");
        }
    }
    Ok(())
}

/// 盘中再决策 tick：对每个槽位用最新价作临时收盘重算信号，目标变化超死区即调仓
async fn intraday_tick(state: &Arc<AppState>) -> anyhow::Result<()> {
    let halted = check_kill_switch(state);
    let champions = champion_snapshot(state);
    let n = champions.len();
    for (key, symbol, interval_s, spec) in champions {
        if let Err(e) = intraday_one(state, &key, &symbol, &interval_s, &spec, halted).await {
            tracing::warn!(key, error = %e, "intraday decision failed for session");
        }
    }
    tracing::debug!(slots = n, "intraday decision tick done");
    Ok(())
}

async fn intraday_one(
    state: &Arc<AppState>,
    key: &str,
    symbol: &str,
    interval_s: &str,
    spec: &StrategySpec,
    risk_halted: bool,
) -> anyhow::Result<()> {
    let Some(interval) = Interval::parse(interval_s) else {
        anyhow::bail!("bad champion interval: {interval_s}");
    };
    let step = interval.millis();
    // 周期≤30分钟的槽位 bar 收盘本就频繁，盘中再决策无意义；股票仅美股盘中
    if step <= 30 * 60_000 {
        return Ok(());
    }
    if !qdata::is_crypto(symbol) && !us_market_open() {
        return Ok(());
    }
    // 会话还没被收盘路径初始化时不做盘中决策
    if !state.paper.lock().unwrap().contains_key(key) {
        return Ok(());
    }

    let end = now_ms();
    let mut klines = state
        .store
        .get(symbol, interval, end - HISTORY_BARS * step * 2, end)
        .await?;
    let partial = klines.iter().rev().find(|k| k.open_time + step > end).copied();
    klines.retain(|k| k.open_time + step <= end);
    anyhow::ensure!(klines.len() > 250, "not enough history for intraday decision");
    // 当前bar尚无数据（数据源时差）→ 本轮跳过
    let Some(mut pb) = partial else { return Ok(()) };

    // 临时收盘价：优先会话实时 mark 价（报价轮询/实时流每15s更新），否则用未收盘bar收盘价
    let live = {
        let guard = state.paper.lock().unwrap();
        guard.get(key).map(|s| s.last_price).filter(|p| *p > 0.0)
    };
    if let Some(lp) = live {
        pb.close = lp;
        pb.high = pb.high.max(lp);
        pb.low = pb.low.min(lp);
    }
    klines.push(pb);
    let (target, ta_mod) = decide_target(spec, &klines, symbol, risk_halted);
    let price = pb.close;

    let mut events: Vec<WsMessage> = Vec::new();
    {
        let mut guard = state.paper.lock().unwrap();
        let Some(sess) = guard.get_mut(key) else { return Ok(()) };
        let turnover = (target - sess.position).abs();
        if turnover < intraday_min_delta() {
            return Ok(());
        }
        // 先按决策价 mark 再成交（不更新 last_bar_open——收盘决策点不受影响）
        if sess.last_price > 0.0 {
            sess.equity *= 1.0 + sess.position * (price / sess.last_price - 1.0);
        }
        sess.last_price = price;
        let cost = turnover * cost_per_unit_turnover(&sess.symbol);
        sess.equity *= 1.0 - cost;
        let trade = PaperTrade {
            time: end,
            price,
            from_position: sess.position,
            to_position: target,
            cost,
            intraday: true,
        };
        sess.position = target;
        sess.ta_mod = ta_mod;
        let pt = EquityPoint {
            time: end,
            equity: sess.equity,
            position: sess.position,
            price,
        };
        sess.curve.push_back(pt);
        while sess.curve.len() > MAX_CURVE_POINTS {
            sess.curve.pop_front();
        }
        events.push(WsMessage::Paper {
            key: key.to_string(),
            symbol: sess.symbol.clone(),
            interval: sess.interval.clone(),
            time: pt.time,
            equity: pt.equity,
            position: pt.position,
            price: pt.price,
        });
        events.push(WsMessage::PaperTrade {
            key: key.to_string(),
            symbol: sess.symbol.clone(),
            trade: trade.clone(),
        });
        sess.trades.push(trade);
        tracing::info!(key, target, price, "盘中再决策调仓");
    }
    for ev in events {
        let _ = state.ws_tx.send(ev);
    }
    Ok(())
}

async fn rebalance_one(
    state: &Arc<AppState>,
    key: &str,
    symbol: &str,
    interval_s: &str,
    spec: &StrategySpec,
    risk_halted: bool,
) -> anyhow::Result<()> {
    debug_assert_eq!(key, champ_key(symbol, interval_s));
    let Some(interval) = Interval::parse(interval_s) else {
        anyhow::bail!("bad champion interval: {interval_s}");
    };

    // 会话不存在或 spec 变更 → 重置
    let needs_init = {
        let guard = state.paper.lock().unwrap();
        match guard.get(key) {
            Some(s) => s.spec != *spec,
            None => true,
        }
    };

    // 拉最新K线（增量，缓存命中时无网络请求）
    let step = interval.millis();
    let end = now_ms();
    let mut klines = state
        .store
        .get(symbol, interval, end - HISTORY_BARS * step * 2, end)
        .await?;
    // 丢掉未收盘的当前bar
    klines.retain(|k| k.open_time + step <= end);
    anyhow::ensure!(klines.len() > 250, "not enough history for paper trading");
    let last = *klines.last().unwrap();

    // 目标仓位管线（NaN清零→只多约束→调制→熔断清零）与盘中决策路径共用
    let (target, ta_mod) = decide_target(spec, &klines, symbol, risk_halted);

    let mut events: Vec<WsMessage> = Vec::new();
    {
        let mut guard = state.paper.lock().unwrap();
        if needs_init {
            tracing::info!(key, "paper session (re)started for champion");
            guard.insert(
                key.to_string(),
                PaperSession {
                    symbol: symbol.to_string(),
                    interval: interval_s.to_string(),
                    spec: spec.clone(),
                    started_ms: end,
                    equity: 1.0,
                    position: target,
                    last_price: last.close,
                    last_bar_open: last.open_time,
                    ta_mod,
                    last_push_ms: 0,
                    curve: VecDeque::new(),
                    trades: Vec::new(),
                },
            );
        }
        let sess = guard.get_mut(key).unwrap();
        // 新收盘bar → 执行信号（股票无实时流时也在此用收盘价 mark）
        if last.open_time > sess.last_bar_open {
            sess.last_bar_open = last.open_time;
            sess.ta_mod = ta_mod;
            // 用新bar收盘价 mark（对无实时流的股票这是唯一的价格更新点）
            if sess.last_price > 0.0 {
                sess.equity *= 1.0 + sess.position * (last.close / sess.last_price - 1.0);
            }
            sess.last_price = last.close;
            let pt = EquityPoint {
                time: end,
                equity: sess.equity,
                position: sess.position,
                price: last.close,
            };
            sess.curve.push_back(pt);
            events.push(WsMessage::Paper {
                key: key.to_string(),
                symbol: sess.symbol.clone(),
                interval: sess.interval.clone(),
                time: pt.time,
                equity: pt.equity,
                position: pt.position,
                price: pt.price,
            });

            let turnover = (target - sess.position).abs();
            if turnover > 1e-9 {
                let cost = turnover * cost_per_unit_turnover(&sess.symbol);
                sess.equity *= 1.0 - cost;
                let trade = PaperTrade {
                    time: end,
                    price: sess.last_price,
                    from_position: sess.position,
                    to_position: target,
                    cost,
                    intraday: false,
                };
                sess.position = target;
                events.push(WsMessage::PaperTrade {
                    key: key.to_string(),
                    symbol: sess.symbol.clone(),
                    trade: trade.clone(),
                });
                sess.trades.push(trade);
                tracing::info!(key, target, "paper rebalanced");
            }
        }
    }
    for ev in events {
        let _ = state.ws_tx.send(ev);
    }
    Ok(())
}
