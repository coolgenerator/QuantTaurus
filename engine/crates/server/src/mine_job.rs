//! 因子挖掘任务：构建52股票池面板 → qmine 遗传规划 → 因子库持久化。

use crate::state::{now_ms, AppState};
use qcore::Interval;
use qmine::{mine, MineConfig, MineReport, Panel};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// 挖掘股票池（与分钟采集器同口径的52只热门科技/明星股+ETF）
pub const UNIVERSE: [&str; 52] = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "NVDA",
    "AMD", "AVGO", "TSM", "INTC", "QCOM", "ARM", "MRVL", "TXN", "ADI", "NXPI", "ON",
    "ASML", "AMAT", "LRCX", "KLAC", "TER",
    "MU", "WDC", "STX", "SNDK",
    "SMCI", "DELL", "VRT", "ANET", "ORCL", "PLTR", "CRWV",
    "CRM", "NOW", "SNOW", "DDOG", "NET", "CRWD", "PANW", "SHOP", "UBER", "COIN", "MSTR", "HOOD",
    "VST", "CEG",
    "SPY", "QQQ", "SMH", "SOXX",
];

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MineStatus {
    Idle,
    Running { started_ms: i64 },
    Done { report: Box<MineReport> },
    Failed { error: String },
}

/// 因子库条目（通过留出验收的因子才入库）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryFactor {
    pub expression: String,
    /// 可执行 AST（方向已归一）
    pub ast: qmine::Expr,
    pub mean_ic: f64,
    pub icir: f64,
    pub holdout_ic: f64,
    pub complexity: usize,
    pub horizon: usize,
    pub mined_ms: i64,
}

pub fn load_library(state: &AppState) -> Vec<LibraryFactor> {
    std::fs::read_to_string(&state.factor_lib_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_library(state: &AppState, lib: &[LibraryFactor]) {
    if let Ok(json) = serde_json::to_string_pretty(lib) {
        let _ = std::fs::write(&state.factor_lib_path, json);
    }
}

pub async fn build_panel(state: &Arc<AppState>, days: i64) -> anyhow::Result<Panel> {
    let end = now_ms();
    let start = end - days * 86_400_000;
    let mut series = Vec::new();
    for sym in UNIVERSE {
        match state.store.get(sym, Interval::D1, start, end).await {
            Ok(ks) if !ks.is_empty() => series.push((sym.to_string(), ks)),
            Ok(_) => tracing::warn!(sym, "panel: empty"),
            Err(e) => tracing::warn!(sym, error = %e, "panel: fetch failed"),
        }
    }
    // 覆盖率阈值放低：新股（ARM/CRWV/SNDK等）早期为 NaN，IC 计算自动跳过
    let panel = Panel::build(&series, 0.15);
    anyhow::ensure!(panel.n_symbols() >= 20, "panel too small: {}", panel.n_symbols());
    Ok(panel)
}

/// 启动挖掘（spawn_blocking），完成后把通过留出验收的因子并入因子库
pub fn launch_mine(state: Arc<AppState>, panel: Panel, cfg: MineConfig) {
    *state.mine_status.lock().unwrap() = MineStatus::Running {
        started_ms: now_ms(),
    };
    tokio::task::spawn_blocking(move || {
        let report = mine(&panel, &cfg);
        let mut lib = load_library(&state);
        let mut added = 0;
        for f in report.factors.iter().filter(|f| f.passed_holdout) {
            if lib.iter().any(|x| x.expression == f.expression) {
                continue;
            }
            lib.push(LibraryFactor {
                expression: f.expression.clone(),
                ast: f.expr.clone(),
                mean_ic: f.mean_ic,
                icir: f.icir,
                holdout_ic: f.holdout_ic,
                complexity: f.complexity,
                horizon: cfg.horizon,
                mined_ms: now_ms(),
            });
            added += 1;
        }
        if added > 0 {
            lib.sort_by(|a, b| b.holdout_ic.partial_cmp(&a.holdout_ic).unwrap());
            save_library(&state, &lib);
        }
        tracing::info!(
            evaluated = report.total_evaluated,
            selected = report.factors.len(),
            added_to_library = added,
            "mining done"
        );
        *state.mine_status.lock().unwrap() = MineStatus::Done {
            report: Box::new(report),
        };
    });
}
