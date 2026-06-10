//! 技术分析端点的纯计算层：权威指标全集 + 趋势 + 双层买卖点信号。
//!
//! 经典信号是教科书口径（金叉死叉/超买超卖/布林触轨回收），**未经回测闸门验证**，
//! 仅作图表参考；冠军信号来自注册表里通过 evolve 闸门的策略，是两套独立的层。

use qcore::Kline;
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

/// 布林带 (n, 2σ)：返回 (上轨, 中轨, 下轨)。
fn bollinger_bands(klines: &[Kline], n: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let c: Vec<f64> = klines.iter().map(|k| k.close).collect();
    let len = c.len();
    let (mut up, mut mid, mut dn) = (
        vec![f64::NAN; len],
        vec![f64::NAN; len],
        vec![f64::NAN; len],
    );
    for i in n..len {
        let w = &c[i + 1 - n..=i];
        let m = qfactors::mean(w);
        let s = qfactors::std_dev(w);
        mid[i] = m;
        up[i] = m + 2.0 * s;
        dn[i] = m - 2.0 * s;
    }
    (up, mid, dn)
}

/// 摆动高/低点：vals[i] 为窗口 [i-k, i+k] 的严格最大/最小值。
/// 返回 (highs, lows) 的下标列表；pivot 在 i+k 根 bar 后才可确认。
fn pivots(vals: &[f64], k: usize) -> (Vec<usize>, Vec<usize>) {
    let n = vals.len();
    let (mut highs, mut lows) = (Vec::new(), Vec::new());
    for i in k..n.saturating_sub(k) {
        if !vals[i].is_finite() {
            continue;
        }
        let w = &vals[i - k..=i + k];
        if w.iter().any(|x| !x.is_finite()) {
            continue;
        }
        let is_high = w.iter().enumerate().all(|(j, &x)| j == k || x < vals[i]);
        let is_low = w.iter().enumerate().all(|(j, &x)| j == k || x > vals[i]);
        if is_high {
            highs.push(i);
        }
        if is_low {
            lows.push(i);
        }
    }
    (highs, lows)
}

/// 背离检测：相邻两个价格摆动点对比指标值。
/// 顶背离=价新高指标不新高（sell），底背离=价新低指标不新低（buy）。
/// 信号标在第二个 pivot 的确认 bar（pivot+k），避免"未来函数"式重绘。
/// 返回 (确认bar下标, side, 规则名)。
fn divergences(
    close: &[f64],
    ind: &[f64],
    k: usize,
    max_gap: usize,
    name: &str,
) -> Vec<(usize, &'static str, String)> {
    let n = close.len();
    let (highs, lows) = pivots(close, k);
    let mut out = Vec::new();
    for w in highs.windows(2) {
        let (p1, p2) = (w[0], w[1]);
        if p2 - p1 > max_gap || !ind[p1].is_finite() || !ind[p2].is_finite() {
            continue;
        }
        if close[p2] > close[p1] && ind[p2] < ind[p1] && p2 + k < n {
            out.push((p2 + k, "sell", format!("{name}顶背离")));
        }
    }
    for w in lows.windows(2) {
        let (p1, p2) = (w[0], w[1]);
        if p2 - p1 > max_gap || !ind[p1].is_finite() || !ind[p2].is_finite() {
            continue;
        }
        if close[p2] < close[p1] && ind[p2] > ind[p1] && p2 + k < n {
            out.push((p2 + k, "buy", format!("{name}底背离")));
        }
    }
    out
}

/// 神奇九转（TD Setup）：连续 9 根 close < close[4]（九买，跌势衰竭）/
/// close > close[4]（九卖，涨势衰竭）。返回 (第9根下标, side)。
fn td9(close: &[f64]) -> Vec<(usize, &'static str)> {
    let mut out = Vec::new();
    let (mut buy_cnt, mut sell_cnt) = (0u32, 0u32);
    for i in 4..close.len() {
        if close[i] < close[i - 4] {
            buy_cnt += 1;
            sell_cnt = 0;
        } else if close[i] > close[i - 4] {
            sell_cnt += 1;
            buy_cnt = 0;
        } else {
            buy_cnt = 0;
            sell_cnt = 0;
        }
        if buy_cnt == 9 {
            out.push((i, "buy"));
            buy_cnt = 0;
        }
        if sell_cnt == 9 {
            out.push((i, "sell"));
            sell_cnt = 0;
        }
    }
    out
}

