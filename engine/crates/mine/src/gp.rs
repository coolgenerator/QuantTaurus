//! 遗传规划挖掘循环：以横截面 IC 为适应度。
//!
//! 适应度 = 时间折 RankIC 均值 − stability_lambda × 折间标准差
//!          − complexity_lambda × 节点数 − redundancy_lambda × max|与已选因子相关|
//! 留出期（最近 holdout_frac）从不参与适应度计算，只做最终验收。

use crate::expr::Expr;
use crate::panel::Panel;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MineConfig {
    pub population: usize,
    pub generations: usize,
    pub max_depth: usize,
    /// 预测期（交易日）：IC 用 t 因子值 vs t→t+h 收益
    pub horizon: usize,
    /// 时间折数（搜索期内）
    pub folds: usize,
    /// 留出比例（最近的数据，不参与搜索）
    pub holdout_frac: f64,
    pub stability_lambda: f64,
    pub complexity_lambda: f64,
    pub redundancy_lambda: f64,
    /// 最终选出的因子数（按适应度贪心 + 正交性）
    pub top_k: usize,
    pub seed: u64,
    /// 留出期 RankIC 验收底线
    pub holdout_ic_floor: f64,
}

impl Default for MineConfig {
    fn default() -> Self {
        Self {
            population: 150,
            generations: 25,
            max_depth: 4,
            horizon: 5,
            folds: 4,
            holdout_frac: 0.2,
            stability_lambda: 1.0,
            complexity_lambda: 0.002,
            redundancy_lambda: 0.5,
            top_k: 5,
            seed: 42,
            holdout_ic_floor: 0.01,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MinedFactor {
    pub expression: String,
    #[serde(skip)]
    pub expr: Expr,
    pub fitness: f64,
    pub fold_ics: Vec<f64>,
    pub mean_ic: f64,
    /// ICIR = 搜索期日度IC均值/标准差 × sqrt(252/h)
    pub icir: f64,
    pub holdout_ic: f64,
    pub passed_holdout: bool,
    pub complexity: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct MineReport {
    pub factors: Vec<MinedFactor>,
    pub generations_best: Vec<f64>,
    pub total_evaluated: usize,
    pub search_dates: (i64, i64),
    pub holdout_dates: (i64, i64),
}

/// 横截面 z 分（strategy 模块复用）
pub fn cs_zscore_pub(mat: &mut [Vec<f64>]) {
    cs_zscore(mat)
}

/// 横截面 z 分（每个时点跨标的）；NaN 保持
fn cs_zscore(mat: &mut [Vec<f64>]) {
    let n_t = mat[0].len();
    for t in 0..n_t {
        let vals: Vec<f64> = mat.iter().map(|row| row[t]).filter(|v| v.is_finite()).collect();
        if vals.len() < 3 {
            for row in mat.iter_mut() {
                row[t] = f64::NAN;
            }
            continue;
        }
        let m = vals.iter().sum::<f64>() / vals.len() as f64;
        let sd = (vals.iter().map(|v| (v - m).powi(2)).sum::<f64>() / vals.len() as f64).sqrt();
        for row in mat.iter_mut() {
            if row[t].is_finite() {
                row[t] = if sd > 1e-12 { (row[t] - m) / sd } else { 0.0 };
            }
        }
    }
}

/// 单时点横截面 Spearman 秩相关
fn rank_ic_at(factor: &[Vec<f64>], fwd: &[Vec<f64>], t: usize) -> Option<f64> {
    let pairs: Vec<(f64, f64)> = factor
        .iter()
        .zip(fwd)
        .filter_map(|(f, r)| {
            let (x, y) = (f[t], r[t]);
            if x.is_finite() && y.is_finite() {
                Some((x, y))
            } else {
                None
            }
        })
        .collect();
    if pairs.len() < 8 {
        return None;
    }
    let rank = |vals: Vec<f64>| -> Vec<f64> {
        let mut idx: Vec<usize> = (0..vals.len()).collect();
        idx.sort_by(|&a, &b| vals[a].partial_cmp(&vals[b]).unwrap());
        let mut r = vec![0.0; vals.len()];
        for (rank_pos, &i) in idx.iter().enumerate() {
            r[i] = rank_pos as f64;
        }
        r
    };
    let rx = rank(pairs.iter().map(|p| p.0).collect());
    let ry = rank(pairs.iter().map(|p| p.1).collect());
    let n = rx.len() as f64;
    let mx = rx.iter().sum::<f64>() / n;
    let my = ry.iter().sum::<f64>() / n;
    let (mut cov, mut vx, mut vy) = (0.0, 0.0, 0.0);
    for i in 0..rx.len() {
        cov += (rx[i] - mx) * (ry[i] - my);
        vx += (rx[i] - mx).powi(2);
        vy += (ry[i] - my).powi(2);
    }
    if vx <= 0.0 || vy <= 0.0 {
        return Some(0.0);
    }
    Some(cov / (vx.sqrt() * vy.sqrt()))
}

/// 区间 [t0, t1) 的日度 RankIC 序列
fn ic_series(factor: &[Vec<f64>], fwd: &[Vec<f64>], t0: usize, t1: usize) -> Vec<f64> {
    (t0..t1).filter_map(|t| rank_ic_at(factor, fwd, t)).collect()
}

fn mean(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        0.0
    } else {
        xs.iter().sum::<f64>() / xs.len() as f64
    }
}
fn std(xs: &[f64]) -> f64 {
    if xs.len() < 2 {
        return 0.0;
    }
    let m = mean(xs);
    (xs.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (xs.len() as f64 - 1.0)).sqrt()
}

/// 两个因子矩阵在搜索期的横截面值相关（冗余度）
fn factor_corr(a: &[Vec<f64>], b: &[Vec<f64>], t0: usize, t1: usize) -> f64 {
    let (mut xs, mut ys) = (Vec::new(), Vec::new());
    for t in (t0..t1).step_by(5) {
        for s in 0..a.len() {
            if a[s][t].is_finite() && b[s][t].is_finite() {
                xs.push(a[s][t]);
                ys.push(b[s][t]);
            }
        }
    }
    if xs.len() < 50 {
        return 0.0;
    }
    let (mx, my) = (mean(&xs), mean(&ys));
    let (mut cov, mut vx, mut vy) = (0.0, 0.0, 0.0);
    for i in 0..xs.len() {
        cov += (xs[i] - mx) * (ys[i] - my);
        vx += (xs[i] - mx).powi(2);
        vy += (ys[i] - my).powi(2);
    }
    if vx <= 0.0 || vy <= 0.0 {
        0.0
    } else {
        (cov / (vx.sqrt() * vy.sqrt())).abs()
    }
}

struct Evaled {
    expr: Expr,
    z: Vec<Vec<f64>>,
    fold_ics: Vec<f64>,
    raw_fitness: f64,
}

/// 主挖掘入口
pub fn mine(panel: &Panel, cfg: &MineConfig) -> MineReport {
    let n = panel.n_dates();
    let holdout_start = n - ((n as f64 * cfg.holdout_frac) as usize).max(cfg.horizon + 10);
    let search_end = holdout_start.saturating_sub(cfg.horizon); // 防止泄漏：搜索期 fwd ret 不跨入留出
    let fwd = panel.forward_returns(cfg.horizon);
    let warmup = 130; // 最大窗口余量
    let fold_len = (search_end - warmup) / cfg.folds;

    let mut rng = StdRng::seed_from_u64(cfg.seed);
    let mut evaluated = 0usize;

    let eval_expr = |e: &Expr, evaluated: &mut usize| -> Option<Evaled> {
        *evaluated += 1;
        let mut z = e.eval(panel);
        cs_zscore(&mut z);
        let fold_ics: Vec<f64> = (0..cfg.folds)
            .map(|k| {
                let t0 = warmup + k * fold_len;
                let t1 = if k == cfg.folds - 1 { search_end } else { t0 + fold_len };
                mean(&ic_series(&z, &fwd, t0, t1))
            })
            .collect();
        if fold_ics.iter().any(|x| !x.is_finite()) {
            return None;
        }
        // 方向归一：负 IC 因子取反等价，用 |均值| 但要求折间同号占优
        let m = mean(&fold_ics);
        let sd = std(&fold_ics);
        let raw = m.abs() - cfg.stability_lambda * sd - cfg.complexity_lambda * e.size() as f64;
        Some(Evaled {
            expr: e.clone(),
            z,
            fold_ics,
            raw_fitness: raw,
        })
    };

    // 初始种群（含几个文献种子，给搜索一个有意义的起点）
    let seeds = vec![
        // 经典动量（跳过近月的简化版）
        Expr::TsDelta(Box::new(Expr::SignedLog(Box::new(Expr::Close))), 126),
        // 短期反转
        Expr::Neg(Box::new(Expr::TsDelta(Box::new(Expr::SignedLog(Box::new(Expr::Close))), 5))),
        // 低波动异象
        Expr::Neg(Box::new(Expr::TsStd(Box::new(Expr::Ret1), 21))),
        // 量价：放量上涨
        Expr::Mul(
            Box::new(Expr::Sign(Box::new(Expr::TsDelta(Box::new(Expr::Close), 5)))),
            Box::new(Expr::TsZ(Box::new(Expr::Volume), 21)),
        ),
    ];
    let mut pop: Vec<Evaled> = Vec::new();
    for s in seeds {
        if let Some(ev) = eval_expr(&s, &mut evaluated) {
            pop.push(ev);
        }
    }
    while pop.len() < cfg.population {
        let e = Expr::random(&mut rng, cfg.max_depth);
        if let Some(ev) = eval_expr(&e, &mut evaluated) {
            pop.push(ev);
        }
    }

    let mut gen_best = Vec::with_capacity(cfg.generations);
    for g in 0..cfg.generations {
        pop.sort_by(|a, b| b.raw_fitness.partial_cmp(&a.raw_fitness).unwrap());
        pop.truncate(cfg.population / 2);
        gen_best.push(pop[0].raw_fitness);
        tracing::debug!(gen = g, best = pop[0].raw_fitness, "mine generation");
        let parents = pop.len();
        while pop.len() < cfg.population {
            let p = &pop[rng.gen_range(0..parents)].expr;
            let child = p.mutate(&mut rng, cfg.max_depth);
            if child.size() > 40 {
                continue;
            }
            if let Some(ev) = eval_expr(&child, &mut evaluated) {
                pop.push(ev);
            }
        }
    }
    pop.sort_by(|a, b| b.raw_fitness.partial_cmp(&a.raw_fitness).unwrap());

    // 贪心选 top_k：扣冗余（与已选因子的相关性）
    let mut selected: Vec<Evaled> = Vec::new();
    for cand in pop.into_iter() {
        if selected.len() >= cfg.top_k {
            break;
        }
        let max_corr = selected
            .iter()
            .map(|s| factor_corr(&cand.z, &s.z, warmup, search_end))
            .fold(0.0f64, f64::max);
        let adj = cand.raw_fitness - cfg.redundancy_lambda * max_corr.powi(2);
        if adj <= 0.0 || max_corr > 0.7 {
            continue;
        }
        selected.push(cand);
    }

    // 留出期验收
    let factors: Vec<MinedFactor> = selected
        .into_iter()
        .map(|ev| {
            let search_ics = ic_series(&ev.z, &fwd, warmup, search_end);
            let mut m_ic = mean(&search_ics);
            let mut holdout_ics = ic_series(&ev.z, &fwd, holdout_start, n.saturating_sub(cfg.horizon));
            // 方向归一：搜索期 IC 为负则因子取反（留出 IC 同步翻转）
            let flip = m_ic < 0.0;
            if flip {
                m_ic = -m_ic;
                for x in &mut holdout_ics {
                    *x = -*x;
                }
            }
            let h_ic = mean(&holdout_ics);
            let sd_ic = std(&search_ics);
            let icir = if sd_ic > 1e-12 {
                m_ic / sd_ic * (252.0 / cfg.horizon as f64).sqrt()
            } else {
                0.0
            };
            // 方向归一后的最终可执行表达式
            let final_expr = if flip {
                Expr::Neg(Box::new(ev.expr))
            } else {
                ev.expr
            };
            MinedFactor {
                expression: final_expr.to_string(),
                complexity: final_expr.size(),
                fitness: ev.raw_fitness,
                fold_ics: ev.fold_ics,
                mean_ic: m_ic,
                icir,
                holdout_ic: h_ic,
                passed_holdout: h_ic > cfg.holdout_ic_floor,
                expr: final_expr,
            }
        })
        .collect();

    MineReport {
        factors,
        generations_best: gen_best,
        total_evaluated: evaluated,
        search_dates: (panel.dates[warmup], panel.dates[search_end.min(n - 1)]),
        holdout_dates: (panel.dates[holdout_start], panel.dates[n - 1]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use qcore::Kline;

    /// 合成面板：嵌入一个真实信号——过去5日收益与未来5日收益负相关（反转）
    fn synth_panel(n_sym: usize, n_t: usize) -> Panel {
        let mut state = 99u64;
        let mut rnd = move || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((state >> 33) as f64 / (1u64 << 31) as f64) - 1.0
        };
        let series: Vec<(String, Vec<Kline>)> = (0..n_sym)
            .map(|s| {
                let mut c = 100.0 + s as f64;
                let mut shock = 0.0f64;
                let ks: Vec<Kline> = (0..n_t)
                    .map(|t| {
                        // 均值回归冲击：本期受冲击，未来5日回吐 → 反转信号
                        let new_shock = 0.02 * rnd();
                        let r = new_shock - shock / 5.0 + 0.003 * rnd();
                        shock = shock * 0.8 + new_shock;
                        c *= 1.0 + r;
                        Kline {
                            open_time: t as i64 * 86_400_000,
                            open: c,
                            high: c,
                            low: c,
                            close: c,
                            volume: 100.0,
                            taker_buy_volume: 50.0,
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
    fn mine_finds_signal_on_synthetic_panel() {
        let p = synth_panel(20, 800);
        let cfg = MineConfig {
            population: 40,
            generations: 6,
            top_k: 3,
            ..Default::default()
        };
        let rep = mine(&p, &cfg);
        assert!(rep.total_evaluated > 100);
        assert!(!rep.factors.is_empty(), "should select at least one factor");
        // 嵌入了反转信号，最优因子搜索期 IC 应显著为正（方向归一后）
        assert!(rep.factors[0].mean_ic > 0.02, "mean_ic={}", rep.factors[0].mean_ic);
    }

    #[test]
    fn holdout_never_overlaps_search() {
        let p = synth_panel(15, 600);
        let cfg = MineConfig {
            population: 20,
            generations: 2,
            ..Default::default()
        };
        let rep = mine(&p, &cfg);
        assert!(rep.search_dates.1 < rep.holdout_dates.0);
    }
}
