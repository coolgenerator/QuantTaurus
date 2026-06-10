//! 经典技术规则的历史统计：52 个股票/ETF 全历史日线，按规则聚合前向收益。
//!
//! 方法口径（描述统计，非独立样本检验）：
//! - 事件 = 某规则在某 symbol 某根日线上触发（同日多规则各算一个事件）
//! - 符号化收益：买入信号取前向收益，卖出信号取其相反数（做空/回避视角）
//! - 准确率 = P(10日符号化收益 > 0)；期望收益 = 10日符号化收益均值
//! - 期望止盈周期 = 每事件 20 日内符号化收益峰值出现日的均值
//! - 注意：事件跨标的同期相关 + 窗口重叠，胜率是经验频率而非显著性证据

use crate::state::{now_ms, AppState};
use qcore::Interval;
use serde::Serialize;

/// 统计宇宙：本地已缓存日线的全部美股/ETF（52 个，不含加密币）
pub const UNIVERSE: &[&str] = &[
    "AAPL", "ADI", "AMAT", "AMD", "AMZN", "ANET", "ARM", "ASML", "AVGO", "CEG", "COIN", "CRM",
    "CRWD", "CRWV", "DDOG", "DELL", "GEV", "GOOGL", "HOOD", "INTC", "KLAC", "LRCX", "META",
    "MRVL", "MSFT", "MSTR", "MU", "NET", "NOW", "NVDA", "NXPI", "ON", "ORCL", "PANW", "PLTR",
    "QCOM", "QQQ", "SHOP", "SMCI", "SMH", "SNDK", "SNOW", "SOXX", "SPY", "STX", "TER", "TSLA",
    "TSM", "TXN", "UBER", "VRT", "VST", "WDC",
];

/// 前向观察窗（交易日）与头条统计日
pub const HORIZON: usize = 20;
pub const HEADLINE: usize = 10;
/// 10日收益直方图分箱边界（%）：±10/7.5/5/2.5/0 → 10 箱
pub const BIN_EDGES: &[f64] = &[-10.0, -7.5, -5.0, -2.5, 0.0, 2.5, 5.0, 7.5, 10.0];
/// 结果缓存 TTL：规则集不变时统计基本不动，6 小时足够
pub const CACHE_TTL_MS: i64 = 6 * 3600 * 1000;

#[derive(Serialize)]
pub struct RuleStat {
    pub rule: String,
    pub side: &'static str,
    /// 有完整 20 日前向窗的事件数
    pub n: usize,
    /// P(10日符号化收益 > 0)
    pub win10: f64,
    /// 10日符号化收益均值 / 中位数（小数，0.01 = 1%）
    pub avg10: f64,
    pub med10: f64,
    /// 全事件均值曲线的最优持有天数（1..=20）
    pub best_day: usize,
    /// 期望止盈周期：每事件峰值日的均值
    pub exp_tp_day: f64,
    /// 第 1..=20 日的符号化收益均值曲线
    pub curve: Vec<f64>,
    /// 10日符号化收益分布（BIN_EDGES 划分的 10 箱计数）
    pub hist: Vec<usize>,
}

#[derive(Serialize)]
pub struct TaStatsResponse {
    pub computed_ms: i64,
    pub symbols: usize,
    pub events: usize,
    pub horizon: usize,
    pub headline: usize,
    pub bin_edges: &'static [f64],
    pub rules: Vec<RuleStat>,
}

struct Acc {
    side: &'static str,
    rets10: Vec<f64>,
    /// 每日均值曲线的累加器
    curve_sum: [f64; HORIZON],
    tp_day_sum: f64,
    n: usize,
}

fn hist_bin(pct: f64) -> usize {
    BIN_EDGES.iter().position(|e| pct <= *e).unwrap_or(BIN_EDGES.len())
}

