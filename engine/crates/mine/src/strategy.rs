//! 横截面多空策略回测：因子组合 → 每期做多前分位/做空后分位。
//!
//! 范式：Jegadeesh & Titman (1993) / Fama-French 组合构建。
//! - 信号：各因子横截面 z 分等权平均（因子库已方向归一）
//! - t 收盘算信号，t+1 起持有至下次调仓（无前视）
//! - 美元中性：多头 +0.5 / 空头 −0.5 总敞口；成本按调仓换手计

use crate::expr::Expr;
use crate::panel::Panel;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CsBtConfig {
    /// 调仓间隔（交易日），与挖掘 horizon 对齐
    pub rebalance_days: usize,
    /// 多/空各取的分位（0.2 = 前后各20%）
    pub top_frac: f64,
    /// 单边成本（费率+滑点），按换手扣
    pub cost_per_side: f64,
}

impl Default for CsBtConfig {
    fn default() -> Self {
        Self {
            rebalance_days: 5,
            top_frac: 0.2,
            cost_per_side: 0.0005, // moomoo 零佣金 + 滑点 ~5bp
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CsBtResult {
    /// 与 dates 对齐的组合日收益（首段 NaN 暖机期为 0）
    pub daily_rets: Vec<f64>,
    pub dates: Vec<i64>,
    pub equity: Vec<f64>,
    pub avg_turnover_per_rebalance: f64,
    pub n_rebalances: usize,
    /// 每次调仓的多/空名单大小
    pub names_per_side: usize,
}

/// 因子组合的横截面 z 分（各因子 z 后等权平均）
pub fn combined_z(panel: &Panel, exprs: &[Expr]) -> Vec<Vec<f64>> {
    let n_s = panel.n_symbols();
    let n_t = panel.n_dates();
    let mut acc = vec![vec![0.0f64; n_t]; n_s];
    let mut cnt = vec![vec![0u32; n_t]; n_s];
    for e in exprs {
        let mut z = e.eval(panel);
        crate::gp::cs_zscore_pub(&mut z);
        for s in 0..n_s {
            for t in 0..n_t {
                if z[s][t].is_finite() {
                    acc[s][t] += z[s][t];
                    cnt[s][t] += 1;
                }
            }
        }
    }
    for s in 0..n_s {
        for t in 0..n_t {
            if cnt[s][t] > 0 {
                acc[s][t] /= cnt[s][t] as f64;
            } else {
                acc[s][t] = f64::NAN;
            }
        }
    }
    acc
}

pub fn backtest_cs(panel: &Panel, exprs: &[Expr], cfg: &CsBtConfig) -> CsBtResult {
    let z = combined_z(panel, exprs);
    let n_s = panel.n_symbols();
    let n_t = panel.n_dates();
    const WARMUP: usize = 130;

    let mut weights = vec![0.0f64; n_s];
    let mut daily = vec![0.0f64; n_t];
    let mut turnovers = Vec::new();
    let mut names_per_side = 0usize;
    let mut next_rebalance = WARMUP;

    for t in WARMUP..n_t {
        // 当日组合收益（用昨日定下的权重 × 今日收益）
        let mut r = 0.0;
        for s in 0..n_s {
            if weights[s] != 0.0 && panel.ret1[s][t].is_finite() {
                r += weights[s] * (panel.ret1[s][t].exp() - 1.0);
            }
        }
        daily[t] += r;

        // 收盘调仓（信号只用 ≤t 数据；新权重从 t+1 生效）
        if t >= next_rebalance && t + 1 < n_t {
            let mut ranked: Vec<(usize, f64)> = (0..n_s)
                .filter_map(|s| {
                    let v = z[s][t];
                    if v.is_finite() && panel.close[s][t].is_finite() {
                        Some((s, v))
                    } else {
                        None
                    }
                })
                .collect();
            if ranked.len() >= 10 {
                ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
                let k = ((ranked.len() as f64 * cfg.top_frac).floor() as usize).max(2);
                names_per_side = k;
                let mut new_w = vec![0.0f64; n_s];
                for (s, _) in ranked.iter().take(k) {
                    new_w[*s] = 0.5 / k as f64;
                }
                for (s, _) in ranked.iter().rev().take(k) {
                    new_w[*s] = -0.5 / k as f64;
                }
                let turnover: f64 = (0..n_s).map(|s| (new_w[s] - weights[s]).abs()).sum();
                turnovers.push(turnover);
                // 成本计在调仓日
                daily[t] -= turnover * cfg.cost_per_side;
                weights = new_w;
            }
            next_rebalance = t + cfg.rebalance_days;
        }
    }

    let mut equity = Vec::with_capacity(n_t);
    let mut e = 1.0f64;
    for &r in &daily {
        e *= 1.0 + r;
        equity.push(e);
    }
    CsBtResult {
        daily_rets: daily,
        dates: panel.dates.clone(),
        equity,
        avg_turnover_per_rebalance: if turnovers.is_empty() {
            0.0
        } else {
            turnovers.iter().sum::<f64>() / turnovers.len() as f64
        },
        n_rebalances: turnovers.len(),
        names_per_side,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::panel::Panel;
    use qcore::Kline;

    #[test]
    fn cs_backtest_runs_and_is_cost_sensitive() {
        // 复用 gp 测试的合成面板逻辑：内嵌反转信号
        let mut state = 7u64;
        let mut rnd = move || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((state >> 33) as f64 / (1u64 << 31) as f64) - 1.0
        };
        let series: Vec<(String, Vec<Kline>)> = (0..20)
            .map(|s| {
                let mut c = 100.0;
                let mut shock = 0.0f64;
                let ks: Vec<Kline> = (0..600)
                    .map(|t| {
                        let new_shock = 0.02 * rnd();
                        let r = new_shock - shock / 5.0 + 0.003 * rnd();
                        shock = shock * 0.8 + new_shock;
                        c *= 1.0 + r;
                        Kline {
                            open_time: t as i64 * 86_400_000,
                            open: c, high: c, low: c, close: c,
                            volume: 100.0, taker_buy_volume: 50.0, trades: 1,
                        }
                    })
                    .collect();
                (format!("S{s}"), ks)
            })
            .collect();
        let p = Panel::build(&series, 0.9);
        // 反转因子（已知方向）
        let f = Expr::Neg(Box::new(Expr::TsDelta(
            Box::new(Expr::SignedLog(Box::new(Expr::Close))),
            5,
        )));
        let r_free = backtest_cs(&p, &[f.clone()], &CsBtConfig { cost_per_side: 0.0, ..Default::default() });
        let r_cost = backtest_cs(&p, &[f], &CsBtConfig { cost_per_side: 0.002, ..Default::default() });
        assert!(r_free.n_rebalances > 50);
        // 嵌入信号应在零成本下赚钱
        assert!(*r_free.equity.last().unwrap() > 1.0);
        // 成本必须降低净值（敏感性检查）
        assert!(r_cost.equity.last().unwrap() < r_free.equity.last().unwrap());
    }
}
