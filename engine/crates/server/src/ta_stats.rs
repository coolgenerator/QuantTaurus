//! 经典技术规则的历史统计：52+ 股票/ETF 20 年日线，按规则/个股聚合前向收益。
//!
//! 方法口径（描述统计，非独立样本检验）：
//! - 事件 = 某规则在某 symbol 某根日线上触发（同日多规则各算一个事件）
//! - 符号化收益：买入信号取前向收益，卖出信号取其相反数（做空/回避视角）
//! - 准确率 = P(10日符号化收益 > 0)；期望收益 = 10日符号化收益均值
//! - 期望止盈周期 = 每事件 20 日内符号化收益峰值出现日的均值
//! - 三级聚合：全宇宙按方向总分布 / 按规则（全标的）/ 按规则×个股
//! - 注意：事件跨标的同期相关 + 窗口重叠，胜率是经验频率而非显著性证据

use crate::state::{now_ms, AppState};
use qcore::Interval;
use serde::Serialize;
use std::collections::HashMap;

/// 统计宇宙：本地已缓存日线的全部美股/ETF（不含加密币）
pub const UNIVERSE: &[&str] = &[
    "AAPL", "ADI", "AMAT", "AMD", "AMZN", "ANET", "ARM", "ASML", "AVGO", "CEG", "COIN", "CRM",
    "CRWD", "CRWV", "DDOG", "DELL", "GEV", "GOOGL", "HOOD", "INTC", "KLAC", "LRCX", "META",
    "MRVL", "MSFT", "MSTR", "MU", "NET", "NOW", "NVDA", "NXPI", "ON", "ORCL", "PANW", "PLTR",
    "QCOM", "QQQ", "SHOP", "SMCI", "SMH", "SNDK", "SNOW", "SOXX", "SPY", "STX", "TER", "TSLA",
    "TSM", "TXN", "UBER", "VRT", "VST", "WDC",
];

/// 每个周期的回测窗口天数（受数据源历史深度限制：Yahoo 1m≈7天、5m/30m≈60天、1h≈2年）
pub fn window_days(interval: &str) -> i64 {
    match interval {
        "1d" | "1w" | "1wk" | "1mo" | "1M" | "1mon" => 7300, // 20年
        "1h" => 729,
        "30m" | "15m" | "5m" => 59,
        "1m" => 7,
        _ => 729,
    }
}
/// 前向观察窗（交易日）与头条统计日
pub const HORIZON: usize = 20;
pub const HEADLINE: usize = 10;
/// 10日收益直方图分箱边界（%）：±10/7.5/5/2.5/0 → 10 箱
pub const BIN_EDGES: &[f64] = &[-10.0, -7.5, -5.0, -2.5, 0.0, 2.5, 5.0, 7.5, 10.0];
/// 结果缓存 TTL：规则集不变时统计基本不动，6 小时足够
pub const CACHE_TTL_MS: i64 = 6 * 3600 * 1000;
/// 规则×个股最少事件数（低于此不输出，避免噪音行）
pub const MIN_SYM_N: usize = 8;

/// 一组事件的 10 日收益分布统计
#[derive(Serialize)]
pub struct DistStat {
    pub n: usize,
    pub win10: f64,
    pub avg10: f64,
    pub med10: f64,
    pub hist: Vec<usize>,
}

#[derive(Serialize)]
pub struct RuleStat {
    pub rule: String,
    pub side: &'static str,
    pub n: usize,
    pub win10: f64,
    pub avg10: f64,
    pub med10: f64,
    /// 全事件均值曲线的最优持有天数（1..=20）
    pub best_day: usize,
    /// 期望止盈周期：每事件峰值日的均值
    pub exp_tp_day: f64,
    /// 第 1..=20 日的符号化收益均值曲线
    pub curve: Vec<f64>,
    pub hist: Vec<usize>,
}

/// 规则×个股的轻量统计（不含曲线）
#[derive(Serialize)]
pub struct SymbolRuleStat {
    pub symbol: String,
    pub rule: String,
    pub side: &'static str,
    pub n: usize,
    pub win10: f64,
    pub avg10: f64,
    pub exp_tp_day: f64,
    pub hist: Vec<usize>,
}

