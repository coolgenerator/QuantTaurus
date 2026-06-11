//! 数据采集：Binance 公共 API 历史K线 + WebSocket 实时流，带本地磁盘缓存。

pub mod binance;
pub mod cache;
pub mod stream;
pub mod yahoo;

pub use binance::BinanceClient;
pub use cache::KlineStore;
pub use stream::stream_market;
pub use yahoo::{is_crypto, YahooClient};
