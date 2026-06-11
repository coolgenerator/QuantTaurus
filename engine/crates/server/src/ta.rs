//! 技术分析端点的组装层：权威指标全集 + 趋势 + 双层买卖点信号。
//!
//! 36 条经典规则引擎在 qfactors::ta_rules（图表/统计/仓位调制/RuleVote 共用），
//! 这里负责指标序列组装与冠军信号叠加。经典信号**未经回测闸门验证**，仅作图表参考。

use qcore::Kline;
use qfactors::ta_rules;
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
    /// SuperTrend(10,3)：多头段走下轨（绿）/ 空头段走上轨（红），分两列方便前端着色
    pub st_up: Vec<Option<f64>>,
    pub st_dn: Vec<Option<f64>>,
    /// ADX(14) 趋势强度：>25 视为强趋势
    pub adx: Vec<Option<f64>>,
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
    let (boll_up, boll_mid, boll_dn) = ta_rules::bollinger_bands(klines, 20);
    let (dif, dea, hist) = qfactors::macd_full(klines, 12, 26, 9);
    let rsi14 = qfactors::rsi(klines, 14);
    let (kdj_k, kdj_d, kdj_j) = qfactors::kdj(klines, 9, 3, 3);
    let (st_up, st_dn, _st_flips) = ta_rules::supertrend(klines, 10, 3.0);
    let adx14 = ta_rules::adx(klines, 14);

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

    // 36 条规则事件 → 按 bar 聚合为 buy/sell 信号
    let mut classic_signals = Vec::new();
    let hits = ta_rules::classic_rule_events(klines);
    let mut i = 0usize;
    while i < hits.len() {
        let idx = hits[i].idx;
        let mut buys: Vec<String> = Vec::new();
        let mut sells: Vec<String> = Vec::new();
        while i < hits.len() && hits[i].idx == idx {
            if hits[i].side > 0 {
                buys.push(hits[i].rule.clone());
            } else {
                sells.push(hits[i].rule.clone());
            }
            i += 1;
        }
        if !buys.is_empty() {
            classic_signals.push(TaSignal {
                time: times[idx],
                side: "buy",
                strength: buys.len(),
                rules: buys,
                price: c[idx],
            });
        }
        if !sells.is_empty() {
            classic_signals.push(TaSignal {
                time: times[idx],
                side: "sell",
                strength: sells.len(),
                rules: sells,
                price: c[idx],
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
        st_up: opt(&st_up),
        st_dn: opt(&st_dn),
        adx: opt(&adx14),
        trend,
        classic_signals,
        champion_signals,
        champion: champion_name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use qfactors::ta_rules::{adx, divergences, structure_patterns, supertrend, td9};

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
    fn td9_counts_nine_consecutive() {
        let closes: Vec<f64> = (0..20).map(|i| 100.0 - i as f64).collect();
        let hits = td9(&closes);
        assert_eq!(hits.first(), Some(&(12, "buy")));
        let closes_up: Vec<f64> = (0..20).map(|i| 100.0 + i as f64).collect();
        assert_eq!(td9(&closes_up).first(), Some(&(12, "sell")));
    }

    #[test]
    fn divergence_detects_lower_indicator_high() {
        let mut close = vec![100.0; 40];
        let mut ind = vec![0.0; 40];
        close[10] = 110.0;
        close[25] = 115.0;
        ind[10] = 50.0;
        ind[25] = 30.0;
        let out = divergences(&close, &ind, 4, 60, "X");
        assert!(out.iter().any(|(i, side, r)| *i == 29 && *side == "sell" && r == "X顶背离"));
    }

    #[test]
    fn donchian_breakout_fires_on_cross_bar() {
        let mut closes = vec![100.0; 30];
        closes.push(110.0);
        closes.extend(vec![110.5; 5]);
        let ks = fake_klines(&closes);
        let r = build(&ks, None);
        let hit = r
            .classic_signals
            .iter()
            .find(|s| s.rules.iter().any(|x| x.contains("唐奇安20日上破") || x.contains("放量突破")));
        assert!(hit.is_some(), "expected donchian breakout signal");
        assert_eq!(hit.unwrap().time, 30 * 86_400_000);
    }

    #[test]
    fn bullish_engulfing_in_downtrend() {
        let k = |t: i64, o: f64, h: f64, l: f64, c: f64| Kline {
            open_time: t * 86_400_000,
            open: o,
            high: h,
            low: l,
            close: c,
            volume: 100.0,
            taker_buy_volume: 60.0,
            trades: 10,
        };
        let mut ks: Vec<Kline> = (0..30)
            .map(|i| {
                let base = 130.0 - i as f64;
                k(i as i64, base, base + 0.6, base - 1.4, base - 1.0)
            })
            .collect();
        ks.push(k(30, 99.5, 102.2, 99.0, 102.0));
        let r = build(&ks, None);
        let hit = r
            .classic_signals
            .iter()
            .find(|s| s.side == "buy" && s.rules.iter().any(|x| x == "看涨吞没"));
        assert!(hit.is_some(), "expected bullish engulfing signal");
        assert_eq!(hit.unwrap().time, 30 * 86_400_000);
    }

    #[test]
    fn double_top_neckline_break() {
        let mut c: Vec<f64> = (0..10).map(|i| 90.0 + 2.0 * i as f64).collect();
        c.push(110.0);
        c.extend([108.0, 106.0, 104.0, 102.0]);
        c.push(100.0);
        c.extend([102.0, 104.0, 106.0, 108.0]);
        c.push(110.3);
        c.extend([108.0, 105.0, 102.0, 99.0, 98.0]);
        let hits = structure_patterns(&c, 4);
        assert!(
            hits.iter().any(|(j, side, r)| *j == 24 && *side == "sell" && r == "双顶颈线破位"),
            "got {hits:?}"
        );
    }

    #[test]
    fn supertrend_flips_on_v_shape() {
        let mut closes: Vec<f64> = (0..40).map(|i| 200.0 - 3.0 * i as f64).collect();
        closes.extend((0..40).map(|i| 80.0 + 3.0 * i as f64));
        let ks = fake_klines(&closes);
        let (st_up, st_dn, flips) = supertrend(&ks, 10, 3.0);
        assert!(flips.iter().any(|(_, s)| *s == "buy"), "expected a buy flip, got {flips:?}");
        for i in 0..ks.len() {
            assert!(!(st_up[i].is_finite() && st_dn[i].is_finite()), "both rails at {i}");
        }
        let a = adx(&ks, 14);
        assert!(a.iter().any(|x| x.is_finite() && *x > 25.0), "strong trend should push ADX>25");
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
        assert!(r.champion_signals.iter().any(|s| s.side == "buy"));
    }
}
