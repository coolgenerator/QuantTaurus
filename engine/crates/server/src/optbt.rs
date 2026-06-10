//! 期权策略参数化回测（Black-Scholes 合成定价）。
//!
//! ⚠️ 诚实声明：没有历史期权链数据（moomoo/Yahoo 只给当前快照），
//! 本回测用 BS 模型 + 已实现波动率×IV溢价系数合成期权价格。
//! 能检验"信号→期权规则"的结构盈亏，无法捕捉真实 IV 动态
//! （财报IV挤压、偏度变化、流动性枯竭）。结果偏乐观侧，须打折看。
//!
//! 规则与实盘期权计划完全一致：
//! - 股票信号方向 → 买 Call/Put，|Δ|≈0.35 选行权价
//! - 到期 = 持有期×1.5（≥14天）
//! - 卖出：信号反转 / DTE≤7 / 权利金 +100%/-50%
//! - 成本：$0.65/张/边 + 权利金 2%/边 点差滑点

use qcore::Kline;
use qstrategy::StrategySpec;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct OptBtParams {
    /// 合成IV = 20日已实现波动 × 该系数（期权通常贵于已实现）
    #[serde(default = "d_iv_premium")]
    pub iv_premium: f64,
    /// 无风险利率
    #[serde(default = "d_rate")]
    pub rate: f64,
    /// 每次开仓投入的权利金占净值比例
    #[serde(default = "d_budget")]
    pub budget_frac: f64,
    #[serde(default = "d_capital")]
    pub capital_usd: f64,
    #[serde(default = "d_fee")]
    pub fee_per_contract: f64,
    /// 点差滑点（占权利金，单边）
    #[serde(default = "d_spread")]
    pub spread_frac: f64,
    #[serde(default = "d_delta")]
    pub delta_target: f64,
}
fn d_iv_premium() -> f64 { 1.15 }
fn d_rate() -> f64 { 0.04 }
fn d_budget() -> f64 { 0.10 }
fn d_capital() -> f64 { 10_000.0 }
fn d_fee() -> f64 { 0.65 }
fn d_spread() -> f64 { 0.02 }
fn d_delta() -> f64 { 0.35 }

