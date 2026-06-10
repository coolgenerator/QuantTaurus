//! 板块分析 + 热点轮动模块。
//!
//! 方法论（横截面动量/板块轮动文献：Jegadeesh & Titman 1993;
//! Moskowitz & Grinblatt 1999 行业动量）：
//! - 每板块取成分股等权：1m/3m/6m 动量、相对 SPY 强弱、广度（>50DMA 占比）
//! - 动量加速度 = 1m 年化动量 − 6m 年化动量（轮动早期信号：短期开始跑赢自身长期）
//! - 热点分 = z(相对3m动量) + z(加速度) + z(广度)
//! - 标签：leader（强且持续）/ emerging（加速轮入，潜在下一热点）/
//!   neutral / laggard（弱且仍在减速）
//!
//! 注意：这是动量轮动的统计信号，不是基本面预言。

use crate::state::{now_ms, AppState};
use qcore::{Interval, Kline};
use serde::Serialize;
use std::sync::Arc;

pub struct SectorDef {
    pub key: &'static str,
    pub name_zh: &'static str,
    pub tickers: &'static [&'static str],
}

/// 板块定义（均为美股上市标的）
pub const SECTORS: &[SectorDef] = &[
    SectorDef {
        key: "mega_tech",
        name_zh: "大型科技",
        tickers: &["AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA"],
    },
    SectorDef {
        key: "semis",
        name_zh: "半导体/芯片",
        tickers: &["NVDA", "AMD", "AVGO", "TSM", "INTC", "QCOM", "ARM", "MRVL"],
    },
    SectorDef {
        key: "memory_storage",
        name_zh: "内存/存储",
        tickers: &["MU", "WDC", "STX", "SNDK"],
    },
    SectorDef {
        key: "ai_infra",
        name_zh: "AI 基建/算力",
        tickers: &["SMCI", "DELL", "VRT", "ANET", "ORCL", "PLTR", "CRWV"],
    },
    SectorDef {
        key: "semi_equipment",
        name_zh: "半导体设备/供应链",
        tickers: &["ASML", "AMAT", "LRCX", "KLAC", "TER"],
    },
    SectorDef {
        key: "ai_power",
        name_zh: "AI 电力/数据中心能源",
        tickers: &["VST", "CEG", "GEV"],
    },
];

