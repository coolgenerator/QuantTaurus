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
    /// 验证窗总 bar 数（会被切成 valid_folds 个不重叠折）
    pub valid_bars: usize,
    /// 验证折数（CPCV-lite）：适应度 = 折均值 - 0.75×折标准差，
    /// 惩罚只在某一段行情中赚钱的不稳定参数
    #[serde(default = "default_valid_folds")]
    pub valid_folds: usize,
    /// 留出窗 bar 数（最近的数据，仅用于冠军晋升判定）
    pub holdout_bars: usize,
    pub bars_per_year: f64,
    pub cost: CostModel,
    pub seed: u64,
    /// 挑战者需超过冠军的 Sharpe 边际
    pub promotion_margin: f64,
    /// 晋升绝对底线：挑战者留出 Sharpe 必须高于此值（默认 0）
    #[serde(default)]
    pub promotion_floor: f64,
}

fn default_valid_folds() -> usize {
    5
}

impl Default for EvolveConfig {
    fn default() -> Self {
        Self {
            population: 24,
            offspring: 48,
            generations: 12,
            train_bars: 24 * 365,     // 1h bar ≈ 1年
            valid_bars: 24 * 90,      // ≈ 3个月
            valid_folds: default_valid_folds(),
            holdout_bars: 24 * 45,    // ≈ 1.5个月
            bars_per_year: 8760.0,
            cost: CostModel::default(),
            seed: 7,
            promotion_margin: 0.1,
            promotion_floor: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Candidate {
    pub spec: StrategySpec,
    pub train_metrics: Metrics,
    /// 整个验证区间（全部折拼起来）的指标，用于展示
    pub valid_metrics: Metrics,
    /// 每折验证 Sharpe（适应度依据）
    #[serde(default)]
    pub fold_sharpes: Vec<f64>,
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
///
/// 数据切分：[......散布验证折......][holdout]。这些策略没有"拟合"步骤
/// （参数即基因组），所以无需独立训练窗——验证折直接均匀散布在整个
/// 留出窗之前的历史上，强制候选穿越多个市场状态（牛/熊/震荡）都稳定。
/// holdout 仍只用于最终晋升判定，从不参与搜索。
pub fn evolve(
    klines: &[Kline],
    cfg: &EvolveConfig,
    incumbent: Option<&StrategySpec>,
) -> anyhow::Result<EvolveReport> {
    let n = klines.len();
    let need = cfg.holdout_bars + 1000;
    anyhow::ensure!(n > need, "not enough bars: {n} <= {need}");

    let holdout_start = n - cfg.holdout_bars;
    // 搜索区域：留出窗之前最多 train_bars + valid_bars 根
    let region_start = holdout_start.saturating_sub(cfg.train_bars + cfg.valid_bars);
    // 回测窗带前置历史热身指标（信号需要 lookback），绩效只统计窗口内
    const WARMUP: usize = 250;

    // 整个搜索区域（展示用指标）
    let train = &klines[region_start..holdout_start];
    let valid_w = train;
    let holdout_w = &klines[holdout_start.saturating_sub(WARMUP)..];

    // 验证折均匀散布在整个搜索区域，每折带 WARMUP 前缀热身
    let folds: Vec<&[Kline]> = {
        let nf = cfg.valid_folds.max(1);
        let fold_len = (holdout_start - region_start) / nf;
        anyhow::ensure!(fold_len > WARMUP, "folds too short: {fold_len} bars");
        (0..nf)
            .map(|i| {
                let fs = region_start + i * fold_len;
                let fe = if i == nf - 1 { holdout_start } else { fs + fold_len };
                &klines[fs.saturating_sub(WARMUP)..fe]
            })
            .collect()
    };

    let mut rng = StdRng::seed_from_u64(cfg.seed);
    let mut evals = 0usize;

    let mut make_candidate =
        |spec: StrategySpec, generation: usize, parent: Option<usize>, evals: &mut usize| {
            *evals += 1;
            let fold_sharpes: Vec<f64> =
                folds.iter().map(|f| eval(&spec, f, cfg, *evals).sharpe).collect();
            Candidate {
                train_metrics: eval(&spec, train, cfg, *evals),
                valid_metrics: eval(&spec, valid_w, cfg, *evals),
                fold_sharpes,
                holdout_metrics: None,
                spec,
                generation,
                parent,
            }
        };

    // 初始种群：四个家族均匀混合
    let mut pop: Vec<Candidate> = (0..cfg.population)
        .map(|i| {
            let spec = StrategySpec::random(i, &mut rng);
            make_candidate(spec, 0, None, &mut evals)
        })
        .collect();

    let fitness = |c: &Candidate| {
        // CPCV-lite：折均值 - 0.75×折标准差，要求每折都稳定赚钱
        let k = c.fold_sharpes.len() as f64;
        let mean = c.fold_sharpes.iter().sum::<f64>() / k;
        let var = c.fold_sharpes.iter().map(|s| (s - mean).powi(2)).sum::<f64>() / k;
        let mut f = mean - 0.75 * var.sqrt();
        // 训练集亏损的直接重罚（防纯噪声）
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
            children.push(make_candidate(spec, gen, Some(pidx), &mut evals));
        }
        pop.extend(children);
        pop.sort_by(|a, b| fitness(b).partial_cmp(&fitness(a)).unwrap());
        pop.truncate(cfg.population);
        curve.push(pop[0].valid_metrics.sharpe);
        tracing::debug!(gen, best_valid_sharpe = pop[0].valid_metrics.sharpe, "generation done");
    }

    // 构建 ensemble 挑战者：按适应度顺序优先选不同家族的 top-k 成员，
    // 等权平均仓位以降低单参数点的方差
    const ENSEMBLE_K: usize = 5;
    let mut members: Vec<StrategySpec> = Vec::new();
    let mut kinds_seen: Vec<&'static str> = Vec::new();
    for c in &pop {
        if !kinds_seen.contains(&c.spec.name()) {
            kinds_seen.push(c.spec.name());
            members.push(c.spec.clone());
        }
        if members.len() >= ENSEMBLE_K {
            break;
        }
    }
    for c in &pop {
        if members.len() >= ENSEMBLE_K {
            break;
        }
        if !members.contains(&c.spec) {
            members.push(c.spec.clone());
        }
    }
    let ensemble = make_candidate(
        StrategySpec::Ensemble { members },
        cfg.generations + 1,
        None,
        &mut evals,
    );

    // 挑战者 = 单点最优 vs ensemble，按折适应度（非留出！）取优
    let mut challenger = if fitness(&ensemble) > fitness(&pop[0]) {
        ensemble
    } else {
        pop[0].clone()
    };
    challenger.holdout_metrics = Some(eval(&challenger.spec, holdout_w, cfg, evals));
    let challenger_ho = challenger.holdout_metrics.as_ref().unwrap().sharpe;

    // 绝对底线：留出集 Sharpe ≤ 0 的挑战者永不晋升（即使没有现任冠军——
    // 宁可空缺也不上一个在最新数据上亏钱的策略）
    let passes_floor = challenger_ho > cfg.promotion_floor;

    let (champion, promoted) = match incumbent {
        Some(inc) => {
            let inc_ho = eval(inc, holdout_w, cfg, evals).sharpe;
            if passes_floor && challenger_ho > inc_ho + cfg.promotion_margin {
                (challenger.clone(), true)
            } else {
                let keep = Candidate {
                    spec: inc.clone(),
                    train_metrics: eval(inc, train, cfg, evals),
                    valid_metrics: eval(inc, valid_w, cfg, evals),
                    fold_sharpes: folds.iter().map(|f| eval(inc, f, cfg, evals).sharpe).collect(),
                    holdout_metrics: Some(eval(inc, holdout_w, cfg, evals)),
                    generation: 0,
                    parent: None,
                };
                (keep, false)
            }
        }
        None => (challenger.clone(), passes_floor),
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
        // 晋升当且仅当挑战者通过留出底线
        let ho = rep.champion.holdout_metrics.as_ref().unwrap().sharpe;
        assert_eq!(rep.promoted, ho > cfg.promotion_floor);
        assert_eq!(rep.fitness_curve.len(), 3);
        assert!(rep.total_evaluations > 0);
        assert_eq!(rep.champion.fold_sharpes.len(), cfg.valid_folds);
    }
}
