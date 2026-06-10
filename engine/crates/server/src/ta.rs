//! 技术分析端点的纯计算层：权威指标全集 + 趋势 + 双层买卖点信号。
//!
//! 经典信号是教科书口径（金叉死叉/超买超卖/布林触轨回收），**未经回测闸门验证**，
//! 仅作图表参考；冠军信号来自注册表里通过 evolve 闸门的策略，是两套独立的层。

use qcore::Kline;
use qstrategy::StrategySpec;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct TaSignal {
    pub time: i64,
    /// "buy" | "sell"
    pub side: &'static str,
    pub rules: Vec<String>,
    /// 同一 bar 命中的规则数（≥2 视为共振强信号）
    pub strength: usize,
    pub price: f64,
}

#[derive(Debug, Serialize)]
pub struct TaResponse {
    pub times: Vec<i64>,
    pub ma20: Vec<Option<f64>>,
    pub ma50: Vec<Option<f64>>,
    pub ma200: Vec<Option<f64>>,
    pub ema12: Vec<Option<f64>>,
    pub ema26: Vec<Option<f64>>,
    pub boll_up: Vec<Option<f64>>,
    pub boll_mid: Vec<Option<f64>>,
    pub boll_dn: Vec<Option<f64>>,
    pub macd_dif: Vec<Option<f64>>,
    pub macd_dea: Vec<Option<f64>>,
    pub macd_hist: Vec<Option<f64>>,
    pub rsi14: Vec<Option<f64>>,
    pub kdj_k: Vec<Option<f64>>,
    pub kdj_d: Vec<Option<f64>>,
    pub kdj_j: Vec<Option<f64>>,
    /// 每 bar 趋势：1 多头 / -1 空头 / 0 震荡或 MA200 未就绪
    pub trend: Vec<i8>,
    pub classic_signals: Vec<TaSignal>,
    pub champion_signals: Vec<TaSignal>,
    /// 冠军槽位名（如 "SPY|1d"）；该标的无冠军时为 None
    pub champion: Option<String>,
}

fn opt(v: &[f64]) -> Vec<Option<f64>> {
    v.iter()
        .map(|x| if x.is_finite() { Some(*x) } else { None })
        .collect()
}

/// 布林带 (n, 2σ)：返回 (上轨, 中轨, 下轨)。
fn bollinger_bands(klines: &[Kline], n: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let c: Vec<f64> = klines.iter().map(|k| k.close).collect();
    let len = c.len();
    let (mut up, mut mid, mut dn) = (
        vec![f64::NAN; len],
        vec![f64::NAN; len],
        vec![f64::NAN; len],
    );
    for i in n..len {
        let w = &c[i + 1 - n..=i];
        let m = qfactors::mean(w);
        let s = qfactors::std_dev(w);
        mid[i] = m;
        up[i] = m + 2.0 * s;
        dn[i] = m - 2.0 * s;
    }
    (up, mid, dn)
}