/// 个股按方向的总分布
#[derive(Serialize)]
pub struct SymbolTotal {
    pub symbol: String,
    pub buy: DistStat,
    pub sell: DistStat,
}

#[derive(Serialize)]
pub struct TaStatsResponse {
    pub computed_ms: i64,
    pub symbols: usize,
    pub events: usize,
    pub interval: String,
    pub window_days: i64,
    pub horizon: usize,
    pub headline: usize,
    pub bin_edges: &'static [f64],
    /// 全宇宙总分布（按信号方向）
    pub total_buy: DistStat,
    pub total_sell: DistStat,
    /// 按规则聚合（全标的）
    pub rules: Vec<RuleStat>,
    /// 个股总分布
    pub symbol_totals: Vec<SymbolTotal>,
    /// 规则×个股（n ≥ MIN_SYM_N）
    pub symbol_rules: Vec<SymbolRuleStat>,
}

fn hist_bin(pct: f64) -> usize {
    BIN_EDGES.iter().position(|e| pct <= *e).unwrap_or(BIN_EDGES.len())
}

fn dist(rets: &mut Vec<f64>) -> DistStat {
    let n = rets.len();
    if n == 0 {
        return DistStat { n: 0, win10: 0.0, avg10: 0.0, med10: 0.0, hist: vec![0; BIN_EDGES.len() + 1] };
    }
    rets.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let nf = n as f64;
    let mut hist = vec![0usize; BIN_EDGES.len() + 1];
    for r in rets.iter() {
        hist[hist_bin(r * 100.0)] += 1;
    }
    DistStat {
        n,
        win10: rets.iter().filter(|r| **r > 0.0).count() as f64 / nf,
        avg10: rets.iter().sum::<f64>() / nf,
        med10: rets[n / 2],
        hist,
    }
}

#[derive(Default)]
struct Acc {
    side: &'static str,
    rets10: Vec<f64>,
    curve_sum: Vec<f64>,
    tp_day_sum: f64,
}

impl Acc {
    fn push(&mut self, side: &'static str, day_rets: &[f64; HORIZON], peak_day: usize) {
        self.side = side;
        self.rets10.push(day_rets[HEADLINE - 1]);
        if self.curve_sum.is_empty() {
            self.curve_sum = vec![0.0; HORIZON];
        }
        for d in 0..HORIZON {
            self.curve_sum[d] += day_rets[d];
        }
        self.tp_day_sum += peak_day as f64;
    }
}

/// 单标的专属统计：任意 symbol（含加密币）× 任意周期，按需计算。
/// 与全宇宙版相同口径，但不设 MIN_SYM_N 过滤（n≥3 即输出，前端自行提示小样本）。
#[derive(Serialize)]
pub struct SymbolStatsResponse {
    pub symbol: String,
    pub interval: String,
    pub window_days: i64,
    pub n_bars: usize,
    pub bin_edges: &'static [f64],
    pub total_buy: DistStat,
    pub total_sell: DistStat,
    pub rules: Vec<RuleStat>,
}