/// 批次5：SuperTrend(n, mult)。返回 (多头段线, 空头段线, 翻转点列表)。
/// Wilder ATR + 带钳制的上下轨，价格穿越触发方向翻转。
fn supertrend(klines: &[Kline], n: usize, mult: f64) -> (Vec<f64>, Vec<f64>, Vec<(usize, &'static str)>) {
    let len = klines.len();
    let mut st_up = vec![f64::NAN; len];
    let mut st_dn = vec![f64::NAN; len];
    let mut flips = Vec::new();
    if len <= n + 1 {
        return (st_up, st_dn, flips);
    }
    // Wilder ATR
    let mut atr = vec![f64::NAN; len];
    let tr = |i: usize| -> f64 {
        let k = &klines[i];
        let pc = klines[i - 1].close;
        (k.high - k.low).max((k.high - pc).abs()).max((k.low - pc).abs())
    };
    let mut sum = 0.0;
    for i in 1..=n {
        sum += tr(i);
    }
    atr[n] = sum / n as f64;
    for i in n + 1..len {
        atr[i] = (atr[i - 1] * (n as f64 - 1.0) + tr(i)) / n as f64;
    }
    // 带钳制的轨道 + 方向
    let (mut upper, mut lower) = (f64::NAN, f64::NAN);
    let mut dir: i8 = 0;
    for i in n..len {
        let hl2 = (klines[i].high + klines[i].low) / 2.0;
        let ub = hl2 + mult * atr[i];
        let lb = hl2 - mult * atr[i];
        let c_prev = klines[i - 1].close;
        upper = if !upper.is_finite() || ub < upper || c_prev > upper { ub } else { upper };
        lower = if !lower.is_finite() || lb > lower || c_prev < lower { lb } else { lower };
        let prev_dir = dir;
        let c = klines[i].close;
        dir = match prev_dir {
            1 => {
                if c < lower {
                    -1
                } else {
                    1
                }
            }
            -1 => {
                if c > upper {
                    1
                } else {
                    -1
                }
            }
            _ => {
                if c > upper {
                    1
                } else {
                    -1
                }
            }
        };
        if prev_dir != 0 && dir != prev_dir {
            flips.push((i, if dir == 1 { "buy" } else { "sell" }));
            // 翻转后轨道重置为本根基础值，教科书口径
            if dir == 1 {
                lower = lb;
            } else {
                upper = ub;
            }
        }
        if dir == 1 {
            st_up[i] = lower;
        } else {
            st_dn[i] = upper;
        }
    }
    (st_up, st_dn, flips)
}

/// ADX(n)，Wilder 平滑。
fn adx(klines: &[Kline], n: usize) -> Vec<f64> {
    let len = klines.len();
    let mut out = vec![f64::NAN; len];
    if len <= 2 * n {
        return out;
    }
    let (mut s_tr, mut s_pdm, mut s_ndm) = (0.0, 0.0, 0.0);
    let mut dx = vec![f64::NAN; len];
    for i in 1..len {
        let k = &klines[i];
        let p = &klines[i - 1];
        let tr = (k.high - k.low).max((k.high - p.close).abs()).max((k.low - p.close).abs());
        let up = k.high - p.high;
        let dn = p.low - k.low;
        let pdm = if up > dn && up > 0.0 { up } else { 0.0 };
        let ndm = if dn > up && dn > 0.0 { dn } else { 0.0 };
        if i <= n {
            s_tr += tr;
            s_pdm += pdm;
            s_ndm += ndm;
        } else {
            s_tr = s_tr - s_tr / n as f64 + tr;
            s_pdm = s_pdm - s_pdm / n as f64 + pdm;
            s_ndm = s_ndm - s_ndm / n as f64 + ndm;
        }
        if i >= n && s_tr > 0.0 {
            let pdi = 100.0 * s_pdm / s_tr;
            let ndi = 100.0 * s_ndm / s_tr;
            if pdi + ndi > 0.0 {
                dx[i] = 100.0 * (pdi - ndi).abs() / (pdi + ndi);
            }
        }
    }
    // ADX = DX 的 Wilder 平滑
    let mut sum = 0.0;
    for i in n..2 * n {
        sum += dx[i];
    }
    out[2 * n - 1] = sum / n as f64;
    for i in 2 * n..len {
        out[i] = (out[i - 1] * (n as f64 - 1.0) + dx[i]) / n as f64;
    }
    out
}

/// 批次4：结构形态（双顶/双底、头肩顶/底）。基于收盘价摆动点，
/// 信号标在颈线破位那根 bar——结构完成才确认，不重绘。
fn structure_patterns(c: &[f64], k: usize) -> Vec<(usize, &'static str, String)> {
    let n = c.len();
    let (highs, lows) = pivots(c, k);
    let mut out: Vec<(usize, &'static str, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |out: &mut Vec<(usize, &'static str, String)>, j: usize, side: &'static str, rule: &str| {
        if seen.insert((j, rule.to_string())) {
            out.push((j, side, rule.to_string()));
        }
    };

    // 双顶：相邻两个摆动高点等高（±2%），中间有≥0.5%回撤；破颈线（中间最低点）确认
    for w in highs.windows(2) {
        let (p1, p2) = (w[0], w[1]);
        if p2 - p1 < 5 || p2 - p1 > 60 {
            continue;
        }
        let avg = (c[p1] + c[p2]) / 2.0;
        if (c[p1] - c[p2]).abs() / avg > 0.02 {
            continue;
        }
        let neck = c[p1..=p2].iter().cloned().fold(f64::MAX, f64::min);
        if neck >= avg * 0.995 {
            continue;
        }
        for j in p2 + k..(p2 + 40).min(n) {
            if c[j] < neck {
                push(&mut out, j, "sell", "双顶颈线破位");
                break;
            }
            if c[j] > avg * 1.02 {
                break; // 价格越过双顶，形态失效
            }
        }
    }
    // 双底（W底）：镜像
    for w in lows.windows(2) {
        let (p1, p2) = (w[0], w[1]);
        if p2 - p1 < 5 || p2 - p1 > 60 {
            continue;
        }
        let avg = (c[p1] + c[p2]) / 2.0;
        if (c[p1] - c[p2]).abs() / avg > 0.02 {
            continue;
        }
        let neck = c[p1..=p2].iter().cloned().fold(f64::MIN, f64::max);
        if neck <= avg * 1.005 {
            continue;
        }
        for j in p2 + k..(p2 + 40).min(n) {
            if c[j] > neck {
                push(&mut out, j, "buy", "双底颈线突破");
                break;
            }
            if c[j] < avg * 0.98 {
                break;
            }
        }
    }
    // 头肩顶：三个摆动高点，头比双肩高≥1.5%，双肩等高（±3%）；破两谷较低者确认
    for w in highs.windows(3) {
        let (s1, hd, s2) = (w[0], w[1], w[2]);
        if s2 - s1 > 120 {
            continue;
        }
        let sh_avg = (c[s1] + c[s2]) / 2.0;
        if c[hd] < c[s1] * 1.015 || c[hd] < c[s2] * 1.015 || (c[s1] - c[s2]).abs() / sh_avg > 0.03 {
            continue;
        }
        let neck = c[s1..=s2]
            .iter()
            .cloned()
            .fold(f64::MAX, f64::min);
        for j in s2 + k..(s2 + 40).min(n) {
            if c[j] < neck {
                push(&mut out, j, "sell", "头肩顶破位");
                break;
            }
            if c[j] > c[hd] {
                break;
            }
        }
    }
    // 头肩底：镜像
    for w in lows.windows(3) {
        let (s1, hd, s2) = (w[0], w[1], w[2]);
        if s2 - s1 > 120 {
            continue;
        }
        let sh_avg = (c[s1] + c[s2]) / 2.0;
        if c[hd] > c[s1] * 0.985 || c[hd] > c[s2] * 0.985 || (c[s1] - c[s2]).abs() / sh_avg > 0.03 {
            continue;
        }
        let neck = c[s1..=s2].iter().cloned().fold(f64::MIN, f64::max);
        for j in s2 + k..(s2 + 40).min(n) {
            if c[j] > neck {
                push(&mut out, j, "buy", "头肩底突破");
                break;
            }
            if c[j] < c[hd] {
                break;
            }
        }
    }
    out
}

