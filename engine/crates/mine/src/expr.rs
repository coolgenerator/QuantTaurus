//! 因子表达式 AST 与求值。
//!
//! 叶子是面板列（价格/量/收益），算子分逐点与时序两类；
//! 横截面标准化在求值之后由适应度层统一做（cs_zscore）。

use crate::panel::Panel;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::fmt;

/// 时序窗口候选（交易日）
pub const WINDOWS: [usize; 6] = [5, 10, 21, 42, 63, 126];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Expr {
    // 叶子
    Open,
    High,
    Low,
    Close,
    Volume,
    Ret1,
    Const(f64),
    // 逐点一元
    Neg(Box<Expr>),
    Abs(Box<Expr>),
    SignedLog(Box<Expr>),
    Sign(Box<Expr>),
    // 逐点二元
    Add(Box<Expr>, Box<Expr>),
    Sub(Box<Expr>, Box<Expr>),
    Mul(Box<Expr>, Box<Expr>),
    /// 保护除法：|分母|<1e-9 → 0
    Div(Box<Expr>, Box<Expr>),
    // 时序（窗口 n）
    TsMean(Box<Expr>, usize),
    TsStd(Box<Expr>, usize),
    TsDelta(Box<Expr>, usize),
    TsMin(Box<Expr>, usize),
    TsMax(Box<Expr>, usize),
    /// 当前值在过去 n 期的分位 [0,1]
    TsRank(Box<Expr>, usize),
    /// 时序 z 分
    TsZ(Box<Expr>, usize),
    Ema(Box<Expr>, usize),
}

impl fmt::Display for Expr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Expr::Open => write!(f, "open"),
            Expr::High => write!(f, "high"),
            Expr::Low => write!(f, "low"),
            Expr::Close => write!(f, "close"),
            Expr::Volume => write!(f, "volume"),
            Expr::Ret1 => write!(f, "ret1"),
            Expr::Const(c) => write!(f, "{c:.2}"),
            Expr::Neg(a) => write!(f, "(-{a})"),
            Expr::Abs(a) => write!(f, "abs({a})"),
            Expr::SignedLog(a) => write!(f, "slog({a})"),
            Expr::Sign(a) => write!(f, "sign({a})"),
            Expr::Add(a, b) => write!(f, "({a} + {b})"),
            Expr::Sub(a, b) => write!(f, "({a} - {b})"),
            Expr::Mul(a, b) => write!(f, "({a} * {b})"),
            Expr::Div(a, b) => write!(f, "({a} / {b})"),
            Expr::TsMean(a, n) => write!(f, "ts_mean({a}, {n})"),
            Expr::TsStd(a, n) => write!(f, "ts_std({a}, {n})"),
            Expr::TsDelta(a, n) => write!(f, "ts_delta({a}, {n})"),
            Expr::TsMin(a, n) => write!(f, "ts_min({a}, {n})"),
            Expr::TsMax(a, n) => write!(f, "ts_max({a}, {n})"),
            Expr::TsRank(a, n) => write!(f, "ts_rank({a}, {n})"),
            Expr::TsZ(a, n) => write!(f, "ts_z({a}, {n})"),
            Expr::Ema(a, n) => write!(f, "ema({a}, {n})"),
        }
    }
}

impl Expr {
    /// 节点数（复杂度惩罚用）
    pub fn size(&self) -> usize {
        match self {
            Expr::Open | Expr::High | Expr::Low | Expr::Close | Expr::Volume | Expr::Ret1
            | Expr::Const(_) => 1,
            Expr::Neg(a) | Expr::Abs(a) | Expr::SignedLog(a) | Expr::Sign(a) => 1 + a.size(),
            Expr::Add(a, b) | Expr::Sub(a, b) | Expr::Mul(a, b) | Expr::Div(a, b) => {
                1 + a.size() + b.size()
            }
            Expr::TsMean(a, _)
            | Expr::TsStd(a, _)
            | Expr::TsDelta(a, _)
            | Expr::TsMin(a, _)
            | Expr::TsMax(a, _)
            | Expr::TsRank(a, _)
            | Expr::TsZ(a, _)
            | Expr::Ema(a, _) => 1 + a.size(),
        }
    }

