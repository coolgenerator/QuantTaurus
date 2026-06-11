//! 因子库：从K线序列计算时序因子。
//! 全部因子在时刻 t 只使用 t 及之前的数据（无前视偏差）。
//!
//! 学术依据：
//! - 动量: Moskowitz, Ooi & Pedersen (2012) Time Series Momentum
//! - 已实现波动率: Andersen & Bollerslev 高频RV文献
//! - 订单流不平衡: Cont, Kukanov & Stoikov (2014)

use qcore::Kline;
use serde::{Deserialize, Serialize};

pub mod ta_rules;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactorKind {
    /// N期对数动量
    Momentum,
    /// RSI (Wilder)
    Rsi,
    /// 已实现波动率（滚动对数收益标准差，年化前）
    RealizedVol,
    /// 收盘价相对布林带位置 [-1,1]
    BollingerZ,
    /// MACD 柱 (12,26,9 比例缩放到周期参数)
    MacdHist,
    /// 订单流不平衡: (taker买量 - taker卖量)/总量 的滚动均值
    FlowImbalance,
    /// 量价相关: 滚动 corr(ret, dvolume)
    VolumePriceCorr,
}

pub const ALL_FACTORS: [FactorKind; 7] = [
    FactorKind::Momentum,
    FactorKind::Rsi,
    FactorKind::RealizedVol,
    FactorKind::BollingerZ,
    FactorKind::MacdHist,
    FactorKind::FlowImbalance,
    FactorKind::VolumePriceCorr,
];

/// 计算单个因子序列。返回与 klines 等长的 Vec，前 lookback 个元素为 NaN。
pub fn compute(kind: FactorKind, period: usize, klines: &[Kline]) -> Vec<f64> {
    match kind {
        FactorKind::Momentum => momentum(klines, period),
        FactorKind::Rsi => rsi(klines, period),
        FactorKind::RealizedVol => realized_vol(klines, period),
        FactorKind::BollingerZ => bollinger_z(klines, period),
        FactorKind::MacdHist => macd_hist(klines, period),
        FactorKind::FlowImbalance => flow_imbalance(klines, period),
        FactorKind::VolumePriceCorr => volume_price_corr(klines, period),
    }
}

fn closes(klines: &[Kline]) -> Vec<f64> {
    klines.iter().map(|k| k.close).collect()
}

pub fn momentum(klines: &[Kline], n: usize) -> Vec<f64> {
    let c = closes(klines);
    (0..c.len())
        .map(|i| {
            if i < n {
                f64::NAN
            } else {
                (c[i] / c[i - n]).ln()
            }
        })
        .collect()
}

pub fn rsi(klines: &[Kline], n: usize) -> Vec<f64> {
    let c = closes(klines);
    let mut out = vec![f64::NAN; c.len()];
    if c.len() <= n {
        return out;
    }
    let (mut avg_gain, mut avg_loss) = (0.0, 0.0);
    for i in 1..=n {
        let d = c[i] - c[i - 1];
        if d > 0.0 {
            avg_gain += d;
        } else {
            avg_loss -= d;
        }
    }
    avg_gain /= n as f64;
    avg_loss /= n as f64;
    out[n] = 100.0 - 100.0 / (1.0 + safe_div(avg_gain, avg_loss));
    for i in (n + 1)..c.len() {
        let d = c[i] - c[i - 1];
        let (g, l) = if d > 0.0 { (d, 0.0) } else { (0.0, -d) };
        avg_gain = (avg_gain * (n as f64 - 1.0) + g) / n as f64;
        avg_loss = (avg_loss * (n as f64 - 1.0) + l) / n as f64;
        out[i] = 100.0 - 100.0 / (1.0 + safe_div(avg_gain, avg_loss));
    }
    out
}

pub fn realized_vol(klines: &[Kline], n: usize) -> Vec<f64> {
    let c = closes(klines);
    let rets: Vec<f64> = std::iter::once(f64::NAN)
        .chain(c.windows(2).map(|w| (w[1] / w[0]).ln()))
        .collect();
    rolling(&rets, n, |w| std_dev(w))
}

pub fn bollinger_z(klines: &[Kline], n: usize) -> Vec<f64> {
    let c = closes(klines);
    let mut out = vec![f64::NAN; c.len()];
    for i in n..c.len() {
        let w = &c[i + 1 - n..=i];
        let m = mean(w);
        let s = std_dev(w);
        out[i] = if s > 0.0 { (c[i] - m) / (2.0 * s) } else { 0.0 };
    }
    out
}

