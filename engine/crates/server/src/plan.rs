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
    /// 判断周期标注（如 "日线 · 每日收盘决策一次，盘中不动作"）
    pub decision_interval_label: String,
    /// 置信度 0-100（由留出窗 Sharpe 映射——从未参与参数搜索的数据上的表现）
    pub confidence: f64,
    pub confidence_label: String,
    /// 决策依据（策略内部状态的人话翻译）
    pub rationale: String,
    /// 统计目标区间（现价×e^(±1σ√持有期)，σ=20日已实现波动；每日收盘自动更新）
    pub target_zone_low: Option<f64>,
    pub target_zone_high: Option<f64>,
    /// 估计持有期（交易日）
    pub horizon_days: f64,
    /// 20日已实现日波动
    pub vol_daily: f64,
}

/// 置信度：留出窗 Sharpe → 0-100。Sharpe 0 → 50 分；每 +1 Sharpe +22 分
fn confidence_from(holdout_sharpe: Option<f64>) -> (f64, String) {
    let s = holdout_sharpe.unwrap_or(0.0);
    let score = (50.0 + 22.0 * s).clamp(5.0, 95.0);
    let label = if score >= 70.0 {
        "高"
    } else if score >= 50.0 {
        "中"
    } else {
        "低"
    };
    (score, label.to_string())
}

/// 公开包装：期权回测等模块需要同一口径的持有期估计
pub fn spec_horizon_days(spec: &StrategySpec) -> f64 {
    horizon_days(spec)
}

/// 策略估计持有期（交易日）：动量类 ≈ 回看期/5，回归类 ≈ 窗口/2
fn horizon_days(spec: &StrategySpec) -> f64 {
    match spec {
        StrategySpec::Tsmom { lookback, .. } => (*lookback as f64 / 5.0).clamp(5.0, 30.0),
        StrategySpec::VolManagedMomentum { lookback, .. } => {
            (*lookback as f64 / 5.0).clamp(5.0, 30.0)
        }
        StrategySpec::BollingerReversion { window, .. } => (*window as f64 / 2.0).clamp(3.0, 20.0),
        StrategySpec::MultiFactor { mom_lookback, .. } => {
            (*mom_lookback as f64 / 5.0).clamp(5.0, 30.0)
        }
        StrategySpec::Ensemble { members } => {
            if members.is_empty() {
                10.0
            } else {
                members.iter().map(horizon_days).sum::<f64>() / members.len() as f64
            }
        }
    }
}

/// 决策依据：策略内部状态的人话翻译
fn rationale(spec: &StrategySpec, klines: &[Kline], target: f64) -> String {
    let pct = |x: f64| format!("{:+.1}%", x * 100.0);
    match spec {
        StrategySpec::Tsmom { lookback, deadband } => {
            let m = qfactors::momentum(klines, *lookback).last().copied().unwrap_or(f64::NAN);
            format!(
                "{lookback}日动量 {}（死区 ±{:.2}%）→ {}",
                pct(m.exp_m1_safe()),
                deadband * 100.0,
                dir_word(target)
            )
        }
        StrategySpec::VolManagedMomentum {
            lookback,
            vol_window,
            vol_target,
        } => {
            let m = qfactors::momentum(klines, *lookback).last().copied().unwrap_or(f64::NAN);
            let v = qfactors::realized_vol(klines, *vol_window).last().copied().unwrap_or(f64::NAN);
            format!(
                "{lookback}日动量 {} 定方向；当前日波动 {:.2}% vs 目标 {:.2}% → 仓位缩放至 {:.0}%",
                pct(m.exp_m1_safe()),
                v * 100.0,
                vol_target * 100.0,
                target.abs() * 100.0
            )
        }
        StrategySpec::BollingerReversion { window, entry_z, exit_z } => {
            let z = qfactors::bollinger_z(klines, *window).last().copied().unwrap_or(f64::NAN);
            format!(
                "{window}日布林 z={z:.2}（入场 ±{entry_z:.2} / 离场 ±{exit_z:.2}）→ {}",
                dir_word(target)
            )
        }
        StrategySpec::MultiFactor { mom_lookback, flow_window, vol_window, w_mom, w_flow, w_vol } => {
            let m = qfactors::momentum(klines, *mom_lookback).last().copied().unwrap_or(f64::NAN);
            let f = qfactors::flow_imbalance(klines, *flow_window).last().copied().unwrap_or(f64::NAN);
            let v = qfactors::realized_vol(klines, *vol_window).last().copied().unwrap_or(f64::NAN);
            format!(
                "多因子打分: 动量{}×{w_mom:.1} + 资金流{f:.2}×{w_flow:.1} − 波动{:.2}%×{w_vol:.1} → {}",
                pct(m.exp_m1_safe()),
                v * 100.0,
                dir_word(target)
            )
        }
        StrategySpec::Ensemble { members } => {
            let votes: Vec<f64> = members
                .iter()
                .map(|m| m.signals(klines).last().copied().unwrap_or(0.0))
                .collect();
            let longs = votes.iter().filter(|v| **v > 0.05).count();
            let shorts = votes.iter().filter(|v| **v < -0.05).count();
            let flat = votes.len() - longs - shorts;
            format!(
                "{}个成员策略投票: {}多 / {}空 / {}观望，等权平均后 {} {:.0}%",
                votes.len(),
                longs,
                shorts,
                flat,
                dir_word(target),
                target.abs() * 100.0
            )
        }
    }
}