pub async fn compute_symbol(
    state: &AppState,
    interval_str: &str,
    symbol: &str,
) -> anyhow::Result<SymbolStatsResponse> {
    let interval = Interval::parse(interval_str)
        .ok_or_else(|| anyhow::anyhow!("bad interval {interval_str}"))?;
    // 股票数据源无 2h/4h；加密币（Binance）支持
    anyhow::ensure!(
        qdata::is_crypto(symbol) || !matches!(interval, Interval::H2 | Interval::H4),
        "股票数据源不支持 2h/4h 周期的统计"
    );
    let days = window_days(interval_str);
    let end = now_ms();
    let start = end - days * 86_400_000;
    let ks = state.store.get(symbol, interval, start, end).await?;
    anyhow::ensure!(ks.len() > 60, "{symbol} 在该周期下数据不足（{}根bar）", ks.len());

    let ta = crate::ta::build(&ks, None);
    let idx: HashMap<i64, usize> = ta.times.iter().enumerate().map(|(i, t)| (*t, i)).collect();
    let c: Vec<f64> = ks.iter().map(|k| k.close).collect();
    let n = c.len();

    let mut rule_acc: HashMap<String, Acc> = Default::default();
    let (mut all_buy, mut all_sell) = (Vec::new(), Vec::new());
    for sig in &ta.classic_signals {
        let Some(&i) = idx.get(&sig.time) else { continue };
        if i + HORIZON >= n {
            continue;
        }
        let side: &'static str = if sig.side == "buy" { "buy" } else { "sell" };
        let dir = if sig.side == "buy" { 1.0 } else { -1.0 };
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
        let r10 = day_rets[HEADLINE - 1];
        if side == "buy" {
            all_buy.push(r10);
        } else {
            all_sell.push(r10);
        }
        for rule in &sig.rules {
            rule_acc.entry(rule.clone()).or_default().push(side, &day_rets, peak_day);
        }
    }

    let mut rules: Vec<RuleStat> = rule_acc
        .into_iter()
        .filter(|(_, a)| a.rets10.len() >= 3)
        .map(|(rule, mut a)| {
            let nf = a.rets10.len() as f64;
            let curve: Vec<f64> = a.curve_sum.iter().map(|s| s / nf).collect();
            let best_day = curve
                .iter()
                .enumerate()
                .max_by(|x, y| x.1.partial_cmp(y.1).unwrap())
                .map(|(i, _)| i + 1)
                .unwrap_or(1);
            let exp_tp_day = a.tp_day_sum / nf;
            let side = a.side;
            let d = dist(&mut a.rets10);
            RuleStat {
                rule,
                side,
                n: d.n,
                win10: d.win10,
                avg10: d.avg10,
                med10: d.med10,
                best_day,
                exp_tp_day,
                curve,
                hist: d.hist,
            }
        })
        .collect();
    rules.sort_by(|x, y| y.avg10.partial_cmp(&x.avg10).unwrap());

    Ok(SymbolStatsResponse {
        symbol: symbol.to_string(),
        interval: interval_str.to_string(),
        window_days: days,
        n_bars: n,
        bin_edges: BIN_EDGES,
        total_buy: dist(&mut all_buy),
        total_sell: dist(&mut all_sell),
        rules,
    })
}

