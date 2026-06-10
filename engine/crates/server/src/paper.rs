//! 实时模拟盘（paper trading）引擎。
//!
//! 把冠军策略接到实时行情上：
//! - 价格标记：订阅实时成交，按最新价 mark-to-market，节流推送净值点
//! - 调仓：每 30s 检查冠军周期是否有新收盘bar，有则重算信号，
//!   仓位变化按最新价成交并扣手续费+滑点（与回测同一成本模型）
//! - 冠军热更新：每个检查周期都对比注册表，冠军变了就重启会话

use crate::state::{now_ms, AppState, WsMessage};
use qcore::{EquityPoint, Interval};
use qstrategy::StrategySpec;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

fn cost_per_unit_turnover(symbol: &str) -> f64 {
    // 与回测同一成本模型（crate::routes::market_params）
    if qdata::is_crypto(symbol) {
        0.001 + 0.0005
    } else {
        0.0001 + 0.0002
    }
}
/// 信号重算所需历史bar数（最大 lookback 200 + 热身余量）
const HISTORY_BARS: i64 = 500;
/// 净值点推送节流（毫秒）
const MARK_THROTTLE_MS: i64 = 3000;
const MAX_CURVE_POINTS: usize = 5000;

#[derive(Debug, Clone, Serialize)]
pub struct PaperTrade {
    pub time: i64,
    pub price: f64,
    pub from_position: f64,
    pub to_position: f64,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize)]
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
    // 任务1：实时价格 mark-to-market
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
            let update = {
                let mut guard = st.paper.lock().unwrap();
                let Some(sess) = guard.as_mut() else { continue };
                if sess.symbol != symbol || sess.last_price <= 0.0 {
                    continue;
                }
                // 增量 mark：equity *= 1 + pos × 价格变化率
                sess.equity *= 1.0 + sess.position * (price / sess.last_price - 1.0);
                sess.last_price = price;
                if time - sess.last_push_ms < MARK_THROTTLE_MS {
                    None
                } else {
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
                    Some(pt)
                }
            };
            if let Some(pt) = update {
                let _ = st.ws_tx.send(WsMessage::Paper {
                    time: pt.time,
                    equity: pt.equity,
                    position: pt.position,
                    price: pt.price,
                });
            }
        }
    });

    // 任务2：周期bar收盘 → 重算信号调仓；同时跟踪冠军热更新
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            if let Err(e) = rebalance_tick(&state).await {
                tracing::warn!(error = %e, "paper rebalance tick failed");
            }
        }
    });
}

async fn rebalance_tick(state: &Arc<AppState>) -> anyhow::Result<()> {
    // 读取当前冠军
    let (symbol, interval_s, spec) = {
        let champ = state.champion.lock().unwrap();
        match (&champ.spec, champ.symbol.as_str()) {
            (Some(spec), s) if !s.is_empty() => {
                (champ.symbol.clone(), champ.interval.clone(), spec.clone())
            }
            _ => return Ok(()), // 冠军空缺，不开模拟盘
        }
    };
    let Some(interval) = Interval::parse(&interval_s) else {
        anyhow::bail!("bad champion interval: {interval_s}");
    };

    // 冠军变更或会话不存在 → 重置会话
    let needs_init = {
        let guard = state.paper.lock().unwrap();
        match guard.as_ref() {
            Some(s) => s.symbol != symbol || s.interval != interval_s || s.spec != spec,
            None => true,
        }
    };

    // 拉最新K线（增量，缓存命中时无网络请求）
    let step = interval.millis();
    let end = now_ms();
    let mut klines = state
        .store
        .get(&symbol, interval, end - HISTORY_BARS * step, end)
        .await?;
    // 丢掉未收盘的当前bar
    klines.retain(|k| k.open_time + step <= end);
    anyhow::ensure!(klines.len() > 250, "not enough history for paper trading");
    let last = *klines.last().unwrap();

    let targets = spec.signals(&klines);
    let target = targets.last().copied().unwrap_or(0.0);
    let target = if target.is_nan() { 0.0 } else { target.clamp(-1.0, 1.0) };

    let mut events: Vec<WsMessage> = Vec::new();
    {
        let mut guard = state.paper.lock().unwrap();
        if needs_init {
            tracing::info!(symbol, interval_s, "paper session (re)started for champion");
            *guard = Some(PaperSession {
                symbol: symbol.clone(),
                interval: interval_s.clone(),
                spec: spec.clone(),
                started_ms: end,
                equity: 1.0,
                position: target,
                last_price: last.close,
                last_bar_open: last.open_time,
                last_push_ms: 0,
                curve: VecDeque::new(),
                trades: Vec::new(),
            });
        }
        let sess = guard.as_mut().unwrap();
        // 新收盘bar → 执行信号
        if last.open_time > sess.last_bar_open {
            sess.last_bar_open = last.open_time;
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
                events.push(WsMessage::PaperTrade(trade.clone()));
                sess.trades.push(trade);
                tracing::info!(symbol, target, "paper rebalanced");
            }
        }
    }
    for ev in events {
        let _ = state.ws_tx.send(ev);
    }
    Ok(())
}
