//! 经典技术规则引擎（36条·六大类）：供图表标注、规则统计、仓位调制、
//! RuleVote 策略家族共用。所有函数只依赖 OHLCV，无前视。
//!
//! 注意：规则是教科书口径，统计验证见 server ta_stats；
//! 作为策略使用必须过 evolve 闸门。

use crate::*;
use qcore::Kline;

/// 单条规则命中：bar下标 + 方向（1买/-1卖）+ 规则名
#[derive(Debug, Clone)]
pub struct RuleHit {
    pub idx: usize,
    pub side: i8,
    pub rule: String,
}

/// 布林带 (n, 2σ)：返回 (上轨, 中轨, 下轨)。
pub fn bollinger_bands(klines: &[Kline], n: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let c: Vec<f64> = klines.iter().map(|k| k.close).collect();
    let len = c.len();
    let (mut up, mut mid, mut dn) = (
        vec![f64::NAN; len],
        vec![f64::NAN; len],
        vec![f64::NAN; len],
    );
    for i in n..len {
        let w = &c[i + 1 - n..=i];
        let m = crate::mean(w);
        let s = crate::std_dev(w);
        mid[i] = m;
        up[i] = m + 2.0 * s;
        dn[i] = m - 2.0 * s;
    }
    (up, mid, dn)
}

