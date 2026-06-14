//! 全局应用状态：数据存储、行情广播、进化任务状态、冠军注册表。

use anyhow::Result;
use qcore::MarketEvent;
use qdata::KlineStore;
use qevolve::EvolveReport;
use qstrategy::StrategySpec;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
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
    /// 板块报告后台刷新进行中标记（防重复 spawn）
    pub sectors_refreshing: AtomicBool,
    /// 交易计划 SWR 缓存：过期回旧值+后台刷新，HTTP 请求不再扛 Yahoo 串行尾刷
    pub plans_cache: Mutex<Option<(i64, Arc<Vec<crate::plan::TradePlan>>)>>,
    /// 计划重算互斥：冷启动并发去重 + 后台刷新串行化
    pub plans_compute: tokio::sync::Mutex<()>,
    pub plans_refreshing: AtomicBool,
    /// 重 JSON 接口（universe_plan / factor_forecast）SWR 缓存：key → (生成时间ms, 值)
    pub json_swr_cache: Mutex<HashMap<String, (i64, serde_json::Value)>>,
    /// 上述缓存的在飞刷新键集合
    pub json_swr_refreshing: Mutex<HashSet<String>>,
    /// 技术规则历史统计缓存：interval → (生成时间ms, 序列化结果)
    pub ta_stats_cache: Mutex<HashMap<String, (i64, serde_json::Value)>>,
    pub paper_path: PathBuf,
    /// 因子挖掘任务状态与因子库
    pub mine_status: Mutex<crate::mine_job::MineStatus>,
    /// 全宇宙进化扫描状态
    pub sweep_status: Mutex<SweepStatus>,
    pub factor_lib_path: PathBuf,
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
        // 模拟盘会话持久化恢复（重启不清零净值）
        let paper_path = PathBuf::from(data_dir).join("paper.json");
        let paper: HashMap<String, crate::paper::PaperSession> = if paper_path.exists() {
            serde_json::from_str(&std::fs::read_to_string(&paper_path)?).unwrap_or_default()
        } else {
            HashMap::new()
        };
        Ok(Self {
            store,
            ws_tx,
            evolve_status: Mutex::new(EvolveStatus::Idle),
            champions: Mutex::new(champions),
            champion_path,
            paper: Mutex::new(paper),
            sector_cache: Mutex::new(None),
            sectors_refreshing: AtomicBool::new(false),
            plans_cache: Mutex::new(None),
            plans_compute: tokio::sync::Mutex::new(()),
            plans_refreshing: AtomicBool::new(false),
            json_swr_cache: Mutex::new(HashMap::new()),
            json_swr_refreshing: Mutex::new(HashSet::new()),
            ta_stats_cache: Mutex::new(HashMap::new()),
            sweep_status: Mutex::new(SweepStatus::Idle),
            paper_path,
            mine_status: Mutex::new(crate::mine_job::MineStatus::Idle),
            factor_lib_path: PathBuf::from(data_dir).join("factors.json"),
        })
    }

    pub fn save_paper(&self) {
        let map = self.paper.lock().unwrap().clone();
        if let Ok(json) = serde_json::to_string(&map) {
            let tmp = self.paper_path.with_extension("tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &self.paper_path);
            }
        }
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
/// 单标的扫描结果（按完成顺序追加）
#[derive(Debug, Clone, serde::Serialize)]
pub struct SweepResult {
    pub symbol: String,
    pub promoted: bool,
    pub holdout_sharpe: f64,
    pub valid_sharpe: f64,
    pub kind: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SweepStatus {
    Idle,
    Running {
        started_ms: i64,
        total: usize,
        current: String,
        results: Vec<SweepResult>,
    },
    Done {
        started_ms: i64,
        finished_ms: i64,
        results: Vec<SweepResult>,
    },
}

/// 晋升逻辑（launch_evolve 与 sweep 共用）
fn apply_promotion(
    state: &std::sync::Arc<AppState>,
    symbol: &str,
    interval_s: &str,
    report: &qevolve::EvolveReport,
) {
    if !report.promoted {
        return;
    }
    let key = champ_key(symbol, interval_s);
    let mut champs = state.champions.lock().unwrap();
    let rec = champs.entry(key).or_default();
    rec.spec = Some(report.champion.spec.clone());
    rec.symbol = symbol.to_string();
    rec.interval = interval_s.to_string();
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

/// 全宇宙进化扫描：逐标的顺序进化（每标的~1-2分钟CPU），晋升走与单跑相同的
/// margin+floor 闸门。自进化模式的调度层：可由 /api/evolve_sweep 手动触发，
/// 或 QT_AUTOSWEEP_HOURS 周期自动触发。
pub fn launch_sweep(
    state: std::sync::Arc<AppState>,
    symbols: Vec<String>,
    interval_s: String,
    days: i64,
) {
    let total = symbols.len();
    *state.sweep_status.lock().unwrap() = SweepStatus::Running {
        started_ms: now_ms(),
        total,
        current: String::new(),
        results: Vec::new(),
    };
    tokio::spawn(async move {
        let started_ms = now_ms();
        let mut results: Vec<SweepResult> = Vec::new();
        let Some(interval) = qcore::Interval::parse(&interval_s) else {
            *state.sweep_status.lock().unwrap() = SweepStatus::Done {
                started_ms,
                finished_ms: now_ms(),
                results,
            };
            return;
        };
        for sym in symbols {
            if let SweepStatus::Running { current, results: r, .. } =
                &mut *state.sweep_status.lock().unwrap()
            {
                *current = sym.clone();
                *r = results.clone();
            }
            let end = now_ms();
            let res = async {
                let klines = state
                    .store
                    .get(&sym, interval, end - days * 86_400_000, end)
                    .await?;
                let n = klines.len();
                // 自适应窗口：留出90 + 验证600(4折)，其余训练；历史太短的标的跳过
                anyhow::ensure!(n >= 1100, "history too short: {n} bars");
                let valid_bars = 600.min((n - 90) / 2);
                let train_bars = n - valid_bars - 90 - 5;
                let (bars_per_year, cost) = crate::routes::market_params(&sym, interval);
                let cfg = qevolve::EvolveConfig {
                    population: 24,
                    offspring: 48,
                    generations: 10,
                    train_bars,
                    valid_bars,
                    valid_folds: 4,
                    holdout_bars: 90,
                    bars_per_year,
                    cost,
                    seed: 11,
                    promotion_margin: 0.1,
                    promotion_floor: 0.0,
                };
                let incumbent = {
                    let champs = state.champions.lock().unwrap();
                    champs
                        .get(&champ_key(&sym, &interval_s))
                        .and_then(|c| c.spec.clone())
                };
                let report = tokio::task::spawn_blocking(move || {
                    qevolve::evolve(&klines, &cfg, incumbent.as_ref())
                })
                .await??;
                anyhow::Ok(report)
            }
            .await;

            let entry = match res {
                Ok(report) => {
                    apply_promotion(&state, &sym, &interval_s, &report);
                    SweepResult {
                        symbol: sym.clone(),
                        promoted: report.promoted,
                        holdout_sharpe: report
                            .champion
                            .holdout_metrics
                            .as_ref()
                            .map_or(f64::NAN, |m| m.sharpe),
                        valid_sharpe: report.champion.valid_metrics.sharpe,
                        kind: report.champion.spec.name().to_string(),
                        error: None,
                    }
                }
                Err(e) => SweepResult {
                    symbol: sym.clone(),
                    promoted: false,
                    holdout_sharpe: f64::NAN,
                    valid_sharpe: f64::NAN,
                    kind: String::new(),
                    error: Some(e.to_string()),
                },
            };
            results.push(entry);
        }
        let n_promoted = results.iter().filter(|r| r.promoted).count();
        tracing::info!(n_promoted, total = results.len(), "evolve sweep finished");
        *state.sweep_status.lock().unwrap() = SweepStatus::Done {
            started_ms,
            finished_ms: now_ms(),
            results,
        };
    });
}

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
