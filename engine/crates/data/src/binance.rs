//! Binance REST 历史数据客户端（公共接口，无需 API key）。

use anyhow::{Context, Result};
use qcore::{Interval, Kline};
use serde_json::Value;
use std::time::Duration;

// 公开行情数据镜像（api.binance.com 在部分地区返回 451）
const BASE: &str = "https://data-api.binance.vision";
/// 单次请求最大根数（Binance 限制 1000）
const PAGE_LIMIT: usize = 1000;

pub struct BinanceClient {
    http: reqwest::Client,
}

impl Default for BinanceClient {
    fn default() -> Self {
        Self::new()
    }
}

impl BinanceClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .expect("reqwest client");
        Self { http }
    }

    /// 拉取 [start_ms, end_ms) 区间的全部K线，自动翻页 + 限速退避。
    pub async fn fetch_klines(
        &self,
        symbol: &str,
        interval: Interval,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<Vec<Kline>> {
        let mut out = Vec::new();
        let mut cursor = start_ms;
        while cursor < end_ms {
            let url = format!(
                "{BASE}/api/v3/klines?symbol={symbol}&interval={}&startTime={cursor}&endTime={end_ms}&limit={PAGE_LIMIT}",
                interval.as_binance()
            );
            let resp = self.http.get(&url).send().await.context("klines request")?;
            if resp.status().as_u16() == 429 {
                tracing::warn!("rate limited, backing off 30s");
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            }
            let resp = resp.error_for_status().context("klines status")?;
            let rows: Vec<Vec<Value>> = resp.json().await.context("klines json")?;
            if rows.is_empty() {
                break;
            }
            let page_len = rows.len();
            for row in rows {
                out.push(parse_row(&row)?);
            }
            let last_open = out.last().unwrap().open_time;
            cursor = last_open + interval.millis();
            if page_len < PAGE_LIMIT {
                break;
            }
            // 温和限速：Binance weight 限制 6000/min，这里远低于
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
        out.retain(|k| k.open_time < end_ms);
        out.dedup_by_key(|k| k.open_time);
        Ok(out)
    }
}

fn parse_row(row: &[Value]) -> Result<Kline> {
    fn f(v: &Value) -> Result<f64> {
        v.as_str()
            .context("expected string number")?
            .parse::<f64>()
            .context("parse f64")
    }
    Ok(Kline {
        open_time: row[0].as_i64().context("open_time")?,
        open: f(&row[1])?,
        high: f(&row[2])?,
        low: f(&row[3])?,
        close: f(&row[4])?,
        volume: f(&row[5])?,
        trades: row[8].as_u64().context("trades")?,
        taker_buy_volume: f(&row[9])?,
    })
}
