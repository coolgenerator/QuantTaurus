//! Binance WebSocket 实时行情流 → tokio broadcast 通道。
//! 自动重连，指数退避。

use anyhow::Result;
use futures_util::StreamExt;
use qcore::{Kline, MarketEvent};
use serde_json::Value;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio_tungstenite::connect_async;

// 公开行情数据镜像（stream.binance.com 在部分地区被地域限制）
const WS_BASE: &str = "wss://data-stream.binance.vision/stream";

/// 订阅多个 symbol 的 kline_1m + aggTrade 流，事件发往返回的 broadcast 通道。
/// 内部 spawn 任务保持连接并自动重连。
pub fn stream_market(symbols: Vec<String>) -> broadcast::Sender<MarketEvent> {
    let (tx, _) = broadcast::channel(4096);
    let tx2 = tx.clone();
    tokio::spawn(async move {
        let mut backoff = 1u64;
        loop {
            match run_stream(&symbols, &tx2).await {
                Ok(()) => backoff = 1,
                Err(e) => {
                    tracing::warn!(error = %e, backoff, "ws stream error, reconnecting");
                }
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(60);
        }
    });
    tx
}

async fn run_stream(symbols: &[String], tx: &broadcast::Sender<MarketEvent>) -> Result<()> {
    let streams: Vec<String> = symbols
        .iter()
        .flat_map(|s| {
            let s = s.to_lowercase();
            [format!("{s}@kline_1m"), format!("{s}@aggTrade")]
        })
        .collect();
    let url = format!("{WS_BASE}?streams={}", streams.join("/"));
    let (ws, _) = connect_async(&url).await?;
    tracing::info!(?symbols, "binance ws connected");
    let (_, mut read) = ws.split();

    while let Some(msg) = read.next().await {
        let msg = msg?;
        if !msg.is_text() {
            continue;
        }
        let v: Value = serde_json::from_str(msg.to_text()?)?;
        let Some(data) = v.get("data") else { continue };
        if let Some(ev) = parse_event(data) {
            // 没有订阅者时发送失败是正常的
            let _ = tx.send(ev);
        }
    }
    Ok(())
}

fn parse_event(data: &Value) -> Option<MarketEvent> {
    let etype = data.get("e")?.as_str()?;
    match etype {
        "kline" => {
            let k = data.get("k")?;
            let f = |key: &str| k.get(key)?.as_str()?.parse::<f64>().ok();
            Some(MarketEvent::Kline {
                symbol: data.get("s")?.as_str()?.to_string(),
                interval: k.get("i")?.as_str()?.to_string(),
                closed: k.get("x")?.as_bool()?,
                kline: Kline {
                    open_time: k.get("t")?.as_i64()?,
                    open: f("o")?,
                    high: f("h")?,
                    low: f("l")?,
                    close: f("c")?,
                    volume: f("v")?,
                    taker_buy_volume: f("V")?,
                    trades: k.get("n")?.as_u64()?,
                },
            })
        }
        "aggTrade" => Some(MarketEvent::Trade {
            symbol: data.get("s")?.as_str()?.to_string(),
            time: data.get("T")?.as_i64()?,
            price: data.get("p")?.as_str()?.parse().ok()?,
            qty: data.get("q")?.as_str()?.parse().ok()?,
            is_buyer_maker: data.get("m")?.as_bool()?,
        }),
        _ => None,
    }
}
