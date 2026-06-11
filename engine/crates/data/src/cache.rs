//! K线磁盘缓存：bincode 二进制文件，按 symbol+interval 一文件，增量补齐。

use anyhow::{Context, Result};
use qcore::{Interval, Kline};
use std::path::{Path, PathBuf};

use crate::{is_crypto, BinanceClient, YahooClient};

pub struct KlineStore {
    dir: PathBuf,
    client: BinanceClient,
    yahoo: YahooClient,
    /// 尾部刷新冷却：(symbol, interval) → 上次网络刷新 ms。
    /// 44+ 槽位高频调用 get() 时避免对同一标的反复重抓尾部 bar
    last_refresh: std::sync::Mutex<std::collections::HashMap<(String, Interval), i64>>,
}

/// 尾部刷新冷却期（毫秒）：日线及以上 60-90s（按标的散列抖动错峰，
/// 避免44个标的同时到期形成请求惊群），盘中粒度 15s
fn tail_cooldown_ms(symbol: &str, interval: Interval) -> i64 {
    if interval.millis() >= 86_400_000 {
        let jitter = symbol.bytes().map(|b| b as i64).sum::<i64>() % 30_000;
        60_000 + jitter
    } else {
        15_000
    }
}

impl KlineStore {
    pub fn new(dir: impl AsRef<Path>) -> Result<Self> {
        std::fs::create_dir_all(dir.as_ref())?;
        Ok(Self {
            dir: dir.as_ref().to_path_buf(),
            client: BinanceClient::new(),
            yahoo: YahooClient::new(),
            last_refresh: std::sync::Mutex::new(std::collections::HashMap::new()),
        })
    }

    fn path(&self, symbol: &str, interval: Interval) -> PathBuf {
        self.dir
            .join(format!("{}_{}.bin", symbol, interval.as_binance()))
    }

    pub fn load_cached(&self, symbol: &str, interval: Interval) -> Result<Vec<Kline>> {
        let p = self.path(symbol, interval);
        if !p.exists() {
            return Ok(Vec::new());
        }
        let bytes = std::fs::read(&p).context("read cache")?;
        let klines: Vec<Kline> = bincode::deserialize(&bytes).context("decode cache")?;
        Ok(klines)
    }

    fn save(&self, symbol: &str, interval: Interval, klines: &[Kline]) -> Result<()> {
        let bytes = bincode::serialize(klines)?;
        let p = self.path(symbol, interval);
        let tmp = p.with_extension("tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &p)?;
        Ok(())
    }

    /// 获取 [start_ms, end_ms) 的K线：优先用缓存，缺口处增量下载并落盘。
    pub async fn get(
        &self,
        symbol: &str,
        interval: Interval,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<Vec<Kline>> {
        let mut cached = self.load_cached(symbol, interval)?;
        let step = interval.millis();

        let need_head = cached.first().map_or(true, |k| k.open_time > start_ms);
        // 尾部永远视为"暂定"：盘中抓到的bar收盘后才定稿（成交量补全、
        // 收盘价修正），所以总是从缓存最后一根的 open_time 起重抓覆盖。
        // 但加冷却期：冷却内直接用缓存，避免多会话高频调用打爆数据源限流
        let tail_start = cached.last().map(|k| k.open_time).unwrap_or(start_ms);
        let mut need_tail = cached.last().map_or(true, |k| k.open_time + step < end_ms)
            || tail_start < end_ms;
        if need_tail && !need_head && !cached.is_empty() {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            let key = (symbol.to_string(), interval);
            let mut lr = self.last_refresh.lock().unwrap();
            if now - lr.get(&key).copied().unwrap_or(0) < tail_cooldown_ms(symbol, interval) {
                need_tail = false; // 冷却期内：直接用缓存
            } else {
                lr.insert(key, now);
            }
        }

        if need_head || need_tail {
            let fetch_start = if need_head { start_ms } else { tail_start };
            let fetch_end = if need_head && !cached.is_empty() && !need_tail {
                cached.first().unwrap().open_time
            } else {
                end_ms
            };
            if fetch_start < fetch_end {
                tracing::info!(symbol, ?interval, fetch_start, fetch_end, "fetching klines");
                let fresh = if is_crypto(symbol) {
                    self.client
                        .fetch_klines(symbol, interval, fetch_start, fetch_end)
                        .await?
                } else {
                    self.yahoo
                        .fetch_klines(symbol, interval, fetch_start, fetch_end)
                        .await?
                };
                if !fresh.is_empty() {
                    // 新数据优先：把缓存中与重抓区间重叠的旧bar移除
                    cached.retain(|k| k.open_time < fetch_start || k.open_time >= fetch_end);
                    cached.extend(fresh);
                    cached.sort_by_key(|k| k.open_time);
                    cached.dedup_by_key(|k| k.open_time);
                    self.save(symbol, interval, &cached)?;
                }
            }
        }

        Ok(cached
            .into_iter()
            .filter(|k| k.open_time >= start_ms && k.open_time < end_ms)
            .collect())
    }
}