fn dir_word(t: f64) -> &'static str {
    if t > 0.05 {
        "看多"
    } else if t < -0.05 {
        "看空"
    } else {
        "观望"
    }
}

trait ExpM1Safe {
    fn exp_m1_safe(self) -> f64;
}
impl ExpM1Safe for f64 {
    /// 对数收益 → 简单收益，NaN 保持
    fn exp_m1_safe(self) -> f64 {
        if self.is_nan() {
            f64::NAN
        } else {
            self.exp() - 1.0
        }
    }
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
        let (confidence, confidence_label) = confidence_from(holdout);
        let vol_daily = qfactors::realized_vol(&klines, 20)
            .last()
            .copied()
            .unwrap_or(f64::NAN);
        let h_days = horizon_days(&spec);
        let (zone_lo, zone_hi) = if vol_daily.is_finite() && vol_daily > 0.0 {
            let sigma = vol_daily * h_days.sqrt();
            (
                Some(last.close * (-sigma).exp()),
                Some(last.close * sigma.exp()),
            )
        } else {
            (None, None)
        };
        let interval_label = match interval {
            Interval::D1 => "日线 · 每日收盘决策一次，盘中不动作",
            Interval::H4 => "4小时线 · 每4小时决策一次",
            Interval::H1 => "1小时线 · 每小时决策一次",
            _ => "分钟线",
        };
        plans.push(TradePlan {
            key,
            strategy: spec.name().to_string(),
            target_position: target,
            last_close: last.close,
            flip_pct: flip.map(|f| (f / last.close - 1.0) * 100.0),
            flip_price: flip,
            next_decision_ms: next_decision(&symbol, interval, last.open_time),
            holdout_sharpe: holdout,
            decision_interval_label: interval_label.to_string(),
            confidence,
            confidence_label,
            rationale: rationale(&spec, &klines, target),
            target_zone_low: zone_lo,
            target_zone_high: zone_hi,
            horizon_days: h_days,
            vol_daily: if vol_daily.is_finite() { vol_daily } else { 0.0 },
            symbol,
            interval: interval_s,
        });
    }
    plans.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(plans)
}

// ---------- 组合级风控 ----------

