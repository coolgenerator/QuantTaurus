//! 策略库：参数化策略 → 目标仓位序列。
//!
//! 每个策略由 `StrategySpec`（类型 + 参数）描述，可序列化、可被 evolve crate 变异。
//!
//! 策略学术依据：
//! - TSMOM: Moskowitz, Ooi & Pedersen (2012)
//! - VolManagedMomentum: Moreira & Muir (2017) — 用波动率倒数缩放动量仓位
//! - BollingerReversion: 经典均值回归（布林带）
//! - MultiFactor: 多因子线性打分（动量 + 流不平衡 + 量价相关）

use qcore::Kline;
use rand::Rng;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StrategySpec {
    /// 时序动量：N期动量为正做多、为负做空，带死区
    Tsmom { lookback: usize, deadband: f64 },
    /// 波动率管理动量：仓位 = sign(mom) × min(1, vol_target / realized_vol)
    VolManagedMomentum {
        lookback: usize,
        vol_window: usize,
        /// 每bar目标波动（如 1h bar 0.005）
        vol_target: f64,
    },
    /// 布林带均值回归：z < -entry 做多，z > entry 做空，|z| < exit 平仓
    BollingerReversion {
        window: usize,
        entry_z: f64,
        exit_z: f64,
    },
    /// 多因子打分：w·[momentum_z, flow_imbalance, -vol_z]，tanh 压缩成仓位
    MultiFactor {
        mom_lookback: usize,
        flow_window: usize,
        vol_window: usize,
        w_mom: f64,
        w_flow: f64,
        w_vol: f64,
    },
    /// 经典技术规则投票（长仓 only）：所选买入规则当bar票数 ≥ min_votes 进场，
    /// 持有 hold_bars 根；持有期内出现 ≥2 票卖出共振提前离场。
    /// rule_mask 按 qfactors::ta_rules::BUY_RULES 下标寻址（20条）。
    RuleVote {
        rule_mask: u64,
        min_votes: usize,
        hold_bars: usize,
    },
    /// 组合策略：成员目标仓位的等权平均（方差降低，evolve 用 top-k 多样化候选构建）
    Ensemble { members: Vec<StrategySpec> },
}

