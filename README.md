# QuantTaurus — 全栈量化交易平台

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
│  ├── crates/evolve    自迭代: 散布折验证 + 进化搜索          │
│  │                    + Deflated Sharpe 防过拟合 + 冠军挑战  │
│  └── crates/server    axum API + WS 推送 + 自动再训练        │
│                       + 实时模拟盘 (冠军接实时流跑 paper)    │
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

1. **散布折验证**: 验证折均匀散布在留出窗之前的全部历史，强制候选穿越牛/熊/震荡
   都稳定（适应度 = 折均值 − 0.75×折标准差）
2. **进化搜索**: 对 4 个策略家族的参数空间做 (μ+λ) 进化搜索
3. **Ensemble 挑战者**: top-k 跨家族候选等权平均仓位，与单点最优按折适应度对决
4. **冠军-挑战者晋升**: 挑战者必须在**从未参与搜索的留出窗**上超过现任冠军一个边际，
   且留出 Sharpe 必须 > 0（绝对底线，宁缺毋滥）；血统 (lineage) 全程记录
5. **自动再训练**: server 每 6 小时（`QHH_AUTORETRAIN_HOURS`）用最新数据重跑进化，
   冠军热更新后实时模拟盘自动切换到新冠军

## 实验结论（2026-06，4 年 Binance 数据）

- **4h 频率在 0.001+0.0005 双边成本下无净边际**：折挤在数据末尾时验证 Sharpe 虚高
  2~3，散布到全历史后跌到 ~0.5 且留出全负 → 之前是 regime 拟合
- **1d 降频后出现真实边际**：SOLUSDT 1d ensemble（4×TSMOM+vol-managed）通过全部
  闸门晋升：4 折全正 [0.62, 1.65, 1.63, 0.51]，留出窗 Sharpe +0.48 / 年化 +26%
- BTC（-0.06）/ ETH（-0.31）留出未过底线，未晋升——闸门按设计如实拦截

## 快速开始

```bash
# 后端
cd engine && cargo run --release -p server     # :8787
# 前端
cd web && npm i && npm run dev                 # :5173（若被占用 Vite 会自动换 5174）
```

环境变量：`QHH_DATA_DIR`（数据目录，默认 `data`）、`QHH_AUTORETRAIN_HOURS`（默认 6，
0 关闭）、`QHH_AUTORETRAIN_SYMBOL` / `_INTERVAL` / `_DAYS`（默认 BTCUSDT / 4h / 730）。

注：部分地区 api.binance.com 返回 451，本项目使用官方公开镜像
`data-api.binance.vision` / `data-stream.binance.vision`（仅行情数据，无需 API key）。