    /// 对单标的序列求值（长度 = 面板天数）
    fn eval_series(&self, p: &Panel, s: usize) -> Vec<f64> {
        let n = p.n_dates();
        match self {
            Expr::Open => p.open[s].clone(),
            Expr::High => p.high[s].clone(),
            Expr::Low => p.low[s].clone(),
            Expr::Close => p.close[s].clone(),
            Expr::Volume => p.volume[s].clone(),
            Expr::Ret1 => p.ret1[s].clone(),
            Expr::Const(c) => vec![*c; n],
            Expr::Neg(a) => a.eval_series(p, s).into_iter().map(|x| -x).collect(),
            Expr::Abs(a) => a.eval_series(p, s).into_iter().map(f64::abs).collect(),
            Expr::SignedLog(a) => a
                .eval_series(p, s)
                .into_iter()
                .map(|x| x.signum() * x.abs().ln_1p())
                .collect(),
            Expr::Sign(a) => a.eval_series(p, s).into_iter().map(f64::signum).collect(),
            Expr::Add(a, b) => zip(a.eval_series(p, s), b.eval_series(p, s), |x, y| x + y),
            Expr::Sub(a, b) => zip(a.eval_series(p, s), b.eval_series(p, s), |x, y| x - y),
            Expr::Mul(a, b) => zip(a.eval_series(p, s), b.eval_series(p, s), |x, y| x * y),
            Expr::Div(a, b) => zip(a.eval_series(p, s), b.eval_series(p, s), |x, y| {
                if y.abs() < 1e-9 {
                    0.0
                } else {
                    x / y
                }
            }),
            Expr::TsMean(a, w) => rolling(&a.eval_series(p, s), *w, |win| mean(win)),
            Expr::TsStd(a, w) => rolling(&a.eval_series(p, s), *w, std_dev),
            Expr::TsDelta(a, w) => {
                let x = a.eval_series(p, s);
                (0..n)
                    .map(|t| if t < *w { f64::NAN } else { x[t] - x[t - w] })
                    .collect()
            }
            Expr::TsMin(a, w) => rolling(&a.eval_series(p, s), *w, |win| {
                win.iter().copied().fold(f64::INFINITY, f64::min)
            }),
            Expr::TsMax(a, w) => rolling(&a.eval_series(p, s), *w, |win| {
                win.iter().copied().fold(f64::NEG_INFINITY, f64::max)
            }),
            Expr::TsRank(a, w) => rolling(&a.eval_series(p, s), *w, |win| {
                let last = *win.last().unwrap();
                let below = win.iter().filter(|x| **x <= last).count();
                below as f64 / win.len() as f64
            }),
            Expr::TsZ(a, w) => rolling(&a.eval_series(p, s), *w, |win| {
                let m = mean(win);
                let sd = std_dev(win);
                if sd > 1e-12 {
                    (*win.last().unwrap() - m) / sd
                } else {
                    0.0
                }
            }),
            Expr::Ema(a, w) => {
                let x = a.eval_series(p, s);
                let alpha = 2.0 / (*w as f64 + 1.0);
                let mut out = Vec::with_capacity(n);
                let mut prev = f64::NAN;
                for v in x {
                    prev = if prev.is_nan() {
                        v
                    } else if v.is_nan() {
                        prev
                    } else {
                        alpha * v + (1.0 - alpha) * prev
                    };
                    out.push(prev);
                }
                out
            }
        }
    }

    /// 对整个面板求值 → [symbol][t]
    pub fn eval(&self, p: &Panel) -> Vec<Vec<f64>> {
        (0..p.n_symbols()).map(|s| self.eval_series(p, s)).collect()
    }

    /// 随机表达式（深度受限）
    pub fn random(rng: &mut impl Rng, depth: usize) -> Expr {
        if depth == 0 || rng.gen_bool(0.25) {
            return match rng.gen_range(0..8) {
                0 => Expr::Open,
                1 => Expr::High,
                2 => Expr::Low,
                3 => Expr::Close,
                4 => Expr::Volume,
                5 => Expr::Ret1,
                6 => Expr::Const(rng.gen_range(-2.0..2.0)),
                _ => Expr::Close,
            };
        }
        let w = WINDOWS[rng.gen_range(0..WINDOWS.len())];
        let op = rng.gen_range(0..16);
        let a = Box::new(Expr::random(rng, depth - 1));
        match op {
            0 => Expr::Neg(a),
            1 => Expr::Abs(a),
            2 => Expr::SignedLog(a),
            3 => Expr::Sign(a),
            4 => Expr::Add(a, Box::new(Expr::random(rng, depth - 1))),
            5 => Expr::Sub(a, Box::new(Expr::random(rng, depth - 1))),
            6 => Expr::Mul(a, Box::new(Expr::random(rng, depth - 1))),
            7 => Expr::Div(a, Box::new(Expr::random(rng, depth - 1))),
            8 => Expr::TsMean(a, w),
            9 => Expr::TsStd(a, w),
            10 => Expr::TsDelta(a, w),
            11 => Expr::TsMin(a, w),
            12 => Expr::TsMax(a, w),
            13 => Expr::TsRank(a, w),
            14 => Expr::TsZ(a, w),
            _ => Expr::Ema(a, w),
        }
    }