pub fn macd_hist(klines: &[Kline], n: usize) -> Vec<f64> {
    // 以 n 为基准缩放经典 (12,26,9)
    let fast = n.max(2);
    let slow = (n * 26 / 12).max(fast + 1);
    let sig = (n * 9 / 12).max(2);
    let c = closes(klines);
    let ef = ema(&c, fast);
    let es = ema(&c, slow);
    let macd: Vec<f64> = ef.iter().zip(&es).map(|(a, b)| a - b).collect();
    let signal = ema(&macd, sig);
    macd.iter()
        .zip(&signal)
        .enumerate()
        .map(|(i, (m, s))| if i < slow + sig { f64::NAN } else { m - s })
        .collect()
}

pub fn flow_imbalance(klines: &[Kline], n: usize) -> Vec<f64> {
    let imb: Vec<f64> = klines
        .iter()
        .map(|k| {
            if k.volume > 0.0 {
                (2.0 * k.taker_buy_volume - k.volume) / k.volume
            } else {
                0.0
            }
        })
        .collect();
    rolling(&imb, n, mean)
}

pub fn volume_price_corr(klines: &[Kline], n: usize) -> Vec<f64> {
    let c = closes(klines);
    let rets: Vec<f64> = std::iter::once(f64::NAN)
        .chain(c.windows(2).map(|w| (w[1] / w[0]).ln()))
        .collect();
    let dvol: Vec<f64> = std::iter::once(f64::NAN)
        .chain(
            klines
                .windows(2)
                .map(|w| ((w[1].volume + 1.0) / (w[0].volume + 1.0)).ln()),
        )
        .collect();
    let mut out = vec![f64::NAN; c.len()];
    for i in n..c.len() {
        out[i] = correlation(&rets[i + 1 - n..=i], &dvol[i + 1 - n..=i]);
    }
    out
}

/// 简单移动平均线。前 n-1 个元素为 NaN。
pub fn sma(klines: &[Kline], n: usize) -> Vec<f64> {
    let c = closes(klines);
    let mut out = vec![f64::NAN; c.len()];
    if n == 0 {
        return out;
    }
    let mut sum = 0.0;
    for i in 0..c.len() {
        sum += c[i];
        if i >= n {
            sum -= c[i - n];
        }
        if i + 1 >= n {
            out[i] = sum / n as f64;
        }
    }
    out
}

/// KDJ(n, kp, dp) 中式经典口径：
/// RSV = (C - LLV(low,n)) / (HHV(high,n) - LLV(low,n)) × 100
/// K = (kp-1)/kp × K' + 1/kp × RSV；D 同理对 K 平滑；J = 3K - 2D。初值 K=D=50。
/// 返回 (K, D, J)，前 n-1 个元素为 NaN。
pub fn kdj(klines: &[Kline], n: usize, kp: usize, dp: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let len = klines.len();
    let (mut ks, mut ds, mut js) = (
        vec![f64::NAN; len],
        vec![f64::NAN; len],
        vec![f64::NAN; len],
    );
    let (mut k, mut d) = (50.0f64, 50.0f64);
    for i in 0..len {
        if i + 1 < n {
            continue;
        }
        let w = &klines[i + 1 - n..=i];
        let hh = w.iter().map(|x| x.high).fold(f64::MIN, f64::max);
        let ll = w.iter().map(|x| x.low).fold(f64::MAX, f64::min);
        let rsv = if hh > ll {
            (klines[i].close - ll) / (hh - ll) * 100.0
        } else {
            50.0
        };
        k = ((kp as f64 - 1.0) * k + rsv) / kp as f64;
        d = ((dp as f64 - 1.0) * d + k) / dp as f64;
        ks[i] = k;
        ds[i] = d;
        js[i] = 3.0 * k - 2.0 * d;
    }
    (ks, ds, js)
}

/// MACD 完整三线（国际口径 HIST = DIF - DEA）。
/// 返回 (DIF, DEA, HIST)，前 slow+sig 根为 NaN。
pub fn macd_full(
    klines: &[Kline],
    fast: usize,
    slow: usize,
    sig: usize,
) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let c = closes(klines);
    let ef = ema(&c, fast);
    let es = ema(&c, slow);
    let dif: Vec<f64> = ef.iter().zip(&es).map(|(a, b)| a - b).collect();
    let dea = ema(&dif, sig);
    let warmup = slow + sig;
    let mask = |v: &[f64]| -> Vec<f64> {
        v.iter()
            .enumerate()
            .map(|(i, &x)| if i < warmup { f64::NAN } else { x })
            .collect()
    };
    let hist: Vec<f64> = dif.iter().zip(&dea).map(|(m, s)| m - s).collect();
    (mask(&dif), mask(&dea), mask(&hist))
}

// ---------- 数学工具 ----------

