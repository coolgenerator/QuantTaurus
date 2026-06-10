//! 共享核心类型：K线、行情事件、信号、订单、绩效指标。

use serde::{Deserialize, Serialize};

/// 一根K线（蜡烛）。时间戳为毫秒 UTC，开盘时刻。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Kline {
    pub open_time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    /// 主动买入成交量（taker buy base volume），用于订单流不平衡因子
    pub taker_buy_volume: f64,
    pub trades: u64,
}

impl Kline {
    /// 典型价 (H+L+C)/3
    pub fn typical(&self) -> f64 {
        (self.high + self.low + self.close) / 3.0
    }
    /// 对数收益（相对上一根收盘）
    pub fn log_ret(prev_close: f64, close: f64) -> f64 {
        (close / prev_close).ln()
    }
}

/// K线周期
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Interval {
    M1,
    M5,
    M15,
    M30,
    H1,
    H2,
    H4,
    D1,
    W1,
    Mon1,
}

impl Interval {
    pub fn as_binance(&self) -> &'static str {
        match self {
            Interval::M1 => "1m",
            Interval::M5 => "5m",
            Interval::M15 => "15m",
            Interval::M30 => "30m",
            Interval::H1 => "1h",
            Interval::H2 => "2h",
            Interval::H4 => "4h",
            Interval::D1 => "1d",
            Interval::W1 => "1w",
            Interval::Mon1 => "1M",
        }
    }
    pub fn millis(&self) -> i64 {
        match self {
            Interval::M1 => 60_000,
            Interval::M5 => 300_000,
            Interval::M15 => 900_000,
            Interval::M30 => 1_800_000,
            Interval::H1 => 3_600_000,
            Interval::H2 => 7_200_000,
            Interval::H4 => 14_400_000,
            Interval::D1 => 86_400_000,
            Interval::W1 => 7 * 86_400_000,
            // 月线无固定长度，取30天近似（仅用于缓存步长/年化推算）
            Interval::Mon1 => 30 * 86_400_000,
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "1m" => Some(Interval::M1),
            "5m" => Some(Interval::M5),
            "15m" => Some(Interval::M15),
            "30m" => Some(Interval::M30),
            "1h" => Some(Interval::H1),
            "2h" => Some(Interval::H2),
            "4h" => Some(Interval::H4),
            "1d" => Some(Interval::D1),
            "1w" | "1wk" => Some(Interval::W1),
            "1M" | "1mo" | "1mon" => Some(Interval::Mon1),
            _ => None,
        }
    }
}

/// 目标仓位信号：[-1, 1]，-1 全仓做空，0 空仓，1 全仓做多。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Signal {
    pub time: i64,
    pub target_position: f64,
}

/// 实时行情事件（WS 推送）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MarketEvent {
    Kline {
        symbol: String,
        interval: String,
        kline: Kline,
        closed: bool,
    },
    Trade {
        symbol: String,
        time: i64,
        price: f64,
        qty: f64,
        is_buyer_maker: bool,
    },
}

/// 回测绩效指标
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metrics {
    pub total_return: f64,
    pub annual_return: f64,
    pub annual_vol: f64,
    pub sharpe: f64,
    pub sortino: f64,
    pub max_drawdown: f64,
    pub calmar: f64,
    pub win_rate: f64,
    pub num_trades: u64,
    /// Bailey & López de Prado (2014) 校正多重测试后的 Sharpe 显著性概率
    pub deflated_sharpe_prob: f64,
    /// bar级方向命中率：持仓bar中策略收益>0的占比（预测准确度）
    #[serde(default)]
    pub hit_rate: f64,
    /// 盈亏比：毛利合计 / 毛损合计
    #[serde(default)]
    pub profit_factor: f64,
}

/// 一次回测的资金曲线点
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct EquityPoint {
    pub time: i64,
    pub equity: f64,
    pub position: f64,
    pub price: f64,
}