pub fn build(
    klines: &[Kline],
    champion: Option<(String, &StrategySpec)>,
) -> TaResponse {
    let n = klines.len();
    let c: Vec<f64> = klines.iter().map(|k| k.close).collect();
    let times: Vec<i64> = klines.iter().map(|k| k.open_time).collect();

    let ma20 = qfactors::sma(klines, 20);
    let ma50 = qfactors::sma(klines, 50);
    let ma200 = qfactors::sma(klines, 200);
    let ema12 = qfactors::ema(&c, 12);
    let ema26 = qfactors::ema(&c, 26);
    let (boll_up, boll_mid, boll_dn) = bollinger_bands(klines, 20);
    let (dif, dea, hist) = qfactors::macd_full(klines, 12, 26, 9);
    let rsi14 = qfactors::rsi(klines, 14);
    let (kdj_k, kdj_d, kdj_j) = qfactors::kdj(klines, 9, 3, 3);

    // 趋势：收盘与 MA200、MA50 与 MA200 的权威口径
    let trend: Vec<i8> = (0..n)
        .map(|i| {
            if !ma200[i].is_finite() || !ma50[i].is_finite() {
                0
            } else if c[i] > ma200[i] && ma50[i] > ma200[i] {
                1
            } else if c[i] < ma200[i] && ma50[i] < ma200[i] {
                -1
            } else {
                0
            }
        })
        .collect();

    // 经典规则信号：逐 bar 收集命中规则，按 buy/sell 各聚合为一个信号
    let mut classic_signals = Vec::new();
    for i in 1..n {
        let mut buys: Vec<String> = Vec::new();
        let mut sells: Vec<String> = Vec::new();

        // MACD 柱穿零轴
        if hist[i - 1].is_finite() && hist[i].is_finite() {
            if hist[i - 1] <= 0.0 && hist[i] > 0.0 {
                buys.push("MACD金叉".into());
            } else if hist[i - 1] >= 0.0 && hist[i] < 0.0 {
                sells.push("MACD死叉".into());
            }
        }
        // RSI 超卖回升 / 超买回落
        if rsi14[i - 1].is_finite() && rsi14[i].is_finite() {
            if rsi14[i - 1] < 30.0 && rsi14[i] >= 30.0 {
                buys.push("RSI超卖回升".into());
            } else if rsi14[i - 1] > 70.0 && rsi14[i] <= 70.0 {
                sells.push("RSI超买回落".into());
            }
        }
        // 布林触轨后收回
        if boll_dn[i - 1].is_finite() && boll_dn[i].is_finite() {
            if c[i - 1] < boll_dn[i - 1] && c[i] >= boll_dn[i] {
                buys.push("布林下轨收回".into());
            } else if c[i - 1] > boll_up[i - 1] && c[i] <= boll_up[i] {
                sells.push("布林上轨回落".into());
            }
        }
        // KDJ 低位金叉 / 高位死叉
        if kdj_k[i - 1].is_finite() && kdj_d[i - 1].is_finite() && kdj_k[i].is_finite() {
            let crossed_up = kdj_k[i - 1] <= kdj_d[i - 1] && kdj_k[i] > kdj_d[i];
            let crossed_dn = kdj_k[i - 1] >= kdj_d[i - 1] && kdj_k[i] < kdj_d[i];
            if crossed_up && kdj_d[i] < 30.0 {
                buys.push("KDJ低位金叉".into());
            } else if crossed_dn && kdj_d[i] > 70.0 {
                sells.push("KDJ高位死叉".into());
            }
        }

        if !buys.is_empty() {
            classic_signals.push(TaSignal {
                time: times[i],
                side: "buy",
                strength: buys.len(),
                rules: buys,
                price: c[i],
            });
        }
        if !sells.is_empty() {
            classic_signals.push(TaSignal {
                time: times[i],
                side: "sell",
                strength: sells.len(),
                rules: sells,
                price: c[i],
            });
        }
    }

    // 冠军策略信号：仓位符号翻转点（deadband 0.05 过滤微小仓位抖动）
    let mut champion_signals = Vec::new();
    let mut champion_name = None;
    if let Some((name, spec)) = champion {
        let pos = spec.signals(klines);
        let sign = |p: f64| -> i8 {
            if p > 0.05 {
                1
            } else if p < -0.05 {
                -1
            } else {
                0
            }
        };
        let mut prev = 0i8;
        for i in 0..n {
            let s = sign(pos[i]);
            if s != prev {
                let (side, rule): (&'static str, &str) = match (prev, s) {
                    (_, 1) => ("buy", "冠军建多"),
                    (1, _) => ("sell", "冠军平多"),
                    (_, -1) => ("sell", "冠军建空"),
                    _ => ("buy", "冠军平空"),
                };
                champion_signals.push(TaSignal {
                    time: times[i],
                    side,
                    rules: vec![rule.to_string()],
                    strength: 1,
                    price: c[i],
                });
            }
            prev = s;
        }
        champion_name = Some(name);
    }

    TaResponse {
        times,
        ma20: opt(&ma20),
        ma50: opt(&ma50),
        ma200: opt(&ma200),
        ema12: opt(&ema12),
        ema26: opt(&ema26),
        boll_up: opt(&boll_up),
        boll_mid: opt(&boll_mid),
        boll_dn: opt(&boll_dn),
        macd_dif: opt(&dif),
        macd_dea: opt(&dea),
        macd_hist: opt(&hist),
        rsi14: opt(&rsi14),
        kdj_k: opt(&kdj_k),
        kdj_d: opt(&kdj_d),
        kdj_j: opt(&kdj_j),
        trend,
        classic_signals,
        champion_signals,
        champion: champion_name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_klines(closes: &[f64]) -> Vec<Kline> {
        closes
            .iter()
            .enumerate()
            .map(|(i, &c)| Kline {
                open_time: i as i64 * 86_400_000,
                open: c,
                high: c * 1.01,
                low: c * 0.99,
                close: c,
                volume: 100.0,
                taker_buy_volume: 60.0,
                trades: 10,
            })
            .collect()
    }

    #[test]
    fn build_shapes_align() {
        // V 形走势制造超卖回升，确保产出经典买点且各序列等长
        let mut closes: Vec<f64> = (0..260).map(|i| 100.0 + i as f64 * 0.2).collect();
        for i in 0..30 {
            closes.push(152.0 - i as f64 * 2.0);
        }
        for i in 0..30 {
            closes.push(92.0 + i as f64 * 2.0);
        }
        let ks = fake_klines(&closes);
        let r = build(&ks, None);
        assert_eq!(r.times.len(), ks.len());
        assert_eq!(r.ma200.len(), ks.len());
        assert_eq!(r.trend.len(), ks.len());
        assert!(r.classic_signals.iter().any(|s| s.side == "buy"));
        assert!(r.champion.is_none() && r.champion_signals.is_empty());
    }

    #[test]
    fn champion_flip_points() {
        let closes: Vec<f64> = (0..120).map(|i| 100.0 * (1.0 + 0.01 * i as f64)).collect();
        let ks = fake_klines(&closes);
        let spec = StrategySpec::Tsmom {
            lookback: 10,
            deadband: 0.0,
        };
        let r = build(&ks, Some(("TEST|1d".to_string(), &spec)));
        assert_eq!(r.champion.as_deref(), Some("TEST|1d"));
        // 单边上涨的 tsmom 至少有一次建多
        assert!(r.champion_signals.iter().any(|s| s.side == "buy"));
    }
}