impl StrategySpec {
    pub fn name(&self) -> &'static str {
        match self {
            StrategySpec::Tsmom { .. } => "tsmom",
            StrategySpec::VolManagedMomentum { .. } => "vol_managed_momentum",
            StrategySpec::BollingerReversion { .. } => "bollinger_reversion",
            StrategySpec::MultiFactor { .. } => "multi_factor",
            StrategySpec::RuleVote { .. } => "rule_vote",
            StrategySpec::Ensemble { .. } => "ensemble",
        }
    }

    /// 计算目标仓位序列（与 klines 等长，NaN 处为 0）
    pub fn signals(&self, klines: &[Kline]) -> Vec<f64> {
        if let StrategySpec::Ensemble { members } = self {
            let mut acc = vec![0.0f64; klines.len()];
            if members.is_empty() {
                return acc;
            }
            for m in members {
                for (a, s) in acc.iter_mut().zip(m.signals(klines)) {
                    *a += s;
                }
            }
            let k = members.len() as f64;
            for a in &mut acc {
                *a /= k;
            }
            return acc;
        }
        match *self {
            StrategySpec::Tsmom { lookback, deadband } => {
                let mom = qfactors::momentum(klines, lookback);
                mom.iter()
                    .map(|&m| {
                        if m.is_nan() || m.abs() < deadband {
                            0.0
                        } else {
                            m.signum()
                        }
                    })
                    .collect()
            }
            StrategySpec::VolManagedMomentum {
                lookback,
                vol_window,
                vol_target,
            } => {
                let mom = qfactors::momentum(klines, lookback);
                let vol = qfactors::realized_vol(klines, vol_window);
                mom.iter()
                    .zip(&vol)
                    .map(|(&m, &v)| {
                        if m.is_nan() || v.is_nan() || v <= 0.0 {
                            0.0
                        } else {
                            m.signum() * (vol_target / v).min(1.0)
                        }
                    })
                    .collect()
            }
            StrategySpec::BollingerReversion {
                window,
                entry_z,
                exit_z,
            } => {
                let z = qfactors::bollinger_z(klines, window);
                let mut pos = 0.0f64;
                z.iter()
                    .map(|&zi| {
                        if zi.is_nan() {
                            pos = 0.0;
                        } else if zi < -entry_z {
                            pos = 1.0;
                        } else if zi > entry_z {
                            pos = -1.0;
                        } else if zi.abs() < exit_z {
                            pos = 0.0;
                        }
                        pos
                    })
                    .collect()
            }
            StrategySpec::MultiFactor {
                mom_lookback,
                flow_window,
                vol_window,
                w_mom,
                w_flow,
                w_vol,
            } => {
                let mom = zscore(&qfactors::momentum(klines, mom_lookback), 200);
                let flow = qfactors::flow_imbalance(klines, flow_window);
                let vol = zscore(&qfactors::realized_vol(klines, vol_window), 200);
                (0..klines.len())
                    .map(|i| {
                        let (m, f, v) = (mom[i], flow[i], vol[i]);
                        if m.is_nan() || f.is_nan() || v.is_nan() {
                            0.0
                        } else {
                            (w_mom * m + w_flow * f - w_vol * v).tanh()
                        }
                    })
                    .collect()
            }
            StrategySpec::RuleVote {
                rule_mask,
                min_votes,
                hold_bars,
            } => {
                let n = klines.len();
                let mut pos = vec![0.0f64; n];
                let hits = qfactors::ta_rules::classic_rule_events(klines);
                let mut buy_votes = vec![0usize; n];
                let mut sell_cnt = vec![0usize; n];
                for h in &hits {
                    if h.side > 0 {
                        if let Some(ix) = qfactors::ta_rules::buy_rule_index(&h.rule) {
                            if rule_mask >> ix & 1 == 1 {
                                buy_votes[h.idx] += 1;
                            }
                        }
                    } else {
                        sell_cnt[h.idx] += 1;
                    }
                }
                let mut hold_until = 0usize;
                let mut holding = false;
                for i in 0..n {
                    if holding && (i >= hold_until || sell_cnt[i] >= 2) {
                        holding = false;
                    }
                    if !holding && buy_votes[i] >= min_votes {
                        holding = true;
                        hold_until = i + hold_bars;
                    }
                    pos[i] = if holding { 1.0 } else { 0.0 };
                }
                pos
            }
            StrategySpec::Ensemble { .. } => unreachable!("handled above"),
        }
    }

    /// 随机生成一个该家族的策略（用于进化初始种群）
    pub fn random(family: usize, rng: &mut impl Rng) -> Self {
        match family % 5 {
            0 => StrategySpec::Tsmom {
                lookback: rng.gen_range(6..200),
                deadband: rng.gen_range(0.0..0.02),
            },
            1 => StrategySpec::VolManagedMomentum {
                lookback: rng.gen_range(6..200),
                vol_window: rng.gen_range(10..100),
                vol_target: rng.gen_range(0.001..0.02),
            },
            2 => StrategySpec::BollingerReversion {
                window: rng.gen_range(10..100),
                entry_z: rng.gen_range(0.5..2.0),
                exit_z: rng.gen_range(0.05..0.5),
            },
            3 => StrategySpec::MultiFactor {
                mom_lookback: rng.gen_range(6..200),
                flow_window: rng.gen_range(5..60),
                vol_window: rng.gen_range(10..100),
                w_mom: rng.gen_range(-1.5..1.5),
                w_flow: rng.gen_range(-1.5..1.5),
                w_vol: rng.gen_range(-1.5..1.5),
            },
            _ => {
                let nb = qfactors::ta_rules::BUY_RULES.len();
                let k = rng.gen_range(2..=4usize);
                let mut mask = 0u64;
                while (mask.count_ones() as usize) < k {
                    mask |= 1 << rng.gen_range(0..nb);
                }
                StrategySpec::RuleVote {
                    rule_mask: mask,
                    min_votes: rng.gen_range(1..=2),
                    hold_bars: rng.gen_range(5..40),
                }
            }
        }
    }

    /// 高斯扰动变异，生成子代
    pub fn mutate(&self, rng: &mut impl Rng) -> Self {
        if let StrategySpec::Ensemble { members } = self {
            // 变异随机一个成员
            let mut members = members.clone();
            if !members.is_empty() {
                let i = rng.gen_range(0..members.len());
                members[i] = members[i].mutate(rng);
            }
            return StrategySpec::Ensemble { members };
        }
        fn jitter_usize(v: usize, lo: usize, hi: usize, rng: &mut impl Rng) -> usize {
            let f = 1.0 + rng.gen_range(-0.3..0.3f64);
            ((v as f64 * f).round() as usize).clamp(lo, hi)
        }
        fn jitter(v: f64, lo: f64, hi: f64, rng: &mut impl Rng) -> f64 {
            (v + rng.gen_range(-0.3..0.3) * (hi - lo) * 0.25).clamp(lo, hi)
        }
        match *self {
            StrategySpec::Tsmom { lookback, deadband } => StrategySpec::Tsmom {
                lookback: jitter_usize(lookback, 6, 200, rng),
                deadband: jitter(deadband, 0.0, 0.02, rng),
            },
            StrategySpec::VolManagedMomentum {
                lookback,
                vol_window,
                vol_target,
            } => StrategySpec::VolManagedMomentum {
                lookback: jitter_usize(lookback, 6, 200, rng),
                vol_window: jitter_usize(vol_window, 10, 100, rng),
                vol_target: jitter(vol_target, 0.001, 0.02, rng),
            },
            StrategySpec::BollingerReversion {
                window,
                entry_z,
                exit_z,
            } => StrategySpec::BollingerReversion {
                window: jitter_usize(window, 10, 100, rng),
                entry_z: jitter(entry_z, 0.5, 2.0, rng),
                exit_z: jitter(exit_z, 0.05, 0.5, rng),
            },
            StrategySpec::MultiFactor {
                mom_lookback,
                flow_window,
                vol_window,
                w_mom,
                w_flow,
                w_vol,
            } => StrategySpec::MultiFactor {
                mom_lookback: jitter_usize(mom_lookback, 6, 200, rng),
                flow_window: jitter_usize(flow_window, 5, 60, rng),
                vol_window: jitter_usize(vol_window, 10, 100, rng),
                w_mom: jitter(w_mom, -1.5, 1.5, rng),
                w_flow: jitter(w_flow, -1.5, 1.5, rng),
                w_vol: jitter(w_vol, -1.5, 1.5, rng),
            },
            StrategySpec::RuleVote {
                rule_mask,
                min_votes,
                hold_bars,
            } => {
                // 翻转一个规则位（保持非空），偶尔调票数阈值，扰动持有期
                let nb = qfactors::ta_rules::BUY_RULES.len() as u64;
                let bit = 1u64 << rng.gen_range(0..nb);
                let mut mask = rule_mask ^ bit;
                if mask == 0 {
                    mask = bit;
                }
                let mv = if rng.gen_bool(0.3) {
                    if rng.gen_bool(0.5) { min_votes + 1 } else { min_votes.saturating_sub(1) }
                } else {
                    min_votes
                };
                StrategySpec::RuleVote {
                    rule_mask: mask,
                    min_votes: mv.clamp(1, 3).min(mask.count_ones() as usize).max(1),
                    hold_bars: jitter_usize(hold_bars, 3, 60, rng),
                }
            }
            StrategySpec::Ensemble { .. } => unreachable!("handled above"),
        }
    }
}

