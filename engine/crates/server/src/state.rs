//! 全局应用状态：数据存储、行情广播、进化任务状态、冠军注册表。

use anyhow::Result;
use qcore::MarketEvent;
use qdata::KlineStore;
use qevolve::EvolveReport;
use qstrategy::StrategySpec;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::sync::broadcast;

/// 推送给前端的 WS 消息
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "channel", rename_all = "snake_case")]
pub enum WsMessage {
    Market(MarketEvent),
    EvolveProgress {
        generation: usize,
        total: usize,
        best_valid_sharpe: f64,
    },
    EvolveDone {
        promoted: bool,
        champion_name: String,
    },
    /// 模拟盘净值标记
    Paper {
        key: String,
        symbol: String,
        interval: String,
        time: i64,
        equity: f64,
        position: f64,
        price: f64,
    },
    /// 模拟盘调仓事件
    PaperTrade {
        key: String,
        symbol: String,
        trade: crate::paper::PaperTrade,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChampionRecord {
    pub spec: Option<StrategySpec>,
    pub symbol: String,
    pub interval: String,
    pub updated_ms: i64,
    /// 历任冠军血统
    pub lineage: Vec<LineageEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineageEntry {
    pub spec: StrategySpec,
    pub holdout_sharpe: f64,
    pub promoted_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum EvolveStatus {
    Idle,
    Running { started_ms: i64 },
    Done { report: Box<EvolveReport> },
    Failed { error: String },
}

/// 注册表键：`"SYMBOL|interval"`，如 `"SPY|1d"`
pub fn champ_key(symbol: &str, interval: &str) -> String {
    format!("{symbol}|{interval}")
}

pub struct AppState {
    pub store: KlineStore,
    pub ws_tx: broadcast::Sender<WsMessage>,
    pub evolve_status: Mutex<EvolveStatus>,
    /// 多槽冠军注册表：每个 symbol|interval 一个冠军
    pub champions: Mutex<HashMap<String, ChampionRecord>>,
    pub champion_path: PathBuf,
    /// 每个冠军一个模拟盘会话，键同注册表
    pub paper: Mutex<HashMap<String, crate::paper::PaperSession>>,
    /// 板块报告缓存：(生成时间ms, 序列化结果)
    pub sector_cache: Mutex<Option<(i64, serde_json::Value)>>,
}

impl AppState {
    pub fn new(data_dir: &str) -> Result<Self> {
        let store = KlineStore::new(data_dir)?;
        let (ws_tx, _) = broadcast::channel(8192);
        let champion_path = PathBuf::from(data_dir).join("champions.json");
        let legacy_path = PathBuf::from(data_dir).join("champion.json");
        let champions: HashMap<String, ChampionRecord> = if champion_path.exists() {
            serde_json::from_str(&std::fs::read_to_string(&champion_path)?)?
        } else if legacy_path.exists() {
            // 旧单槽格式迁移
            let rec: ChampionRecord =
                serde_json::from_str(&std::fs::read_to_string(&legacy_path)?)?;
            if rec.spec.is_some() && !rec.symbol.is_empty() {
                HashMap::from([(champ_key(&rec.symbol, &rec.interval), rec)])
            } else {
                HashMap::new()
            }
        } else {
            HashMap::new()
        };
        Ok(Self {
            store,
            ws_tx,
            evolve_status: Mutex::new(EvolveStatus::Idle),
            champions: Mutex::new(champions),
            champion_path,
            paper: Mutex::new(HashMap::new()),
            sector_cache: Mutex::new(None),
        })
    }

    pub fn save_champions(&self) {
        let map = self.champions.lock().unwrap().clone();
        if let Ok(json) = serde_json::to_string_pretty(&map) {
            let _ = std::fs::write(&self.champion_path, json);
        }
    }

    /// 把 Binance 实时流桥接到前端 WS 广播
    pub fn start_market_stream(&self, symbols: Vec<String>) {
        let market_tx = qdata::stream_market(symbols);
        let ws_tx = self.ws_tx.clone();
        tokio::spawn(async move {
            let mut rx = market_tx.subscribe();
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        let _ = ws_tx.send(WsMessage::Market(ev));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
}

/// 在 blocking 线程上启动一轮进化（路由和自动再训练调度器共用）。
/// 调用前须自行确认 evolve_status 不在 Running。
pub fn launch_evolve(
    state: std::sync::Arc<AppState>,
    symbol: String,
    interval_s: String,
    klines: Vec<qcore::Kline>,
    cfg: qevolve::EvolveConfig,
) {
    *state.evolve_status.lock().unwrap() = EvolveStatus::Running {
        started_ms: now_ms(),
    };
    tokio::task::spawn_blocking(move || {
        let key = champ_key(&symbol, &interval_s);
        let incumbent = {
            let champs = state.champions.lock().unwrap();
            champs.get(&key).and_then(|c| c.spec.clone())
        };
        match qevolve::evolve(&klines, &cfg, incumbent.as_ref()) {
            Ok(report) => {
                if report.promoted {
                    let mut champs = state.champions.lock().unwrap();
                    let rec = champs.entry(key).or_default();
                    rec.spec = Some(report.champion.spec.clone());
                    rec.symbol = symbol;
                    rec.interval = interval_s;
                    rec.updated_ms = now_ms();
                    rec.lineage.push(LineageEntry {
                        spec: report.champion.spec.clone(),
                        holdout_sharpe: report
                            .champion
                            .holdout_metrics
                            .as_ref()
                            .map_or(0.0, |m| m.sharpe),
                        promoted_ms: now_ms(),
                    });
                    drop(champs);
                    state.save_champions();
                }
                let _ = state.ws_tx.send(WsMessage::EvolveDone {
                    promoted: report.promoted,
                    champion_name: report.champion.spec.name().to_string(),
                });
                *state.evolve_status.lock().unwrap() = EvolveStatus::Done {
                    report: Box::new(report),
                };
            }
            Err(e) => {
                *state.evolve_status.lock().unwrap() = EvolveStatus::Failed {
                    error: e.to_string(),
                };
            }
        }
    });
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
