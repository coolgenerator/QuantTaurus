# QuantHaHa — 全栈量化交易平台

低延迟量化交易研究与执行平台：Rust 核心引擎 + React 实时可视化前端。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  web/  (React + TS + Vite + Tailwind + lightweight-charts)  │
│  实时K线 · 因子热力图 · 回测净值曲线 · 策略进化面板          │
└──────────────────────┬──────────────────────────────────────┘
                       │ REST + WebSocket
┌──────────────────────┴──────────────────────────────────────┐
│  engine/ (Rust workspace)                                    │
│  ├── crates/core      共享类型 (Kline, Trade, Signal…)      │
│  ├── crates/data      数据采集: Binance REST 历史 + WS 实时  │
│  ├── crates/factors   因子库: 动量/反转/波动率/微观结构      │
│  ├── crates/backtest  事件驱动回测: 手续费/滑点/资金曲线     │
│  ├── crates/strategy  策略定义 + 参数空间                    │
│  ├── crates/evolve    自迭代: walk-forward + 进化搜索        │
│  │                    + Deflated Sharpe 防过拟合 + 冠军挑战  │
│  └── crates/server    axum API + WS 推送                     │
└─────────────────────────────────────────────────────────────┘
        数据存储: data/ 下 Parquet 风格二进制 + JSON 注册表
```

## 数据源

Binance 公共 API（加密货币，免 API key）：
- 历史: `GET /api/v3/klines`（1m/5m/1h/1d）
- 实时: `wss://stream.binance.com:9443/ws` kline/aggTrade 流

## 学术参考（策略与防过拟合设计依据）

- **时序动量**: Moskowitz, Ooi & Pedersen (2012), *Time Series Momentum*
- **波动率管理**: Moreira & Muir (2017), *Volatility-Managed Portfolios*
- **订单流不平衡 (OFI)**: Cont, Kukanov & Stoikov (2014), *The Price Impact of Order Book Events*
- **防过拟合**: Bailey & López de Prado (2014), *The Deflated Sharpe Ratio*; López de Prado (2018) Purged Walk-Forward / CPCV
- **加密截面动量/反转**: Liu, Tsyvinski & Wu (2022), *Common Risk Factors in Cryptocurrency*

## 策略自迭代机制（evolve crate）

1. **滚动 walk-forward**: 训练窗 → 验证窗 → 留出窗，窗口随时间滚动，杜绝前视偏差
2. **进化搜索**: 对策略参数空间做 (μ+λ) 进化策略搜索，目标 = 验证集 Deflated Sharpe
3. **冠军-挑战者**: 新参数仅在留出集上显著优于现任冠军时才晋升，记录全部血统 (lineage)
4. **定时再训练**: server 内置调度器，新数据到达后自动重跑 walk-forward 并热更新冠军策略

## 快速开始

```bash
# 后端
cd engine && cargo run --release -p server     # :8787
# 前端
cd web && npm i && npm run dev                 # :5173
```