/// 摆动高/低点：vals[i] 为窗口 [i-k, i+k] 的严格最大/最小值。
/// 返回 (highs, lows) 的下标列表；pivot 在 i+k 根 bar 后才可确认。
pub fn pivots(vals: &[f64], k: usize) -> (Vec<usize>, Vec<usize>) {
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
pub fn divergences(
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
pub fn td9(close: &[f64]) -> Vec<(usize, &'static str)> {
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
pub fn supertrend(klines: &[Kline], n: usize, mult: f64) -> (Vec<f64>, Vec<f64>, Vec<(usize, &'static str)>) {
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
pub fn adx(klines: &[Kline], n: usize) -> Vec<f64> {
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
pub fn structure_patterns(c: &[f64], k: usize) -> Vec<(usize, &'static str, String)> {
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
pub fn candle_patterns(klines: &[Kline], ma20: &[f64]) -> Vec<(usize, &'static str, String)> {
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

/// 全部 36 条经典规则的事件流（按 bar 下标升序）。
pub fn classic_rule_events(klines: &[Kline]) -> Vec<RuleHit> {
    let n = klines.len();
    let mut hits: Vec<RuleHit> = Vec::new();
    if n < 30 {
        return hits;
    }
    let c: Vec<f64> = klines.iter().map(|k| k.close).collect();
    let h: Vec<f64> = klines.iter().map(|k| k.high).collect();
    let l: Vec<f64> = klines.iter().map(|k| k.low).collect();
    let vol: Vec<f64> = klines.iter().map(|k| k.volume).collect();

    let ma20 = crate::sma(klines, 20);
    let ma50 = crate::sma(klines, 50);
    let ma200 = crate::sma(klines, 200);
    let (boll_up, _boll_mid, boll_dn) = bollinger_bands(klines, 20);
    let (dif, _dea, hist) = crate::macd_full(klines, 12, 26, 9);
    let rsi14 = crate::rsi(klines, 14);
    let (kdj_k, kdj_d, _kdj_j) = crate::kdj(klines, 9, 3, 3);

    let mut push = |idx: usize, side: i8, rule: &str| {
        hits.push(RuleHit { idx, side, rule: rule.to_string() });
    };

    // 计数/背离/形态/结构/趋势翻转族
    for (i, side) in td9(&c) {
        push(i, if side == "buy" { 1 } else { -1 }, if side == "buy" { "神奇九转·九买" } else { "神奇九转·九卖" });
    }
    let mut divs = divergences(&c, &dif, 4, 60, "MACD");
    divs.extend(divergences(&c, &rsi14, 4, 60, "RSI"));
    divs.extend(candle_patterns(klines, &ma20));
    divs.extend(structure_patterns(&c, 4));
    for (i, side, rule) in divs {
        push(i, if side == "buy" { 1 } else { -1 }, &rule);
    }
    let (_st_up, _st_dn, st_flips) = supertrend(klines, 10, 3.0);
    for (i, side) in st_flips {
        push(i, if side == "buy" { 1 } else { -1 }, if side == "buy" { "SuperTrend翻多" } else { "SuperTrend翻空" });
    }

    // 唐奇安通道 + 均量
    const DONCH: usize = 20;
    let mut donch_up = vec![f64::NAN; n];
    let mut donch_dn = vec![f64::NAN; n];
    let mut vol_ma = vec![f64::NAN; n];
    for i in DONCH..n {
        donch_up[i] = h[i - DONCH..i].iter().cloned().fold(f64::MIN, f64::max);
        donch_dn[i] = l[i - DONCH..i].iter().cloned().fold(f64::MAX, f64::min);
        vol_ma[i] = crate::mean(&vol[i - DONCH..i]);
    }
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

    let (mut donch_buy_at, mut donch_sell_at) = (isize::MIN / 2, isize::MIN / 2);
    for i in 1..n {
        if hist[i - 1].is_finite() && hist[i].is_finite() {
            if hist[i - 1] <= 0.0 && hist[i] > 0.0 {
                push(i, 1, "MACD金叉");
            } else if hist[i - 1] >= 0.0 && hist[i] < 0.0 {
                push(i, -1, "MACD死叉");
            }
        }
        if rsi14[i - 1].is_finite() && rsi14[i].is_finite() {
            if rsi14[i - 1] < 30.0 && rsi14[i] >= 30.0 {
                push(i, 1, "RSI超卖回升");
            } else if rsi14[i - 1] > 70.0 && rsi14[i] <= 70.0 {
                push(i, -1, "RSI超买回落");
            }
        }
        if boll_dn[i - 1].is_finite() && boll_dn[i].is_finite() {
            if c[i - 1] < boll_dn[i - 1] && c[i] >= boll_dn[i] {
                push(i, 1, "布林下轨收回");
            } else if c[i - 1] > boll_up[i - 1] && c[i] <= boll_up[i] {
                push(i, -1, "布林上轨回落");
            }
        }
        if kdj_k[i - 1].is_finite() && kdj_d[i - 1].is_finite() && kdj_k[i].is_finite() {
            let crossed_up = kdj_k[i - 1] <= kdj_d[i - 1] && kdj_k[i] > kdj_d[i];
            let crossed_dn = kdj_k[i - 1] >= kdj_d[i - 1] && kdj_k[i] < kdj_d[i];
            if crossed_up && kdj_d[i] < 30.0 {
                push(i, 1, "KDJ低位金叉");
            } else if crossed_dn && kdj_d[i] > 70.0 {
                push(i, -1, "KDJ高位死叉");
            }
        }
        if ma20[i - 1].is_finite() && ma50[i - 1].is_finite() && ma20[i].is_finite() && ma50[i].is_finite() {
            if ma20[i - 1] <= ma50[i - 1] && ma20[i] > ma50[i] {
                push(i, 1, "均线金叉(20/50)");
            } else if ma20[i - 1] >= ma50[i - 1] && ma20[i] < ma50[i] {
                push(i, -1, "均线死叉(20/50)");
            }
        }
        match (aligned(i - 1), aligned(i)) {
            (a, 1) if a != 1 => push(i, 1, "多头排列成立"),
            (a, -1) if a != -1 => push(i, -1, "空头排列成立"),
            _ => {}
        }
        if donch_up[i].is_finite() && donch_up[i - 1].is_finite() {
            if c[i] > donch_up[i] && c[i - 1] <= donch_up[i - 1] && i as isize - donch_buy_at >= 10 {
                donch_buy_at = i as isize;
                push(i, 1, if vol[i] > 2.0 * vol_ma[i] { "放量突破20日高" } else { "唐奇安20日上破" });
            } else if c[i] < donch_dn[i] && c[i - 1] >= donch_dn[i - 1] && i as isize - donch_sell_at >= 10 {
                donch_sell_at = i as isize;
                push(i, -1, if vol[i] > 2.0 * vol_ma[i] { "放量跌破20日低" } else { "唐奇安20日下破" });
            }
        }
    }
    hits.sort_by_key(|x| x.idx);
    hits
}