/// 全宇宙跑信号 + 聚合。数据已在本地缓存时纯 CPU，~秒级。
pub async fn compute(state: &AppState) -> anyhow::Result<TaStatsResponse> {
    let interval = Interval::parse("1d").expect("1d valid");
    let end = now_ms();
    let start = end - 3650 * 86_400_000; // 10 年
    let mut accs: std::collections::HashMap<String, Acc> = Default::default();
    let mut symbols_ok = 0usize;
    let mut events = 0usize;

    for sym in UNIVERSE {
        let ks = match state.store.get(sym, interval, start, end).await {
            Ok(v) if v.len() > 250 => v,
            _ => continue, // 数据缺失的标的直接跳过，不让单标的拖垮全量统计
        };
        symbols_ok += 1;
        let ta = crate::ta::build(&ks, None);
        // time → bar index
        let idx: std::collections::HashMap<i64, usize> =
            ta.times.iter().enumerate().map(|(i, t)| (*t, i)).collect();
        let c: Vec<f64> = ks.iter().map(|k| k.close).collect();
        let n = c.len();

        for sig in &ta.classic_signals {
            let Some(&i) = idx.get(&sig.time) else { continue };
            if i + HORIZON >= n {
                continue; // 前向窗不完整
            }
            let dir = if sig.side == "buy" { 1.0 } else { -1.0 };
            // 每日符号化收益 + 峰值日
            let mut day_rets = [0.0f64; HORIZON];
            let (mut peak, mut peak_day) = (f64::MIN, 1usize);
            for d in 1..=HORIZON {
                let r = dir * (c[i + d] / c[i] - 1.0);
                day_rets[d - 1] = r;
                if r > peak {
                    peak = r;
                    peak_day = d;
                }
            }
            for rule in &sig.rules {
                let acc = accs.entry(rule.clone()).or_insert_with(|| Acc {
                    side: if sig.side == "buy" { "buy" } else { "sell" },
                    rets10: Vec::new(),
                    curve_sum: [0.0; HORIZON],
                    tp_day_sum: 0.0,
                    n: 0,
                });
                acc.n += 1;
                acc.rets10.push(day_rets[HEADLINE - 1]);
                for d in 0..HORIZON {
                    acc.curve_sum[d] += day_rets[d];
                }
                acc.tp_day_sum += peak_day as f64;
                events += 1;
            }
        }
    }

    let mut rules: Vec<RuleStat> = accs
        .into_iter()
        .map(|(rule, mut a)| {
            let nf = a.n as f64;
            a.rets10.sort_by(|x, y| x.partial_cmp(y).unwrap());
            let med10 = a.rets10[a.n / 2];
            let win10 = a.rets10.iter().filter(|r| **r > 0.0).count() as f64 / nf;
            let avg10 = a.rets10.iter().sum::<f64>() / nf;
            let curve: Vec<f64> = a.curve_sum.iter().map(|s| s / nf).collect();
            let best_day = curve
                .iter()
                .enumerate()
                .max_by(|x, y| x.1.partial_cmp(y.1).unwrap())
                .map(|(i, _)| i + 1)
                .unwrap_or(1);
            let mut hist = vec![0usize; BIN_EDGES.len() + 1];
            for r in &a.rets10 {
                hist[hist_bin(r * 100.0)] += 1;
            }
            RuleStat {
                rule,
                side: a.side,
                n: a.n,
                win10,
                avg10,
                med10,
                best_day,
                exp_tp_day: a.tp_day_sum / nf,
                curve,
                hist,
            }
        })
        .collect();
    rules.sort_by(|x, y| y.avg10.partial_cmp(&x.avg10).unwrap());

    Ok(TaStatsResponse {
        computed_ms: now_ms(),
        symbols: symbols_ok,
        events,
        horizon: HORIZON,
        headline: HEADLINE,
        bin_edges: BIN_EDGES,
        rules,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hist_bins_cover_all() {
        assert_eq!(hist_bin(-99.0), 0);
        assert_eq!(hist_bin(-10.0), 0);
        assert_eq!(hist_bin(-0.1), 4);
        assert_eq!(hist_bin(0.1), 5);
        assert_eq!(hist_bin(99.0), BIN_EDGES.len());
    }
}
