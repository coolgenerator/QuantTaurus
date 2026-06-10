//! 交易计划视图：把冠军策略的内部状态翻译成人类交易计划语言。
//!
//! - 方向/强度：当前目标仓位
//! - 信号反转价位：用二分法找"若今天收盘价变为 P，目标仓位方向翻转"的 P
//!   （动量类策略的数学止损/反手参考位）
//! - 下一决策时间：下一根周期bar收盘时刻（日线策略=每天收盘后）

use crate::state::{now_ms, AppState};
use qcore::{Interval, Kline};
use qstrategy::StrategySpec;
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
pub struct TradePlan {
    pub key: String,
    pub symbol: String,
    pub interval: String,
    pub strategy: String,
    /// 当前目标仓位 [-1,1]：正=看涨 负=看跌 0=空仓
    pub target_position: f64,
    pub last_close: f64,
    /// 信号反转价位（None = 在±40%价格范围内不会翻转）
    pub flip_price: Option<f64>,
    /// 反转价距现价百分比
    pub flip_pct: Option<f64>,
    /// 下一次信号重算时刻（ms epoch）
    pub next_decision_ms: i64,
    /// 留出窗 Sharpe（该计划的历史可信度参考）
    pub holdout_sharpe: Option<f64>,
}

/// 把最后一根K线的收盘价替换为 p 后的目标仓位
fn target_with_price(spec: &StrategySpec, klines: &mut [Kline], p: f64) -> f64 {
    let last = klines.len() - 1;
    let orig = klines[last];
    klines[last].close = p;
    klines[last].high = orig.high.max(p);
    klines[last].low = orig.low.min(p);
    let t = spec.signals(klines).last().copied().unwrap_or(0.0);
    klines[last] = orig;
    if t.is_nan() {
        0.0
    } else {
        t
    }
}

/// 二分找方向翻转价位。当前方向 dir = sign(target)；找最近的 P 使 sign 翻转。
fn find_flip(spec: &StrategySpec, klines: &mut [Kline], cur_target: f64) -> Option<f64> {
    let close = klines[klines.len() - 1].close;
    let dir = cur_target.signum();
    if dir == 0.0 {
        return None;
    }
    // 多头看下方翻转，空头看上方
    let far = if dir > 0.0 { close * 0.6 } else { close * 1.4 };
    let sign_at = |spec: &StrategySpec, ks: &mut [Kline], p: f64| -> f64 {
        let t = target_with_price(spec, ks, p);
        if t.abs() < 1e-9 {
            0.0
        } else {
            t.signum()
        }
    };
    // 远端必须已翻转（变号或归零）才有解
    let far_sign = sign_at(spec, klines, far);
    if far_sign == dir {
        return None;
    }
    let (mut lo, mut hi) = if dir > 0.0 { (far, close) } else { (close, far) };
    // 不变式：靠近现价一端保持 dir，远端非 dir
    for _ in 0..40 {
        let mid = (lo + hi) / 2.0;
        let s = sign_at(spec, klines, mid);
        if dir > 0.0 {
            if s == dir {
                hi = mid;
            } else {
                lo = mid;
            }
        } else if s == dir {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Some(if dir > 0.0 { (lo + hi) / 2.0 } else { (lo + hi) / 2.0 })
}

/// 下一根bar收盘时刻：加密=连续；美股=下一交易日 20:00 UTC（夏令时近似）
fn next_decision(symbol: &str, interval: Interval, last_open: i64) -> i64 {
    if qdata::is_crypto(symbol) {
        // 当前进行中bar的收盘 = 最后已收盘bar开盘 + 2×周期
        last_open + 2 * interval.millis()
    } else {
        let now = now_ms();
        let mut t = now;
        loop {
            let days = t / 86_400_000;
            let dow = days % 7; // 0=Thu .. 2=Sat 3=Sun
            let close_today = days * 86_400_000 + 20 * 3_600_000;
            if dow != 2 && dow != 3 && close_today > now {
                return close_today;
            }
            t += 86_400_000;
        }
    }
}

pub async fn build_plans(state: &Arc<AppState>) -> anyhow::Result<Vec<TradePlan>> {
    let champions: Vec<(String, String, String, StrategySpec, Option<f64>)> = {
        let champs = state.champions.lock().unwrap();
        champs
            .iter()
            .filter_map(|(k, rec)| {
                rec.spec.as_ref().map(|s| {
                    (
                        k.clone(),
                        rec.symbol.clone(),
                        rec.interval.clone(),
                        s.clone(),
                        rec.lineage.last().map(|l| l.holdout_sharpe),
                    )
                })
            })
            .collect()
    };

    let mut plans = Vec::new();
    for (key, symbol, interval_s, spec, holdout) in champions {
        let Some(interval) = Interval::parse(&interval_s) else { continue };
        let step = interval.millis();
        let end = now_ms();
        let mut klines = state
            .store
            .get(&symbol, interval, end - 1000 * step, end)
            .await?;
        klines.retain(|k| k.open_time + step <= end);
        if klines.len() < 250 {
            continue;
        }
        let last = *klines.last().unwrap();
        let target = {
            let t = spec.signals(&klines).last().copied().unwrap_or(0.0);
            if t.is_nan() {
                0.0
            } else {
                t.clamp(-1.0, 1.0)
            }
        };
        let flip = find_flip(&spec, &mut klines, target);
        plans.push(TradePlan {
            key,
            strategy: spec.name().to_string(),
            target_position: target,
            last_close: last.close,
            flip_pct: flip.map(|f| (f / last.close - 1.0) * 100.0),
            flip_price: flip,
            next_decision_ms: next_decision(&symbol, interval, last.open_time),
            holdout_sharpe: holdout,
            symbol,
            interval: interval_s,
        });
    }
    plans.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(plans)
}