/// 全宇宙跑信号 + 三级聚合。数据已在本地缓存时纯 CPU。
pub async fn compute(state: &AppState, interval_str: &str) -> anyhow::Result<TaStatsResponse> {
    let interval = Interval::parse(interval_str)
        .ok_or_else(|| anyhow::anyhow!("bad interval {interval_str}"))?;
    anyhow::ensure!(
        !matches!(interval, Interval::H2 | Interval::H4),
        "股票数据源不支持 2h/4h 周期的统计"
    );
    let days = window_days(interval_str);
    let end = now_ms();
    let start = end - days * 86_400_000;

    let mut rule_acc: HashMap<String, Acc> = Default::default();
    let mut sym_rule_acc: HashMap<(String, String), Acc> = Default::default();
    let mut sym_side: HashMap<(String, &'static str), Vec<f64>> = Default::default();
    let (mut all_buy, mut all_sell) = (Vec::new(), Vec::new());
    let mut symbols_ok = 0usize;
    let mut events = 0usize;

    for sym in UNIVERSE {
        let ks = match state.store.get(sym, interval, start, end).await {
            // 月线20年也只有~240根，门槛放宽到60根（HORIZON 之外还得有样本）
            Ok(v) if v.len() > 60 => v,
            _ => continue, // 数据缺失的标的直接跳过
        };
        symbols_ok += 1;
        let ta = crate::ta::build(&ks, None);
        let idx: HashMap<i64, usize> = ta.times.iter().enumerate().map(|(i, t)| (*t, i)).collect();
        let c: Vec<f64> = ks.iter().map(|k| k.close).collect();
        let n = c.len();

        for sig in &ta.classic_signals {
            let Some(&i) = idx.get(&sig.time) else { continue };
            if i + HORIZON >= n {
                continue;
            }
            let side: &'static str = if sig.side == "buy" { "buy" } else { "sell" };
            let dir = if sig.side == "buy" { 1.0 } else { -1.0 };
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
            let r10 = day_rets[HEADLINE - 1];
            if side == "buy" {
                all_buy.push(r10);
            } else {
                all_sell.push(r10);
            }
            sym_side.entry((sym.to_string(), side)).or_default().push(r10);
            for rule in &sig.rules {
                rule_acc.entry(rule.clone()).or_default().push(side, &day_rets, peak_day);
                sym_rule_acc
                    .entry((sym.to_string(), rule.clone()))
                    .or_default()
                    .push(side, &day_rets, peak_day);
                events += 1;
            }
        }
    }

    let mut rules: Vec<RuleStat> = rule_acc
        .into_iter()
        .map(|(rule, mut a)| {
            let nf = a.rets10.len() as f64;
            let curve: Vec<f64> = a.curve_sum.iter().map(|s| s / nf).collect();
            let best_day = curve
                .iter()
                .enumerate()
                .max_by(|x, y| x.1.partial_cmp(y.1).unwrap())
                .map(|(i, _)| i + 1)
                .unwrap_or(1);
            let exp_tp_day = a.tp_day_sum / nf;
            let side = a.side;
            let d = dist(&mut a.rets10);
            RuleStat {
                rule,
                side,
                n: d.n,
                win10: d.win10,
                avg10: d.avg10,
                med10: d.med10,
                best_day,
                exp_tp_day,
                curve,
                hist: d.hist,
            }
        })
        .collect();
    rules.sort_by(|x, y| y.avg10.partial_cmp(&x.avg10).unwrap());

    let mut symbol_rules: Vec<SymbolRuleStat> = sym_rule_acc
        .into_iter()
        .filter(|(_, a)| a.rets10.len() >= MIN_SYM_N)
        .map(|((symbol, rule), mut a)| {
            let nf = a.rets10.len() as f64;
            let exp_tp_day = a.tp_day_sum / nf;
            let side = a.side;
            let d = dist(&mut a.rets10);
            SymbolRuleStat {
                symbol,
                rule,
                side,
                n: d.n,
                win10: d.win10,
                avg10: d.avg10,
                exp_tp_day,
                hist: d.hist,
            }
        })
        .collect();
    symbol_rules.sort_by(|x, y| y.avg10.partial_cmp(&x.avg10).unwrap());

    let mut symbol_totals: Vec<SymbolTotal> = UNIVERSE
        .iter()
        .filter_map(|sym| {
            let mut b = sym_side.remove(&(sym.to_string(), "buy")).unwrap_or_default();
            let mut s = sym_side.remove(&(sym.to_string(), "sell")).unwrap_or_default();
            if b.is_empty() && s.is_empty() {
                return None;
            }
            Some(SymbolTotal { symbol: sym.to_string(), buy: dist(&mut b), sell: dist(&mut s) })
        })
        .collect();
    symbol_totals.sort_by(|x, y| y.buy.avg10.partial_cmp(&x.buy.avg10).unwrap());

    Ok(TaStatsResponse {
        computed_ms: now_ms(),
        symbols: symbols_ok,
        events,
        interval: interval_str.to_string(),
        window_days: days,
        horizon: HORIZON,
        headline: HEADLINE,
        bin_edges: BIN_EDGES,
        total_buy: dist(&mut all_buy),
        total_sell: dist(&mut all_sell),
        rules,
        symbol_totals,
        symbol_rules,
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

    #[test]
    fn dist_basic() {
        let mut rets = vec![0.02, -0.01, 0.05, 0.01];
        let d = dist(&mut rets);
        assert_eq!(d.n, 4);
        assert!((d.win10 - 0.75).abs() < 1e-9);
        assert_eq!(d.hist.iter().sum::<usize>(), 4);
    }
}
