//! Yahoo Finance 历史数据客户端（公开 chart API，免 key）。
//! 用于股票/ETF/指数：SPY、QQQ、^GSPC、^IXIC、AAPL …
//!
//! 与加密的差异：
//! - 无 taker buy volume → 置为 volume/2（订单流不平衡因子退化为中性 0）
//! - 仅交易时段有数据；周期支持 1d（数十年）、1h（最多 730 天）、
//!   15m/5m（60 天）、1m（7 天）

use anyhow::{Context, Result};
use qcore::{Interval, Kline};
use serde_json::Value;
use std::time::Duration;

const BASE: &str = "https://query1.finance.yahoo.com/v8/finance/chart";

pub struct YahooClient {
    http: reqwest::Client,
}

impl Default for YahooClient {
    fn default() -> Self {
        Self::new()
    }
}

/// 全局请求闸门：Yahoo 对突发请求限流（429）。44+ 槽位并发拉数据时
/// 必须串行化并保持最小间隔。
static GATE: std::sync::OnceLock<tokio::sync::Mutex<std::time::Instant>> =
    std::sync::OnceLock::new();

async fn throttle() {
    let gate = GATE.get_or_init(|| {
        tokio::sync::Mutex::new(std::time::Instant::now() - Duration::from_secs(1))
    });
    let mut last = gate.lock().await;
    let min_gap = Duration::from_millis(250);
    let elapsed = last.elapsed();
    if elapsed < min_gap {
        tokio::time::sleep(min_gap - elapsed).await;
    }
    *last = std::time::Instant::now();
}

