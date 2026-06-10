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

fn stock_long_only() -> bool {
    std::env::var("QHH_STOCK_LONG_ONLY").map_or(true, |v| v != "0")
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
    #[serde(skip)]
    pub last_push_ms: i64,
    pub curve: VecDeque<EquityPoint>,
    pub trades: Vec<PaperTrade>,
}

/// 启动模拟盘引擎（两个任务：价格标记 + 调仓检查）
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
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut n: u64 = 0;
        loop {
            tick.tick().await;
            if let Err(e) = rebalance_tick(&state).await {
                tracing::warn!(error = %e, "paper rebalance tick failed");
            }
            // 每 5 分钟落盘一次会话（重启恢复净值）
            n += 1;
            if n % 10 == 0 {
                state.save_paper();
            }
        }
    });
}

fn max_dd_limit() -> f64 {
    std::env::var("QHH_MAX_DD")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.15)
}

/// 组合回撤熔断（机构 kill-switch）：全部会话平均净值相对历史峰值
/// 回撤超过 QHH_MAX_DD（默认15%）时，停止开新仓、全部目标仓位清零，
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

async fn rebalance_tick(state: &Arc<AppState>) -> anyhow::Result<()> {
    let halted = check_kill_switch(state);
    // 注册表快照
    let champions: Vec<(String, String, String, StrategySpec)> = {
        let champs = state.champions.lock().unwrap();
        champs
            .iter()
            .filter_map(|(key, rec)| {
                rec.spec
                    .as_ref()
                    .map(|s| (key.clone(), rec.symbol.clone(), rec.interval.clone(), s.clone()))
            })
            .collect()
    };

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

    let targets = spec.signals(&klines);
    let target = targets.last().copied().unwrap_or(0.0);
    let mut target = if target.is_nan() { 0.0 } else { target.clamp(-1.0, 1.0) };
    // 正股默认只多不空（QHH_STOCK_LONG_ONLY=0 可关闭）；加密不受限
    if !qdata::is_crypto(symbol) && stock_long_only() {
        target = target.max(0.0);
    }
    // 组合回撤熔断：清零全部目标仓位
    if risk_halted {
        target = 0.0;
    }

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