/// 批次3：K线形态族。反转形态要求趋势背景（昨收 vs MA20）才标注，教科书口径。
/// 返回 (bar下标, side, 规则名)。
fn candle_patterns(klines: &[Kline], ma20: &[f64]) -> Vec<(usize, &'static str, String)> {
    let n = klines.len();
    let mut out = Vec::new();
    let body = |k: &Kline| (k.close - k.open).abs();
    let range = |k: &Kline| (k.high - k.low).max(1e-12);
    let upper = |k: &Kline| k.high - k.close.max(k.open);
    let lower = |k: &Kline| k.close.min(k.open) - k.low;
    let bull = |k: &Kline| k.close > k.open;
    let bear = |k: &Kline| k.close < k.open;

    for i in 6..n {
        if !ma20[i - 1].is_finite() {
            continue;
        }
        let (k0, k1, k2) = (&klines[i], &klines[i - 1], &klines[i - 2]);
        // 趋势背景：昨收相对 MA20
        let down_ctx = k1.close < ma20[i - 1];
        let up_ctx = k1.close > ma20[i - 1];

        // 吞没形态：实体包住前一根实体，且方向反转
        if bear(k1) && bull(k0) && k0.open <= k1.close && k0.close >= k1.open && down_ctx {
            out.push((i, "buy", "看涨吞没".to_string()));
        } else if bull(k1) && bear(k0) && k0.open >= k1.close && k0.close <= k1.open && up_ctx {
            out.push((i, "sell", "看跌吞没".to_string()));
        }

        // 锤子/上吊：长下影≥2×实体，上影很短，实体占比小
        let hammer_shape =
            lower(k0) >= 2.0 * body(k0) && upper(k0) <= 0.3 * body(k0).max(1e-12) && body(k0) <= 0.35 * range(k0);
        if hammer_shape && down_ctx {
            out.push((i, "buy", "锤子线".to_string()));
        } else if hammer_shape && up_ctx {
            out.push((i, "sell", "上吊线".to_string()));
        }
        // 流星/倒锤：长上影≥2×实体，下影很短
        let star_shape =
            upper(k0) >= 2.0 * body(k0) && lower(k0) <= 0.3 * body(k0).max(1e-12) && body(k0) <= 0.35 * range(k0);
        if star_shape && up_ctx {
            out.push((i, "sell", "流星线".to_string()));
        } else if star_shape && down_ctx {
            out.push((i, "buy", "倒锤线".to_string()));
        }

        // 启明星/黄昏星（三根）：大实体 → 小实体 → 反向大实体收复过半
        let small_mid = body(k1) < 0.3 * body(k2).max(1e-12);
        if bear(k2) && small_mid && bull(k0) && k0.close > (k2.open + k2.close) / 2.0 && down_ctx {
            out.push((i, "buy", "启明星".to_string()));
        } else if bull(k2) && small_mid && bear(k0) && k0.close < (k2.open + k2.close) / 2.0 && up_ctx {
            out.push((i, "sell", "黄昏星".to_string()));
        }

        // 红三兵/三只乌鸦：连续三根同向、收盘递进、实体占比≥50%
        let solid = |k: &Kline| body(k) >= 0.5 * range(k);
        if bull(k0) && bull(k1) && bull(k2)
            && k0.close > k1.close && k1.close > k2.close
            && solid(k0) && solid(k1) && solid(k2) && down_ctx
        {
            out.push((i, "buy", "红三兵".to_string()));
        } else if bear(k0) && bear(k1) && bear(k2)
            && k0.close < k1.close && k1.close < k2.close
            && solid(k0) && solid(k1) && solid(k2) && up_ctx
        {
            out.push((i, "sell", "三只乌鸦".to_string()));
        }

        // 趋势末端十字星：实体≤10%振幅，且前5根累计涨跌超3%（变盘警示）
        let ret5 = k1.close / klines[i - 6].close - 1.0;
        if body(k0) <= 0.1 * range(k0) && ret5.abs() > 0.03 {
            if ret5 > 0.0 {
                out.push((i, "sell", "高位十字星".to_string()));
            } else {
                out.push((i, "buy", "低位十字星".to_string()));
            }
        }
    }
    out
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
    let (boll_up, boll_mid, boll_dn) = bollinger_bands(klines, 20);
    let (dif, dea, hist) = qfactors::macd_full(klines, 12, 26, 9);
    let rsi14 = qfactors::rsi(klines, 14);
    let (kdj_k, kdj_d, kdj_j) = qfactors::kdj(klines, 9, 3, 3);

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

    // 批次1新增：神奇九转 + MACD/RSI 背离，先按 bar 下标归桶再并入逐 bar 聚合
    let mut extra_buy: std::collections::HashMap<usize, Vec<String>> = Default::default();
    let mut extra_sell: std::collections::HashMap<usize, Vec<String>> = Default::default();
    for (i, side) in td9(&c) {
        let (map, rule) = if side == "buy" {
            (&mut extra_buy, "神奇九转·九买")
        } else {
            (&mut extra_sell, "神奇九转·九卖")
        };
        map.entry(i).or_default().push(rule.to_string());
    }
    // k=4：pivot 两侧各4根确认；max_gap=60：背离的两个摆动点最多隔60根
    let mut divs = divergences(&c, &dif, 4, 60, "MACD");
    divs.extend(divergences(&c, &rsi14, 4, 60, "RSI"));
    divs.extend(candle_patterns(klines, &ma20));
    divs.extend(structure_patterns(&c, 4));
    let (st_up, st_dn, st_flips) = supertrend(klines, 10, 3.0);
    let adx14 = adx(klines, 14);
    for (i, side) in st_flips {
        let (map, rule) = if side == "buy" {
            (&mut extra_buy, "SuperTrend翻多")
        } else {
            (&mut extra_sell, "SuperTrend翻空")
        };
        map.entry(i).or_default().push(rule.to_string());
    }
    for (i, side, rule) in divs {
        let map = if side == "buy" { &mut extra_buy } else { &mut extra_sell };
        map.entry(i).or_default().push(rule);
    }

    // 批次2：唐奇安通道（前20日高低，不含当根）+ 20日均量，给突破类规则用
    let h: Vec<f64> = klines.iter().map(|k| k.high).collect();
    let l: Vec<f64> = klines.iter().map(|k| k.low).collect();
    let vol: Vec<f64> = klines.iter().map(|k| k.volume).collect();
    const DONCH: usize = 20;
    let mut donch_up = vec![f64::NAN; n];
    let mut donch_dn = vec![f64::NAN; n];
    let mut vol_ma = vec![f64::NAN; n];
    for i in DONCH..n {
        donch_up[i] = h[i - DONCH..i].iter().cloned().fold(f64::MIN, f64::max);
        donch_dn[i] = l[i - DONCH..i].iter().cloned().fold(f64::MAX, f64::min);
        vol_ma[i] = qfactors::mean(&vol[i - DONCH..i]);
    }
    // 多头/空头排列：三均线齐序
    let aligned = |i: usize| -> i8 {
        if !ma20[i].is_finite() || !ma50[i].is_finite() || !ma200[i].is_finite() {
            0
        } else if ma20[i] > ma50[i] && ma50[i] > ma200[i] {
            1
        } else if ma20[i] < ma50[i] && ma50[i] < ma200[i] {
            -1
        } else {
            0
        }
    };

    // 经典规则信号：逐 bar 收集命中规则，按 buy/sell 各聚合为一个信号
    let mut classic_signals = Vec::new();
    // 唐奇安冷却：趋势内连续新高会反复触发，同向 10 根 bar 内只标第一次
    let (mut donch_buy_at, mut donch_sell_at) = (isize::MIN / 2, isize::MIN / 2);
    for i in 1..n {
        let mut buys: Vec<String> = Vec::new();
        let mut sells: Vec<String> = Vec::new();

        // 均线金叉/死叉（MA20×MA50）
        if ma20[i - 1].is_finite() && ma50[i - 1].is_finite() && ma20[i].is_finite() && ma50[i].is_finite() {
            if ma20[i - 1] <= ma50[i - 1] && ma20[i] > ma50[i] {
                buys.push("均线金叉(20/50)".into());
            } else if ma20[i - 1] >= ma50[i - 1] && ma20[i] < ma50[i] {
                sells.push("均线死叉(20/50)".into());
            }
        }
        // 多头/空头排列成立（状态翻转点才标，避免趋势中连续刷屏）
        match (aligned(i - 1), aligned(i)) {
            (a, 1) if a != 1 => buys.push("多头排列成立".into()),
            (a, -1) if a != -1 => sells.push("空头排列成立".into()),
            _ => {}
        }
        // 唐奇安20日突破（海龟入场口径；只标穿越那根）
        if donch_up[i].is_finite() && donch_up[i - 1].is_finite() {
            if c[i] > donch_up[i] && c[i - 1] <= donch_up[i - 1] && i as isize - donch_buy_at >= 10 {
                donch_buy_at = i as isize;
                if vol[i] > 2.0 * vol_ma[i] {
                    buys.push("放量突破20日高".into());
                } else {
                    buys.push("唐奇安20日上破".into());
                }
            } else if c[i] < donch_dn[i] && c[i - 1] >= donch_dn[i - 1] && i as isize - donch_sell_at >= 10 {
                donch_sell_at = i as isize;
                if vol[i] > 2.0 * vol_ma[i] {
                    sells.push("放量跌破20日低".into());
                } else {
                    sells.push("唐奇安20日下破".into());
                }
            }
        }

        // MACD 柱穿零轴
        if hist[i - 1].is_finite() && hist[i].is_finite() {
            if hist[i - 1] <= 0.0 && hist[i] > 0.0 {
                buys.push("MACD金叉".into());
            } else if hist[i - 1] >= 0.0 && hist[i] < 0.0 {
                sells.push("MACD死叉".into());
            }
        }
        // RSI 超卖回升 / 超买回落
        if rsi14[i - 1].is_finite() && rsi14[i].is_finite() {
            if rsi14[i - 1] < 30.0 && rsi14[i] >= 30.0 {
                buys.push("RSI超卖回升".into());
            } else if rsi14[i - 1] > 70.0 && rsi14[i] <= 70.0 {
                sells.push("RSI超买回落".into());
            }
        }
        // 布林触轨后收回
        if boll_dn[i - 1].is_finite() && boll_dn[i].is_finite() {
            if c[i - 1] < boll_dn[i - 1] && c[i] >= boll_dn[i] {
                buys.push("布林下轨收回".into());
            } else if c[i - 1] > boll_up[i - 1] && c[i] <= boll_up[i] {
                sells.push("布林上轨回落".into());
            }
        }
        // KDJ 低位金叉 / 高位死叉
        if kdj_k[i - 1].is_finite() && kdj_d[i - 1].is_finite() && kdj_k[i].is_finite() {
            let crossed_up = kdj_k[i - 1] <= kdj_d[i - 1] && kdj_k[i] > kdj_d[i];
            let crossed_dn = kdj_k[i - 1] >= kdj_d[i - 1] && kdj_k[i] < kdj_d[i];
            if crossed_up && kdj_d[i] < 30.0 {
                buys.push("KDJ低位金叉".into());
            } else if crossed_dn && kdj_d[i] > 70.0 {
                sells.push("KDJ高位死叉".into());
            }
        }

        if let Some(extra) = extra_buy.remove(&i) {
            buys.extend(extra);
        }
        if let Some(extra) = extra_sell.remove(&i) {
            sells.extend(extra);
        }

        if !buys.is_empty() {
            classic_signals.push(TaSignal {
                time: times[i],
                side: "buy",
                strength: buys.len(),
                rules: buys,
                price: c[i],
            });
        }
        if !sells.is_empty() {
            classic_signals.push(TaSignal {
                time: times[i],
                side: "sell",
                strength: sells.len(),
                rules: sells,
                price: c[i],
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
        // 14 根单调下跌：close[i] < close[i-4] 从 i=4 起连续成立，第 12 根（i=12）是第 9 计数
        let closes: Vec<f64> = (0..20).map(|i| 100.0 - i as f64).collect();
        let hits = td9(&closes);
        assert_eq!(hits.first(), Some(&(12, "buy")));
        // 单调上涨给出九卖
        let closes_up: Vec<f64> = (0..20).map(|i| 100.0 + i as f64).collect();
        assert_eq!(td9(&closes_up).first(), Some(&(12, "sell")));
    }

    #[test]
    fn divergence_detects_lower_indicator_high() {
        // 价格两个高点 110 → 115（创新高），指标对应 50 → 30（不创新高）→ 顶背离
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
        // 30 根横盘后跳涨：突破前20日高点的那根应给出唐奇安上破买点
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
        // 30 根阴线下行（昨收 < MA20 的下跌背景），随后一根阳线吞没前实体
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
        // 110 双顶（间隔10根）+ 中间回撤到100，跌破100 时应给出双顶卖点
        let mut c: Vec<f64> = (0..10).map(|i| 90.0 + 2.0 * i as f64).collect();
        c.push(110.0); // 顶1 @10
        c.extend([108.0, 106.0, 104.0, 102.0]);
        c.push(100.0); // 颈线 @15
        c.extend([102.0, 104.0, 106.0, 108.0]);
        c.push(110.3); // 顶2 @20
        c.extend([108.0, 105.0, 102.0, 99.0, 98.0]); // @24 跌破颈线
        let hits = structure_patterns(&c, 4);
        assert!(
            hits.iter().any(|(j, side, r)| *j == 24 && *side == "sell" && r == "双顶颈线破位"),
            "got {hits:?}"
        );
    }

    #[test]
    fn supertrend_flips_on_v_shape() {
        // 先跌后涨的 V 形：SuperTrend 应先空后翻多，且两列不同时有值
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
        // 单边上涨的 tsmom 至少有一次建多
        assert!(r.champion_signals.iter().any(|s| s.side == "buy"));
    }
}