impl YahooClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")
            .build()
            .expect("reqwest client");
        Self { http }
    }

    fn yahoo_interval(interval: Interval) -> &'static str {
        match interval {
            Interval::M1 => "1m",
            Interval::M5 => "5m",
            Interval::M15 => "15m",
            Interval::M30 => "30m",
            Interval::H1 => "60m",
            // Yahoo 无 2h/4h，调用方应避免；fetch_klines 直接拒绝
            Interval::H2 | Interval::H4 => "60m",
            Interval::D1 => "1d",
            Interval::W1 => "1wk",
            Interval::Mon1 => "1mo",
        }
    }

    /// Yahoo 对盘中粒度的历史深度限制（毫秒）；None = 无限制
    fn yahoo_range_limit_ms(interval: Interval) -> Option<i64> {
        match interval {
            Interval::M1 => Some(7 * 86_400_000),            // 1m 仅最近7天
            Interval::M5 | Interval::M15 | Interval::M30 => Some(59 * 86_400_000), // 60天
            Interval::H1 => Some(729 * 86_400_000),          // 60m 约2年
            _ => None,
        }
    }

    /// 拉取 [start_ms, end_ms) 的K线。Yahoo 一次可返回全区间，无需翻页。
    pub async fn fetch_klines(
        &self,
        symbol: &str,
        interval: Interval,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<Vec<Kline>> {
        anyhow::ensure!(
            interval != Interval::H4 && interval != Interval::H2,
            "yahoo finance does not support 2h/4h intervals, use 1h or 1d"
        );
        // 盘中粒度超出 Yahoo 历史深度会直接报错，这里钳制起点
        let start_ms = match Self::yahoo_range_limit_ms(interval) {
            Some(lim) => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64;
                start_ms.max(now - lim)
            }
            None => start_ms,
        };
        let url = format!(
            "{BASE}/{}?interval={}&period1={}&period2={}&events=history",
            urlencode(symbol),
            Self::yahoo_interval(interval),
            start_ms / 1000,
            end_ms / 1000,
        );
        throttle().await;
        let mut resp = self.http.get(&url).send().await.context("yahoo request")?;
        // 429 限流：退避2秒重试一次
        if resp.status().as_u16() == 429 {
            tokio::time::sleep(Duration::from_secs(2)).await;
            throttle().await;
            resp = self.http.get(&url).send().await.context("yahoo request")?;
        }
        let resp = resp.error_for_status().context("yahoo status (rate-limited?)")?;
        let v: Value = resp.json().await.context("yahoo json")?;
        let result = &v["chart"]["result"][0];
        anyhow::ensure!(!result.is_null(), "yahoo: no result for {symbol}");

        let ts = result["timestamp"]
            .as_array()
            .context("yahoo: no timestamps")?;
        let q = &result["indicators"]["quote"][0];
        let (open, high, low, close, vol) = (
            q["open"].as_array().context("open")?,
            q["high"].as_array().context("high")?,
            q["low"].as_array().context("low")?,
            q["close"].as_array().context("close")?,
            q["volume"].as_array().context("volume")?,
        );

        let mut out = Vec::with_capacity(ts.len());
        for i in 0..ts.len() {
            // 当日未收盘/停牌行有 null，跳过
            let (Some(t), Some(o), Some(h), Some(l), Some(c)) = (
                ts[i].as_i64(),
                open[i].as_f64(),
                high[i].as_f64(),
                low[i].as_f64(),
                close[i].as_f64(),
            ) else {
                continue;
            };
            let volume = vol[i].as_f64().unwrap_or(0.0);
            out.push(Kline {
                open_time: t * 1000,
                open: o,
                high: h,
                low: l,
                close: c,
                volume,
                taker_buy_volume: volume / 2.0, // 中性：股票无逐笔主动买卖方向
                trades: 0,
            });
        }
        out.sort_by_key(|k| k.open_time);
        out.dedup_by_key(|k| k.open_time);
        out.retain(|k| k.open_time >= start_ms && k.open_time < end_ms);
        Ok(out)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchHit {
    pub symbol: String,
    pub name: String,
    pub exchange: String,
    pub quote_type: String,
}

impl YahooClient {
    /// 模糊搜索股票/ETF/指数（公司名或代码）
    pub async fn search(&self, query: &str) -> Result<Vec<SearchHit>> {
        let url = format!(
            "https://query1.finance.yahoo.com/v1/finance/search?q={}&quotesCount=12&newsCount=0",
            urlencoding_full(query)
        );
        let v: Value = self
            .http
            .get(&url)
            .send()
            .await
            .context("yahoo search request")?
            .error_for_status()
            .context("yahoo search status")?
            .json()
            .await
            .context("yahoo search json")?;
        let quotes = v["quotes"].as_array().cloned().unwrap_or_default();
        Ok(quotes
            .iter()
            .filter_map(|q| {
                let qt = q["quoteType"].as_str().unwrap_or("");
                if !matches!(qt, "EQUITY" | "ETF" | "INDEX") {
                    return None;
                }
                Some(SearchHit {
                    symbol: q["symbol"].as_str()?.to_string(),
                    name: q["shortname"]
                        .as_str()
                        .or_else(|| q["longname"].as_str())
                        .unwrap_or("")
                        .to_string(),
                    exchange: q["exchDisp"].as_str().unwrap_or("").to_string(),
                    quote_type: qt.to_string(),
                })
            })
            .collect())
    }

    /// 最新报价（time_ms, price）：v8 chart meta 的 regularMarketPrice
    pub async fn last_price(&self, symbol: &str) -> Result<(i64, f64)> {
        throttle().await;
        let url = format!("{BASE}/{}?interval=1m&range=1d", urlencode(symbol));
        let v: Value = self
            .http
            .get(&url)
            .send()
            .await
            .context("yahoo quote request")?
            .error_for_status()
            .context("yahoo quote status")?
            .json()
            .await
            .context("yahoo quote json")?;
        let meta = &v["chart"]["result"][0]["meta"];
        let price = meta["regularMarketPrice"]
            .as_f64()
            .context("no regularMarketPrice")?;
        let time = meta["regularMarketTime"].as_i64().unwrap_or(0) * 1000;
        Ok((time, price))
    }
}

fn urlencode(s: &str) -> String {
    s.replace('^', "%5E")
}

/// 简易完整 URL 编码（搜索 query 用）
fn urlencoding_full(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// 判断 symbol 属于哪个数据源：USDT/USDC/BUSD 结尾 → Binance，否则 Yahoo
pub fn is_crypto(symbol: &str) -> bool {
    let s = symbol.to_uppercase();
    s.ends_with("USDT") || s.ends_with("USDC") || s.ends_with("BUSD")
}