#[derive(Debug, Clone, Serialize)]
pub struct PortfolioSlot {
    pub key: String,
    pub symbol: String,
    /// 策略原始目标仓位 [-1,1]（槽内口径）
    pub raw_position: f64,
    /// 等权资金分配下的组合权重 = raw/n
    pub raw_weight: f64,
    /// 风控缩放后的最终组合权重（当日仓位规划）
    pub adjusted_weight: f64,
    pub vol_daily: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PortfolioPlan {
    pub slots: Vec<PortfolioSlot>,
    /// 原始总杠杆 Σ|raw_weight|
    pub gross_raw: f64,
    pub gross_adjusted: f64,
    /// 净敞口（多空相抵）
    pub net_adjusted: f64,
    /// 统一缩放系数 = min(1, 杠杆上限/总杠杆, 目标波动/估计波动)
    pub scale: f64,
    pub est_vol_annual_raw: f64,
    pub est_vol_annual_adjusted: f64,
    pub gross_cap: f64,
    pub vol_target_annual: f64,
    pub assumed_correlation: f64,
    pub note: String,
}

/// 组合风控：等权资金分配 → 总杠杆上限 + 组合目标波动率双重约束统一缩放。
/// 可用 QHH_GROSS_CAP（默认 1.0 = 不加杠杆）/ QHH_VOL_TARGET（默认 0.15 年化）调节。
pub async fn build_portfolio(state: &Arc<AppState>) -> anyhow::Result<PortfolioPlan> {
    let plans = build_plans(state).await?;
    let n = plans.len().max(1) as f64;
    let gross_cap = env_f64("QHH_GROSS_CAP", 1.0);
    let vol_target_annual = env_f64("QHH_VOL_TARGET", 0.15);
    let rho = 0.6; // 保守的同向相关性假设（风险偏高估而非低估）

    let raw: Vec<(f64, f64)> = plans
        .iter()
        .map(|p| (p.target_position / n, p.vol_daily))
        .collect();
    let gross_raw: f64 = raw.iter().map(|(w, _)| w.abs()).sum();

    // 估计组合日波动：σ_p² = Σᵢⱼ wᵢwⱼσᵢσⱼρᵢⱼ（i=j 时 ρ=1）
    let mut var = 0.0;
    for (i, (wi, si)) in raw.iter().enumerate() {
        for (j, (wj, sj)) in raw.iter().enumerate() {
            let r = if i == j { 1.0 } else { rho };
            var += wi * wj * si * sj * r;
        }
    }
    let est_vol_daily_raw = var.max(0.0).sqrt();
    let est_vol_annual_raw = est_vol_daily_raw * 252.0f64.sqrt();
    let vol_target_daily = vol_target_annual / 252.0f64.sqrt();

    let mut scale = 1.0f64;
    if gross_raw > gross_cap {
        scale = scale.min(gross_cap / gross_raw);
    }
    if est_vol_daily_raw > vol_target_daily && est_vol_daily_raw > 0.0 {
        scale = scale.min(vol_target_daily / est_vol_daily_raw);
    }

    let slots: Vec<PortfolioSlot> = plans
        .iter()
        .map(|p| PortfolioSlot {
            key: p.key.clone(),
            symbol: p.symbol.clone(),
            raw_position: p.target_position,
            raw_weight: p.target_position / n,
            adjusted_weight: p.target_position / n * scale,
            vol_daily: p.vol_daily,
        })
        .collect();
    let gross_adjusted: f64 = slots.iter().map(|s| s.adjusted_weight.abs()).sum();
    let net_adjusted: f64 = slots.iter().map(|s| s.adjusted_weight).sum();

    Ok(PortfolioPlan {
        gross_raw,
        gross_adjusted,
        net_adjusted,
        scale,
        est_vol_annual_raw,
        est_vol_annual_adjusted: est_vol_annual_raw * scale,
        gross_cap,
        vol_target_annual,
        assumed_correlation: rho,
        note: format!(
            "等权分配每槽 1/{} 资金；总杠杆上限 {:.0}% 与组合目标波动 {:.0}%/年 双重约束取更紧者统一缩放。\
             相关性假设 ρ={:.1}（保守偏高）。",
            plans.len().max(1),
            gross_cap * 100.0,
            vol_target_annual * 100.0,
            rho
        ),
        slots,
    })
}

fn env_f64(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