pub fn ema(xs: &[f64], n: usize) -> Vec<f64> {
    let alpha = 2.0 / (n as f64 + 1.0);
    let mut out = Vec::with_capacity(xs.len());
    let mut prev = f64::NAN;
    for &x in xs {
        prev = if prev.is_nan() {
            x
        } else if x.is_nan() {
            prev
        } else {
            alpha * x + (1.0 - alpha) * prev
        };
        out.push(prev);
    }
    out
}

fn rolling(xs: &[f64], n: usize, f: impl Fn(&[f64]) -> f64) -> Vec<f64> {
    let mut out = vec![f64::NAN; xs.len()];
    for i in n..xs.len() {
        let w = &xs[i + 1 - n..=i];
        if w.iter().any(|v| v.is_nan()) {
            continue;
        }
        out[i] = f(w);
    }
    out
}

pub fn mean(xs: &[f64]) -> f64 {
    xs.iter().sum::<f64>() / xs.len() as f64
}

pub fn std_dev(xs: &[f64]) -> f64 {
    if xs.len() < 2 {
        return 0.0;
    }
    let m = mean(xs);
    (xs.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (xs.len() as f64 - 1.0)).sqrt()
}

fn correlation(a: &[f64], b: &[f64]) -> f64 {
    let (ma, mb) = (mean(a), mean(b));
    let (mut cov, mut va, mut vb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        if x.is_nan() || y.is_nan() {
            return f64::NAN;
        }
        cov += (x - ma) * (y - mb);
        va += (x - ma).powi(2);
        vb += (y - mb).powi(2);
    }
    if va <= 0.0 || vb <= 0.0 {
        0.0
    } else {
        cov / (va.sqrt() * vb.sqrt())
    }
}

fn safe_div(a: f64, b: f64) -> f64 {
    if b.abs() < 1e-12 {
        if a.abs() < 1e-12 {
            1.0
        } else {
            1e12
        }
    } else {
        a / b
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
                open_time: i as i64 * 60_000,
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
    fn momentum_basic() {
        let ks = fake_klines(&[100.0, 110.0, 121.0]);
        let m = momentum(&ks, 1);
        assert!(m[0].is_nan());
        assert!((m[1] - (1.1f64).ln()).abs() < 1e-12);
    }

    #[test]
    fn rsi_uptrend_high() {
        let closes: Vec<f64> = (0..50).map(|i| 100.0 + i as f64).collect();
        let ks = fake_klines(&closes);
        let r = rsi(&ks, 14);
        assert!(r[49] > 90.0);
    }

    #[test]
    fn flow_imbalance_positive_when_buyers_dominate() {
        let ks = fake_klines(&vec![100.0; 20]);
        let f = flow_imbalance(&ks, 5);
        // taker_buy 60/100 → imbalance 0.2
        assert!((f[19] - 0.2).abs() < 1e-9);
    }

    #[test]
    fn sma_known_values() {
        let ks = fake_klines(&[1.0, 2.0, 3.0, 4.0, 5.0]);
        let m = sma(&ks, 3);
        assert!(m[0].is_nan() && m[1].is_nan());
        assert!((m[2] - 2.0).abs() < 1e-12);
        assert!((m[4] - 4.0).abs() < 1e-12);
    }

    #[test]
    fn kdj_bounds_and_warmup() {
        // 单边上涨：K/D 应趋向高位（>70），且暖机期为 NaN
        let closes: Vec<f64> = (0..40).map(|i| 100.0 + i as f64).collect();
        let ks = fake_klines(&closes);
        let (k, d, j) = kdj(&ks, 9, 3, 3);
        assert!(k[7].is_nan() && d[7].is_nan() && j[7].is_nan());
        assert!(k[39] > 70.0 && d[39] > 70.0);
        assert!((j[39] - (3.0 * k[39] - 2.0 * d[39])).abs() < 1e-9);
    }

    #[test]
    fn macd_full_sign_on_trend() {
        // 持续上涨中 DIF>0 且 HIST 与 macd_hist 同口径（DIF-DEA）
        let closes: Vec<f64> = (0..120).map(|i| 100.0 * (1.0 + 0.01 * i as f64)).collect();
        let ks = fake_klines(&closes);
        let (dif, dea, hist) = macd_full(&ks, 12, 26, 9);
        assert!(dif[34].is_nan() && !dif[35].is_nan());
        assert!(dif[119] > 0.0);
        assert!((hist[119] - (dif[119] - dea[119])).abs() < 1e-9);
    }

    #[test]
    fn no_lookahead_nan_prefix() {
        let ks = fake_klines(&(0..30).map(|i| 100.0 + i as f64).collect::<Vec<_>>());
        for kind in ALL_FACTORS {
            let f = compute(kind, 10, &ks);
            assert_eq!(f.len(), ks.len());
            assert!(f[0].is_nan() || f[0] == 0.0 || kind == FactorKind::FlowImbalance);
        }
    }
}