impl Default for OptBtParams {
    fn default() -> Self {
        serde_json::from_str("{}").unwrap()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OptTradeLog {
    pub entry_time: i64,
    pub exit_time: i64,
    pub is_call: bool,
    pub strike: f64,
    pub entry_premium: f64,
    pub exit_premium: f64,
    pub qty: u32,
    pub pnl_usd: f64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OptBtResult {
    pub metrics: qcore::Metrics,
    pub equity: Vec<qcore::EquityPoint>,
    pub trades: Vec<OptTradeLog>,
    pub total_fees_usd: f64,
    pub note: String,
}

struct OpenPos {
    is_call: bool,
    strike: f64,
    expiry_bar: usize,
    entry_premium: f64,
    qty: u32,
    entry_time: i64,
    direction: f64,
}

fn norm_cdf(x: f64) -> f64 {
    0.5 * (1.0 + erf(x / std::f64::consts::SQRT_2))
}
fn erf(x: f64) -> f64 {
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
/// Φ⁻¹ 简化（只需常用范围）：牛顿迭代
fn inv_norm(p: f64) -> f64 {
    let mut x = 0.0f64;
    for _ in 0..50 {
        let f = norm_cdf(x) - p;
        let pdf = (-(x * x) / 2.0).exp() / (2.0 * std::f64::consts::PI).sqrt();
        if pdf < 1e-12 {
            break;
        }
        x -= f / pdf;
    }
    x
}

/// BS 期权价
fn bs_price(s: f64, k: f64, t_years: f64, sigma: f64, r: f64, is_call: bool) -> f64 {
    if t_years <= 0.0 {
        return if is_call { (s - k).max(0.0) } else { (k - s).max(0.0) };
    }
    let st = sigma * t_years.sqrt();
    let d1 = ((s / k).ln() + (r + sigma * sigma / 2.0) * t_years) / st;
    let d2 = d1 - st;
    if is_call {
        s * norm_cdf(d1) - k * (-r * t_years).exp() * norm_cdf(d2)
    } else {
        k * (-r * t_years).exp() * norm_cdf(-d2) - s * norm_cdf(-d1)
    }
}

/// 由目标 delta 反推行权价
fn strike_for_delta(s: f64, t_years: f64, sigma: f64, r: f64, is_call: bool, delta: f64) -> f64 {
    let d1 = if is_call {
        inv_norm(delta)
    } else {
        inv_norm(1.0 - delta) // put: N(d1)-1 = -delta
    };
    s * ((r + sigma * sigma / 2.0) * t_years - d1 * sigma * t_years.sqrt()).exp()
}

/// 用日线K线 + 股票信号策略跑期权规则回测
pub fn run(
    klines: &[Kline],
    spec: &StrategySpec,
    horizon_days: f64,
    p: &OptBtParams,
) -> OptBtResult {
    let signals = spec.signals(klines);
    let vols = qfactors::realized_vol(klines, 20);
    let n = klines.len();

    let mut cash = p.capital_usd;
    let mut pos: Option<OpenPos> = None;
    let mut curve = Vec::with_capacity(n);
    let mut rets = Vec::with_capacity(n);
    let mut trades: Vec<OptTradeLog> = Vec::new();
    let mut total_fees = 0.0f64;
    let mut prev_equity = p.capital_usd;

    let dte_target = ((horizon_days * 1.5).ceil() as usize).max(14);

    for i in 0..n {
        let s = klines[i].close;
        let sigma = {
            let v = vols[i];
            if v.is_finite() && v > 0.0 {
                (v * (252.0f64).sqrt() * p.iv_premium).max(0.10)
            } else {
                f64::NAN
            }
        };

        // 持仓估值与离场检查
        if let Some(op) = &pos {
            let dte_bars = op.expiry_bar.saturating_sub(i);
            let t_years = dte_bars as f64 / 252.0;
            let mark = if sigma.is_finite() {
                bs_price(s, op.strike, t_years, sigma, p.rate, op.is_call)
            } else {
                f64::NAN
            };
            if mark.is_finite() {
                let pnl_pct = mark / op.entry_premium - 1.0;
                // 信号反转 = 当前信号方向与持仓方向不符
                let sig = signals[i];
                let flipped = sig * op.direction <= 0.0;
                let reason = if dte_bars <= 7 {
                    Some("DTE≤7")
                } else if pnl_pct >= 1.0 {
                    Some("止盈+100%")
                } else if pnl_pct <= -0.5 {
                    Some("止损-50%")
                } else if flipped {
                    Some("信号反转")
                } else {
                    None
                };
                if let Some(r) = reason {
                    let sell = mark * (1.0 - p.spread_frac);
                    let fees = p.fee_per_contract * op.qty as f64;
                    total_fees += fees;
                    cash += sell * 100.0 * op.qty as f64 - fees;
                    trades.push(OptTradeLog {
                        entry_time: op.entry_time,
                        exit_time: klines[i].open_time,
                        is_call: op.is_call,
                        strike: op.strike,
                        entry_premium: op.entry_premium,
                        exit_premium: sell,
                        qty: op.qty,
                        pnl_usd: (sell - op.entry_premium) * 100.0 * op.qty as f64
                            - 2.0 * p.fee_per_contract * op.qty as f64,
                        reason: r.to_string(),
                    });
                    pos = None;
                }
            }
        }

        // 开仓：无持仓 + 信号明确 + 波动可估 + 不在数据末尾
        if pos.is_none() && sigma.is_finite() && i + dte_target < n {
            let sig = signals[i];
            if sig.abs() >= 0.10 {
                let is_call = sig > 0.0;
                let t_years = dte_target as f64 / 252.0;
                let k = strike_for_delta(s, t_years, sigma, p.rate, is_call, p.delta_target);
                let fair = bs_price(s, k, t_years, sigma, p.rate, is_call);
                let buy = fair * (1.0 + p.spread_frac);
                let equity_now = cash; // 无持仓时净值=现金
                let budget = equity_now * p.budget_frac;
                let qty = (budget / (buy * 100.0)).floor() as u32;
                if qty >= 1 {
                    let fees = p.fee_per_contract * qty as f64;
                    total_fees += fees;
                    cash -= buy * 100.0 * qty as f64 + fees;
                    pos = Some(OpenPos {
                        is_call,
                        strike: k,
                        expiry_bar: i + dte_target,
                        entry_premium: buy,
                        qty,
                        entry_time: klines[i].open_time,
                        direction: sig.signum(),
                    });
                }
            }
        }

        // 当日净值
        let pos_val = pos.as_ref().map_or(0.0, |op| {
            let t_years = op.expiry_bar.saturating_sub(i) as f64 / 252.0;
            if sigma.is_finite() {
                bs_price(s, op.strike, t_years, sigma, p.rate, op.is_call) * 100.0 * op.qty as f64
            } else {
                op.entry_premium * 100.0 * op.qty as f64
            }
        });
        let equity = cash + pos_val;
        rets.push(equity / prev_equity - 1.0);
        prev_equity = equity;
        curve.push(qcore::EquityPoint {
            time: klines[i].open_time,
            equity: equity / p.capital_usd,
            position: pos.as_ref().map_or(0.0, |op| op.direction),
            price: s,
        });
    }

    let wins = trades.iter().filter(|t| t.pnl_usd > 0.0).count() as u64;
    let metrics = qbacktest::compute_metrics(&rets, &curve, 252.0, trades.len() as u64, wins, 1);
    OptBtResult {
        metrics,
        equity: curve,
        trades,
        total_fees_usd: total_fees,
        note: "合成定价回测（BS+已实现波动×IV溢价），含 $0.65/张/边手续费 + 2%/边点差。\
               未建模真实IV动态（财报挤压/偏度），结果偏乐观，建议打折解读。"
            .to_string(),
    }
}
