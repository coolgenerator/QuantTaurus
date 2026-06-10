//! 策略自迭代机制：滚动 walk-forward + (μ+λ) 进化搜索 + 冠军-挑战者晋升。
//!
//! 防过拟合三道闸（López de Prado 2018 思想）：
//! 1. 训练窗内进化搜索，**验证窗**适应度选优（参数从未见过验证数据）
//! 2. 适应度 = 验证窗 Sharpe，并记录搜索次数喂给 Deflated Sharpe
//! 3. 晋升门槛：挑战者在**留出窗**(最近、从未参与搜索) 上的 Sharpe
//!    必须超过现任冠军一定边际，否则维持现状

use qcore::{Kline, Metrics};
use qbacktest::{run, to_signals, CostModel};
use qstrategy::StrategySpec;
use rand::rngs::StdRng;
use rand::SeedableRng;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvolveConfig {
    /// 种群 μ
    pub population: usize,
    /// 每代子代 λ
    pub offspring: usize,
    pub generations: usize,
    /// 训练窗 bar 数
    pub train_bars: usize,
    /// 验证窗 bar 数
    pub valid_bars: usize,
    /// 留出窗 bar 数（最近的数据，仅用于冠军晋升判定）
    pub holdout_bars: usize,
    pub bars_per_year: f64,
    pub cost: CostModel,
    pub seed: u64,
    /// 挑战者需超过冠军的 Sharpe 边际
    pub promotion_margin: f64,
}