    /// 随机替换一个子树（变异）
    pub fn mutate(&self, rng: &mut impl Rng, max_depth: usize) -> Expr {
        if rng.gen_bool(0.3) {
            return Expr::random(rng, max_depth);
        }
        let mut clone = self.clone();
        let n = clone.size();
        let target = rng.gen_range(0..n);
        let mut counter = 0usize;
        replace_nth(&mut clone, target, &mut counter, rng, max_depth);
        clone
    }
}

fn replace_nth(
    e: &mut Expr,
    target: usize,
    counter: &mut usize,
    rng: &mut impl Rng,
    max_depth: usize,
) -> bool {
    if *counter == target {
        *e = Expr::random(rng, max_depth.saturating_sub(1));
        return true;
    }
    *counter += 1;
    macro_rules! rec {
        ($($child:expr),+) => {{
            $(if replace_nth($child, target, counter, rng, max_depth) { return true; })+
        }};
    }
    match e {
        Expr::Neg(a) | Expr::Abs(a) | Expr::SignedLog(a) | Expr::Sign(a) => rec!(a),
        Expr::Add(a, b) | Expr::Sub(a, b) | Expr::Mul(a, b) | Expr::Div(a, b) => rec!(a, b),
        Expr::TsMean(a, _)
        | Expr::TsStd(a, _)
        | Expr::TsDelta(a, _)
        | Expr::TsMin(a, _)
        | Expr::TsMax(a, _)
        | Expr::TsRank(a, _)
        | Expr::TsZ(a, _)
        | Expr::Ema(a, _) => rec!(a),
        _ => {}
    }
    false
}

fn zip(a: Vec<f64>, b: Vec<f64>, f: impl Fn(f64, f64) -> f64) -> Vec<f64> {
    a.into_iter().zip(b).map(|(x, y)| f(x, y)).collect()
}

fn rolling(xs: &[f64], w: usize, f: impl Fn(&[f64]) -> f64) -> Vec<f64> {
    let n = xs.len();
    let mut out = vec![f64::NAN; n];
    for t in w.saturating_sub(1)..n {
        let win = &xs[t + 1 - w..=t];
        if win.iter().any(|x| !x.is_finite()) {
            continue;
        }
        out[t] = f(win);
    }
    out
}

fn mean(xs: &[f64]) -> f64 {
    xs.iter().sum::<f64>() / xs.len() as f64
}
fn std_dev(xs: &[f64]) -> f64 {
    if xs.len() < 2 {
        return 0.0;
    }
    let m = mean(xs);
    (xs.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (xs.len() as f64 - 1.0)).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;
    use qcore::Kline;
    use rand::SeedableRng;

    fn panel() -> Panel {
        let series: Vec<(String, Vec<Kline>)> = (0..3)
            .map(|s| {
                let ks: Vec<Kline> = (0..100)
                    .map(|t| {
                        let c = 100.0 + (s as f64 + 1.0) * t as f64;
                        Kline {
                            open_time: t as i64 * 86_400_000,
                            open: c,
                            high: c,
                            low: c,
                            close: c,
                            volume: 10.0,
                            taker_buy_volume: 5.0,
                            trades: 1,
                        }
                    })
                    .collect();
                (format!("S{s}"), ks)
            })
            .collect();
        Panel::build(&series, 0.9)
    }

    #[test]
    fn eval_shapes_and_momentum() {
        let p = panel();
        let e = Expr::TsDelta(Box::new(Expr::Close), 5);
        let m = e.eval(&p);
        assert_eq!(m.len(), 3);
        assert_eq!(m[0].len(), 100);
        // S2 斜率最大：delta5 = 3*5 = 15
        assert!((m[2][50] - 15.0).abs() < 1e-9);
        assert!(m[0][2].is_nan()); // 窗口未满
    }

    #[test]
    fn random_and_mutate_bounded() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(1);
        for _ in 0..200 {
            let e = Expr::random(&mut rng, 4);
            assert!(e.size() < 200);
            let m = e.mutate(&mut rng, 4);
            assert!(m.size() < 400);
        }
    }
}
