//! 事件驱动向量化回测引擎。
//!
//! 关键防偏差设计：
//! - 信号在 t 收盘产生，**t+1 开盘成交**（next-bar execution，无前视）
//! - 双边手续费 + 比例滑点
//! - Deflated Sharpe Ratio (Bailey & López de Prado 2014) 校正多策略搜索的过拟合

use qcore::{EquityPoint, Kline, Metrics, Signal};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CostModel {
    /// 单边手续费率（Binance taker 0.001）
    pub fee_rate: f64,
    /// 比例滑点（按成交额）
    pub slippage: f64,
}

impl Default for CostModel {
    fn default() -> Self {
        Self {
            fee_rate: 0.001,
            slippage: 0.0005,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacktestResult {
    pub metrics: Metrics,
    pub equity: Vec<EquityPoint>,
    /// 每根bar的策略收益（用于 walk-forward 拼接）
    pub returns: Vec<f64>,
}

/// 用目标仓位信号序列回测。signals[i] 对应 klines[i] 收盘时的目标仓位，
/// 在 klines[i+1] 开盘调仓。bars_per_year 用于年化（1h → 8760）。
pub fn run(
    klines: &[Kline],
    signals: &[Signal],
    cost: CostModel,
    bars_per_year: f64,
    num_trials: usize,
) -> BacktestResult {
    assert_eq!(klines.len(), signals.len());
    let n = klines.len();
    let mut equity = 1.0f64;
    let mut position = 0.0f64; // 当前仓位 [-1,1]
    let mut curve = Vec::with_capacity(n);
    let mut rets = Vec::with_capacity(n);
    let mut num_trades = 0u64;
    let mut wins = 0u64;
    let mut trade_entry_equity = 1.0f64;

    for i in 0..n {
        let bar_ret = if i == 0 {
            0.0
        } else {
            // 本bar收益 = 上一时刻持仓 × 开盘到开盘收益（用 close[i-1]→close[i] 近似 open 序列也可，
            // 这里用 open[i]→close[i] 加上隔夜 close[i-1]→open[i]，等价于 close-to-close 持仓收益）
            position * (klines[i].close / klines[i - 1].close - 1.0)
        };
        let mut net_ret = bar_ret;

        // t-1 收盘的信号在本bar开盘执行
        let target = if i == 0 {
            0.0
        } else {
            signals[i - 1].target_position.clamp(-1.0, 1.0)
        };
        let turnover = (target - position).abs();
        if turnover > 1e-9 {
            net_ret -= turnover * (cost.fee_rate + cost.slippage);
            // 统计完整开平为一笔交易：从0开仓记为入场
            if position.abs() < 1e-9 && target.abs() > 1e-9 {
                trade_entry_equity = equity;
            } else if position.abs() > 1e-9 && (target.abs() < 1e-9 || target * position < 0.0) {
                num_trades += 1;
                if equity * (1.0 + net_ret) > trade_entry_equity {
                    wins += 1;
                }
                if target * position < 0.0 {
                    trade_entry_equity = equity;
                }
            }
            position = target;
        }

        equity *= 1.0 + net_ret;
        rets.push(net_ret);
        curve.push(EquityPoint {
            time: klines[i].open_time,
            equity,
            position,
            price: klines[i].close,
        });
    }

    let metrics = compute_metrics(&rets, &curve, bars_per_year, num_trades, wins, num_trials);
    BacktestResult {
        metrics,
        equity: curve,
        returns: rets,
    }
}

pub fn compute_metrics(
    rets: &[f64],
    curve: &[EquityPoint],
    bars_per_year: f64,
    num_trades: u64,
    wins: u64,
    num_trials: usize,
) -> Metrics {
    let n = rets.len().max(1) as f64;
    let total_return = curve.last().map_or(0.0, |p| p.equity - 1.0);
    let mean_r = rets.iter().sum::<f64>() / n;
    let var = rets.iter().map(|r| (r - mean_r).powi(2)).sum::<f64>() / (n - 1.0).max(1.0);
    let sd = var.sqrt();
    let downside: Vec<f64> = rets.iter().copied().filter(|r| *r < 0.0).collect();
    let dsd = if downside.is_empty() {
        0.0
    } else {
        (downside.iter().map(|r| r * r).sum::<f64>() / downside.len() as f64).sqrt()
    };

    let annual_return = mean_r * bars_per_year;
    let annual_vol = sd * bars_per_year.sqrt();
    let sharpe = if sd > 0.0 {
        mean_r / sd * bars_per_year.sqrt()
    } else {
        0.0
    };
    let sortino = if dsd > 0.0 {
        mean_r / dsd * bars_per_year.sqrt()
    } else {
        0.0
    };

    let mut peak = f64::MIN;
    let mut max_dd = 0.0f64;
    for p in curve {
        peak = peak.max(p.equity);
        max_dd = max_dd.max(1.0 - p.equity / peak);
    }
    let calmar = if max_dd > 0.0 {
        annual_return / max_dd
    } else {
        0.0
    };

    let skew = central_moment(rets, mean_r, sd, 3);
    let kurt = central_moment(rets, mean_r, sd, 4);
    let dsr = deflated_sharpe_prob(sharpe / bars_per_year.sqrt(), n as usize, skew, kurt, num_trials);

    Metrics {
        total_return,
        annual_return,
        annual_vol,
        sharpe,
        sortino,
        max_drawdown: max_dd,
        calmar,
        win_rate: if num_trades > 0 {
            wins as f64 / num_trades as f64
        } else {
            0.0
        },
        num_trades,
        deflated_sharpe_prob: dsr,
    }
}

fn central_moment(rets: &[f64], m: f64, sd: f64, k: i32) -> f64 {
    if sd <= 0.0 || rets.len() < 2 {
        return if k == 4 { 3.0 } else { 0.0 };
    }
    rets.iter().map(|r| ((r - m) / sd).powi(k)).sum::<f64>() / rets.len() as f64
}

/// Deflated Sharpe Ratio：PSR(SR*)，其中 SR* 为 num_trials 次搜索下的期望最大噪声 Sharpe。
/// 返回概率值 ∈ (0,1)，>0.95 视为显著。SR 输入为 per-bar Sharpe（未年化）。
pub fn deflated_sharpe_prob(sr: f64, n: usize, skew: f64, kurt: f64, num_trials: usize) -> f64 {
    if n < 10 {
        return 0.0;
    }
    let t = num_trials.max(1) as f64;
    // E[max of t 个标准正态] 的渐近近似 (Bailey & López de Prado 2014)
    let emc = 0.5772156649;
    let z1 = inv_norm_cdf(1.0 - 1.0 / t);
    let z2 = inv_norm_cdf(1.0 - 1.0 / (t * std::f64::consts::E));
    let max_z = if t <= 1.0 {
        0.0
    } else {
        (1.0 - emc) * z1 + emc * z2
    };
    // 噪声 Sharpe 的标准差 ~ sqrt(1/(n-1))，故基准 SR* = max_z * sqrt(1/(n-1))
    let sr_star = max_z * (1.0 / (n as f64 - 1.0)).sqrt();
    let denom = (1.0 - skew * sr + (kurt - 1.0) / 4.0 * sr * sr).max(1e-12);
    let z = (sr - sr_star) * ((n as f64 - 1.0).sqrt()) / denom.sqrt();
    norm_cdf(z)
}

fn norm_cdf(x: f64) -> f64 {
    0.5 * (1.0 + erf(x / std::f64::consts::SQRT_2))
}

fn erf(x: f64) -> f64 {
    // Abramowitz & Stegun 7.1.26
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * x);
    let y = 1.0
        - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
            + 0.254829592)
            * t
            * (-x * x).exp();
    sign * y
}

fn inv_norm_cdf(p: f64) -> f64 {
    // Acklam 近似
    let p = p.clamp(1e-12, 1.0 - 1e-12);
    let a = [
        -3.969683028665376e+01,
        2.209460984245205e+02,
        -2.759285104469687e+02,
        1.383577518672690e+02,
        -3.066479806614716e+01,
        2.506628277459239e+00,
    ];
    let b = [
        -5.447609879822406e+01,
        1.615858368580409e+02,
        -1.556989798598866e+02,
        6.680131188771972e+01,
        -1.328068155288572e+01,
    ];
    let c = [
        -7.784894002430293e-03,
        -3.223964580411365e-01,
        -2.400758277161838e+00,
        -2.549732539343734e+00,
        4.374664141464968e+00,
        2.938163982698783e+00,
    ];
    let d = [
        7.784695709041462e-03,
        3.224671290700398e-01,
        2.445134137142996e+00,
        3.754408661907416e+00,
    ];
    let plow = 0.02425;
    if p < plow {
        let q = (-2.0 * p.ln()).sqrt();
        (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
    } else if p <= 1.0 - plow {
        let q = p - 0.5;
        let r = q * q;
        (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
            / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0)
    } else {
        let q = (-2.0 * (1.0 - p).ln()).sqrt();
        -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
    }
}

/// 把信号数组包装成 Signal 结构
pub fn to_signals(klines: &[Kline], targets: &[f64]) -> Vec<Signal> {
    klines
        .iter()
        .zip(targets)
        .map(|(k, &t)| Signal {
            time: k.open_time,
            target_position: if t.is_nan() { 0.0 } else { t },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kl(closes: &[f64]) -> Vec<Kline> {
        closes
            .iter()
            .enumerate()
            .map(|(i, &c)| Kline {
                open_time: i as i64 * 3_600_000,
                open: c,
                high: c,
                low: c,
                close: c,
                volume: 1.0,
                taker_buy_volume: 0.5,
                trades: 1,
            })
            .collect()
    }

    #[test]
    fn buy_and_hold_tracks_price() {
        let ks = kl(&[100.0, 110.0, 121.0, 133.1]);
        let sigs = to_signals(&ks, &[1.0, 1.0, 1.0, 1.0]);
        let r = run(&ks, &sigs, CostModel { fee_rate: 0.0, slippage: 0.0 }, 8760.0, 1);
        // 第0根收盘发信号，第1根成交：错过第一段涨幅
        let expected = 133.1 / 110.0;
        assert!((r.equity.last().unwrap().equity - expected).abs() < 1e-9);
    }

    #[test]
    fn costs_reduce_equity() {
        let ks = kl(&[100.0; 10]);
        let sigs = to_signals(&ks, &[1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0]);
        let r = run(&ks, &sigs, CostModel::default(), 8760.0, 1);
        assert!(r.equity.last().unwrap().equity < 1.0);
    }

    #[test]
    fn no_lookahead_signal_lag() {
        // 价格只在最后一根暴涨；若信号同bar成交会赚到，next-bar 则赚不到
        let ks = kl(&[100.0, 100.0, 100.0, 200.0]);
        let sigs = to_signals(&ks, &[0.0, 0.0, 0.0, 1.0]); // 暴涨当根才发信号
        let r = run(&ks, &sigs, CostModel { fee_rate: 0.0, slippage: 0.0 }, 8760.0, 1);
        assert!((r.equity.last().unwrap().equity - 1.0).abs() < 1e-9);
    }

    #[test]
    fn dsr_low_for_noise() {
        let p = deflated_sharpe_prob(0.01, 500, 0.0, 3.0, 100);
        assert!(p < 0.9);
    }
}