impl Default for EvolveConfig {
    fn default() -> Self {
        Self {
            population: 24,
            offspring: 48,
            generations: 12,
            train_bars: 24 * 365,     // 1h bar ≈ 1年
            valid_bars: 24 * 90,      // ≈ 3个月
            holdout_bars: 24 * 45,    // ≈ 1.5个月
            bars_per_year: 8760.0,
            cost: CostModel::default(),
            seed: 7,
            promotion_margin: 0.1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Candidate {
    pub spec: StrategySpec,
    pub train_metrics: Metrics,
    pub valid_metrics: Metrics,
    pub holdout_metrics: Option<Metrics>,
    pub generation: usize,
    /// 父代在上一代种群中的序号（谱系图用）
    pub parent: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvolveReport {
    pub champion: Candidate,
    pub promoted: bool,
    /// 每代最优验证 Sharpe（进化曲线）
    pub fitness_curve: Vec<f64>,
    /// 最终种群（谱系展示）
    pub final_population: Vec<Candidate>,
    pub total_evaluations: usize,
}

fn eval(
    spec: &StrategySpec,
    klines: &[Kline],
    cfg: &EvolveConfig,
    num_trials: usize,
) -> Metrics {
    let targets = spec.signals(klines);
    let sigs = to_signals(klines, &targets);
    run(klines, &sigs, cfg.cost, cfg.bars_per_year, num_trials).metrics
}

/// 在给定K线上跑一轮完整进化，与现任冠军（如有）对决。
/// 数据切分：[...train][valid][holdout]，holdout 在最末端。
pub fn evolve(
    klines: &[Kline],
    cfg: &EvolveConfig,
    incumbent: Option<&StrategySpec>,
) -> anyhow::Result<EvolveReport> {
    let n = klines.len();
    let need = cfg.valid_bars + cfg.holdout_bars + 500;
    anyhow::ensure!(n > need, "not enough bars: {n} <= {need}");

    let holdout_start = n - cfg.holdout_bars;
    let valid_start = holdout_start - cfg.valid_bars;
    let train_start = valid_start.saturating_sub(cfg.train_bars);
    // 验证/留出窗回测时带上前置历史以热身指标（信号需要 lookback），
    // 但绩效只统计窗口内：通过把窗口起点前移 lookback 上限 (250) 实现热身
    const WARMUP: usize = 250;

    let train = &klines[train_start..valid_start];
    let valid_w = &klines[valid_start.saturating_sub(WARMUP)..holdout_start];
    let holdout_w = &klines[holdout_start.saturating_sub(WARMUP)..];

    let mut rng = StdRng::seed_from_u64(cfg.seed);
    let mut evals = 0usize;

    // 初始种群：四个家族均匀混合
    let mut pop: Vec<Candidate> = (0..cfg.population)
        .map(|i| {
            let spec = StrategySpec::random(i, &mut rng);
            evals += 1;
            Candidate {
                train_metrics: eval(&spec, train, cfg, evals),
                valid_metrics: eval(&spec, valid_w, cfg, evals),
                holdout_metrics: None,
                spec,
                generation: 0,
                parent: None,
            }
        })
        .collect();

    let fitness = |c: &Candidate| {
        // 验证 Sharpe 为主，训练集亏损的直接重罚（防纯噪声）
        let mut f = c.valid_metrics.sharpe;
        if c.train_metrics.sharpe < 0.0 {
            f -= 1.0;
        }
        if c.valid_metrics.num_trades < 4 {
            f -= 0.5;
        }
        f
    };

    let mut curve = Vec::with_capacity(cfg.generations);
    for gen in 1..=cfg.generations {
        let mut children: Vec<Candidate> = Vec::with_capacity(cfg.offspring);
        for j in 0..cfg.offspring {
            let pidx = j % pop.len();
            let spec = pop[pidx].spec.mutate(&mut rng);
            evals += 1;
            children.push(Candidate {
                train_metrics: eval(&spec, train, cfg, evals),
                valid_metrics: eval(&spec, valid_w, cfg, evals),
                holdout_metrics: None,
                spec,
                generation: gen,
                parent: Some(pidx),
            });
        }
        pop.extend(children);
        pop.sort_by(|a, b| fitness(b).partial_cmp(&fitness(a)).unwrap());
        pop.truncate(cfg.population);
        curve.push(pop[0].valid_metrics.sharpe);
        tracing::debug!(gen, best_valid_sharpe = pop[0].valid_metrics.sharpe, "generation done");
    }

    // 挑战者 = 验证集最优；在留出集上与现任冠军终极对决
    let mut challenger = pop[0].clone();
    challenger.holdout_metrics = Some(eval(&challenger.spec, holdout_w, cfg, evals));
    let challenger_ho = challenger.holdout_metrics.as_ref().unwrap().sharpe;

    let (champion, promoted) = match incumbent {
        Some(inc) => {
            let inc_ho = eval(inc, holdout_w, cfg, evals).sharpe;
            if challenger_ho > inc_ho + cfg.promotion_margin {
                (challenger.clone(), true)
            } else {
                let mut keep = Candidate {
                    spec: inc.clone(),
                    train_metrics: eval(inc, train, cfg, evals),
                    valid_metrics: eval(inc, valid_w, cfg, evals),
                    holdout_metrics: Some(eval(inc, holdout_w, cfg, evals)),
                    generation: 0,
                    parent: None,
                };
                keep.holdout_metrics = Some(eval(inc, holdout_w, cfg, evals));
                (keep, false)
            }
        }
        None => (challenger.clone(), true),
    };

    Ok(EvolveReport {
        champion,
        promoted,
        fitness_curve: curve,
        final_population: pop,
        total_evaluations: evals,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use qcore::Kline;

    /// 合成带趋势+噪声的行情
    fn synth(n: usize) -> Vec<Kline> {
        let mut rng_state = 12345u64;
        let mut rnd = move || {
            rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((rng_state >> 33) as f64 / (1u64 << 31) as f64) - 1.0
        };
        let mut c = 100.0f64;
        (0..n)
            .map(|i| {
                let drift = if (i / 500) % 2 == 0 { 0.0004 } else { -0.0002 };
                c *= 1.0 + drift + 0.004 * rnd();
                Kline {
                    open_time: i as i64 * 3_600_000,
                    open: c,
                    high: c * 1.002,
                    low: c * 0.998,
                    close: c,
                    volume: 100.0 + 50.0 * rnd().abs(),
                    taker_buy_volume: 50.0,
                    trades: 10,
                }
            })
            .collect()
    }

    #[test]
    fn evolve_runs_and_promotes_first_champion() {
        let ks = synth(4000);
        let cfg = EvolveConfig {
            population: 6,
            offspring: 8,
            generations: 3,
            train_bars: 2000,
            valid_bars: 600,
            holdout_bars: 400,
            ..Default::default()
        };
        let rep = evolve(&ks, &cfg, None).unwrap();
        assert!(rep.promoted);
        assert_eq!(rep.fitness_curve.len(), 3);
        assert!(rep.total_evaluations > 0);
    }
}