/// 滚动 z-score（窗口 w，无前视）
fn zscore(xs: &[f64], w: usize) -> Vec<f64> {
    let mut out = vec![f64::NAN; xs.len()];
    for i in 0..xs.len() {
        if i + 1 < w {
            continue;
        }
        let win = &xs[i + 1 - w..=i];
        if win.iter().any(|v| v.is_nan()) {
            continue;
        }
        let m = qfactors::mean(win);
        let s = qfactors::std_dev(win);
        out[i] = if s > 0.0 { (xs[i] - m) / s } else { 0.0 };
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    fn trend_klines(n: usize) -> Vec<Kline> {
        (0..n)
            .map(|i| {
                let c = 100.0 * 1.001f64.powi(i as i32);
                Kline {
                    open_time: i as i64 * 3_600_000,
                    open: c,
                    high: c,
                    low: c,
                    close: c,
                    volume: 1.0,
                    taker_buy_volume: 0.5,
                    trades: 1,
                }
            })
            .collect()
    }

    #[test]
    fn tsmom_long_in_uptrend() {
        let ks = trend_klines(300);
        let s = StrategySpec::Tsmom {
            lookback: 24,
            deadband: 0.0,
        };
        let sig = s.signals(&ks);
        assert_eq!(sig.len(), ks.len());
        assert!(sig[200] == 1.0);
    }

    #[test]
    fn mutate_stays_in_bounds() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(42);
        let mut s = StrategySpec::random(0, &mut rng);
        for _ in 0..100 {
            s = s.mutate(&mut rng);
            if let StrategySpec::Tsmom { lookback, deadband } = &s {
                assert!(*lookback >= 6 && *lookback <= 200);
                assert!(*deadband >= 0.0 && *deadband <= 0.02);
            }
        }
    }
}