const BENCHMARK: &str = "SPY";
/// 板块分析结果内存缓存 TTL（避免每次请求都打 Yahoo）
pub const CACHE_TTL_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
pub struct TickerStat {
    pub symbol: String,
    pub last_close: f64,
    /// 21 交易日动量（对数收益）
    pub mom_1m: Option<f64>,
    pub mom_3m: Option<f64>,
    pub mom_6m: Option<f64>,
    pub above_ma50: Option<bool>,
    /// 20日年化波动
    pub vol_20d: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SectorStat {
    pub key: String,
    pub name_zh: String,
    pub tickers: Vec<TickerStat>,
    pub avg_mom_1m: f64,
    pub avg_mom_3m: f64,
    pub avg_mom_6m: f64,
    /// 相对基准的3m超额动量
    pub rel_3m: f64,
    /// 成分股中收盘价高于50日均线的占比
    pub breadth: f64,
    /// 动量加速度：1m年化 − 6m年化
    pub accel: f64,
    pub hotspot_score: f64,
    pub rank: usize,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SectorReport {
    pub as_of: i64,
    pub benchmark: TickerStat,
    pub sectors: Vec<SectorStat>,
    pub method_note: String,
}

fn log_mom(closes: &[f64], n: usize) -> Option<f64> {
    if closes.len() <= n {
        return None;
    }
    let last = *closes.last()?;
    let prev = closes[closes.len() - 1 - n];
    Some((last / prev).ln())
}

fn ticker_stat(symbol: &str, klines: &[Kline]) -> TickerStat {
    let closes: Vec<f64> = klines.iter().map(|k| k.close).collect();
    let last_close = closes.last().copied().unwrap_or(0.0);
    let ma50 = if closes.len() >= 50 {
        Some(closes[closes.len() - 50..].iter().sum::<f64>() / 50.0)
    } else {
        None
    };
    let vol_20d = if closes.len() >= 21 {
        let rets: Vec<f64> = closes[closes.len() - 21..]
            .windows(2)
            .map(|w| (w[1] / w[0]).ln())
            .collect();
        let m = rets.iter().sum::<f64>() / rets.len() as f64;
        let var = rets.iter().map(|r| (r - m).powi(2)).sum::<f64>() / (rets.len() as f64 - 1.0);
        Some(var.sqrt() * (252.0f64).sqrt())
    } else {
        None
    };
    TickerStat {
        symbol: symbol.to_string(),
        last_close,
        mom_1m: log_mom(&closes, 21),
        mom_3m: log_mom(&closes, 63),
        mom_6m: log_mom(&closes, 126),
        above_ma50: ma50.map(|m| last_close > m),
        vol_20d,
    }
}

fn mean_of(vals: impl Iterator<Item = Option<f64>>) -> f64 {
    let v: Vec<f64> = vals.flatten().collect();
    if v.is_empty() {
        0.0
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    }
}

pub async fn build_report(state: &Arc<AppState>) -> anyhow::Result<SectorReport> {
    let end = now_ms();
    let start = end - 420 * 86_400_000; // ~420 自然日 ≈ 280+ 交易日，够算 6m 动量

    let fetch = |sym: String| {
        let store = &state.store;
        async move {
            let klines = store.get(&sym, Interval::D1, start, end).await;
            (sym, klines)
        }
    };

    // 基准
    let (_, bench_klines) = fetch(BENCHMARK.to_string()).await;
    let bench_klines = bench_klines?;
    let benchmark = ticker_stat(BENCHMARK, &bench_klines);
    let bench_3m = benchmark.mom_3m.unwrap_or(0.0);

    // 各板块成分股（顺序拉取，缓存命中时近乎零成本）
    let mut sectors: Vec<SectorStat> = Vec::new();
    for def in SECTORS {
        let mut stats: Vec<TickerStat> = Vec::new();
        for &t in def.tickers {
            let (sym, klines) = fetch(t.to_string()).await;
            match klines {
                Ok(ks) if !ks.is_empty() => stats.push(ticker_stat(&sym, &ks)),
                Ok(_) => tracing::warn!(sym, "sector ticker: no data"),
                Err(e) => tracing::warn!(sym, error = %e, "sector ticker fetch failed"),
            }
        }
        let avg_1m = mean_of(stats.iter().map(|s| s.mom_1m));
        let avg_3m = mean_of(stats.iter().map(|s| s.mom_3m));
        let avg_6m = mean_of(stats.iter().map(|s| s.mom_6m));
        let breadth = {
            let known: Vec<bool> = stats.iter().filter_map(|s| s.above_ma50).collect();
            if known.is_empty() {
                0.0
            } else {
                known.iter().filter(|b| **b).count() as f64 / known.len() as f64
            }
        };
        // 年化口径对齐后再比较长短动量
        let accel = avg_1m * (252.0 / 21.0) - avg_6m * (252.0 / 126.0);
        sectors.push(SectorStat {
            key: def.key.to_string(),
            name_zh: def.name_zh.to_string(),
            tickers: stats,
            avg_mom_1m: avg_1m,
            avg_mom_3m: avg_3m,
            avg_mom_6m: avg_6m,
            rel_3m: avg_3m - bench_3m,
            breadth,
            accel,
            hotspot_score: 0.0,
            rank: 0,
            label: String::new(),
        });
    }

    // 横截面 z-score 合成热点分
    let z = |vals: &[f64]| -> Vec<f64> {
        let m = vals.iter().sum::<f64>() / vals.len() as f64;
        let sd = (vals.iter().map(|v| (v - m).powi(2)).sum::<f64>() / vals.len() as f64).sqrt();
        vals.iter()
            .map(|v| if sd > 1e-12 { (v - m) / sd } else { 0.0 })
            .collect()
    };
    let rel: Vec<f64> = sectors.iter().map(|s| s.rel_3m).collect();
    let acc: Vec<f64> = sectors.iter().map(|s| s.accel).collect();
    let brd: Vec<f64> = sectors.iter().map(|s| s.breadth).collect();
    let (zr, za, zb) = (z(&rel), z(&acc), z(&brd));
    for (i, s) in sectors.iter_mut().enumerate() {
        s.hotspot_score = zr[i] + za[i] + zb[i];
    }
    sectors.sort_by(|a, b| b.hotspot_score.partial_cmp(&a.hotspot_score).unwrap());
    let n = sectors.len();
    for (i, s) in sectors.iter_mut().enumerate() {
        s.rank = i + 1;
        s.label = match () {
            _ if s.rel_3m > 0.0 && s.accel > 0.0 => "leader",
            _ if s.accel > 0.0 && s.breadth >= 0.5 => "emerging", // 加速轮入：潜在下一热点
            _ if i >= n.saturating_sub(2) && s.accel < 0.0 => "laggard",
            _ => "neutral",
        }
        .to_string();
    }

    Ok(SectorReport {
        as_of: end,
        benchmark,
        sectors,
        method_note: "横截面动量轮动信号（相对强弱+加速度+广度的z分合成），\
                      参考 Moskowitz & Grinblatt (1999) 行业动量；非基本面预测"
            .to_string(),
    })
}
