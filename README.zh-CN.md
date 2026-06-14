# QuantTaurus - 全栈量化研究与模拟交易平台

[English](README.md)

QuantTaurus 是一个本地优先的量化研究平台。Rust 引擎负责行情缓存、因子计算、回测、策略进化和模拟盘；React 控制台负责图表、因子研究、回测结果、冠军策略追踪、交易计划和持仓视图。

> 本项目仅用于研究和模拟交易，不构成投资建议，也不是完整的生产级交易风控系统。

## 架构

```text
web/                       React + TypeScript + Vite + Tailwind
  图表、技术分析、因子实验、回测、进化任务、模拟盘
      | REST + WebSocket
engine/                    Rust workspace
  crates/core              共享类型：Kline、Signal、MarketEvent、指标
  crates/data              Binance/Yahoo 数据客户端和本地缓存
  crates/factors           动量、反转、波动率、技术规则、横截面因子
  crates/backtest          事件驱动回测：成本、滑点、净值曲线
  crates/strategy          策略定义和参数空间
  crates/evolve            walk-forward 验证、进化搜索、冠军挑战者机制
  crates/mine              表达式因子挖掘
  crates/server            axum API、WebSocket 推送、自动扫描、模拟盘
bridge/                    moomoo/OpenD Python sidecar
```

本地运行状态默认写入 `engine/data/`，包括 K 线缓存、冠军注册表、模拟盘状态和风控熔断标记。该目录已经从 Git 中排除。

## 支持的数据

| 资产/功能 | 数据源 | 说明 |
|---|---|---|
| 加密货币 K 线 | Binance 公共行情镜像 | 使用 `data-api.binance.vision` 和 `data-stream.binance.vision`，无需 API key |
| 加密货币实时流 | Binance WebSocket | 默认启动 BTCUSDT、ETHUSDT、SOLUSDT |
| 美股、ETF、指数 | Yahoo Finance chart API | 支持 SPY、QQQ、AAPL、^GSPC 等代码；无需 API key，但会限流 |
| 标的搜索 | Yahoo Finance search API | 供前端标的选择器使用 |
| 期权链、希腊字母、账户持仓 | moomoo OpenD | 需要本机安装并登录 OpenD；Python sidecar 监听 `127.0.0.1:8788` |

周期由 `qcore::Interval` 定义：`1m`、`5m`、`15m`、`30m`、`1h`、`2h`、`4h`、`1d`、`1w`、`1M`。

已知限制：

- Yahoo Finance 的股票数据不支持 `2h` 和 `4h`，前端会回退到 `1h` 或 `1d`。
- Yahoo 盘中历史深度有限：`1m` 约 7 天，`5m`、`15m`、`30m` 约 60 天，`1h` 约 2 年。
- 股票数据没有 taker buy volume，订单流不平衡类因子会退化为中性近似。
- moomoo/OpenD 只用于本地模拟账户视图和期权快照接入；项目默认不会下真实订单。

## 快速开始

依赖：

- Rust stable toolchain
- Node.js 18+
- Python 3.10+，仅 moomoo bridge 和期权 sidecar 需要

```bash
# 后端 API，监听 :8787
cd engine
cargo run --release -p server

# 前端，监听 :5173；端口被占用时 Vite 会自动选择其他端口
cd ../web
npm install
npm run dev
```

打开 Vite 输出的本地地址。开发服务器会把 `/api` 和 `/ws` 代理到 `http://localhost:8787`。

## 配置

新的配置变量统一使用 `QT_*` 前缀。为了兼容旧的本地部署，代码在没有设置 `QT_*` 时仍会回退读取同名 `QHH_*` 变量。新部署建议只使用 `QT_*`。

常用变量：

| 变量 | 默认值 | 用途 |
|---|---:|---|
| `QT_DATA_DIR` | `data` | 后端数据目录，相对 `engine/` 工作目录 |
| `QT_AUTOSWEEP_HOURS` | `24` | 全宇宙自动进化扫描周期；`0` 表示关闭 |
| `QT_AUTORETRAIN_HOURS` | `6` | 单标的自动再训练周期；`0` 表示关闭 |
| `QT_AUTORETRAIN_SYMBOL` | `BTCUSDT` | 自动再训练标的 |
| `QT_AUTORETRAIN_INTERVAL` | `4h` | 自动再训练周期 |
| `QT_AUTORETRAIN_DAYS` | `730` | 自动再训练历史窗口 |
| `QT_MAX_DD` | `0.15` | 组合模拟盘最大回撤熔断阈值 |
| `QT_INTRADAY_MINUTES` | `30` | 盘中再决策周期；`0` 表示关闭 |
| `QT_STOCK_LONG_ONLY` | `1` | 股票策略是否禁止做空 |
| `QT_GROSS_CAP` | `1.0` | 组合总杠杆上限 |
| `QT_VOL_TARGET` | `0.15` | 组合目标年化波动率 |
| `QT_STOCK_FEE` | `0.00002` | 股票单边费率假设 |
| `QT_STOCK_SLIPPAGE` | `0.0003` | 股票滑点假设 |
| `QT_API` | `http://localhost:8787` | Python sidecar 访问 Rust API 的地址 |

示例配置见 [.env.example](.env.example)。

## moomoo / OpenD Sidecar

期权分析和 moomoo 模拟账户面板需要本机 OpenD：

```bash
pip install futu-api requests

# 期权链、期权模拟账户、moomoo 账户面板
python3 bridge/options_service.py

# 可选：把 QuantTaurus 的股票目标仓位同步到 moomoo 模拟账户
python3 bridge/moomoo_bridge.py --dry-run --once
python3 bridge/moomoo_bridge.py
```

OpenD 默认监听 `127.0.0.1:11111`。前端开发服务器已经把 `/opt-api` 代理到 `127.0.0.1:8788`。

## macOS 部署

先编译后端 release 二进制：

```bash
cd engine
cargo build --release -p server
```

从仓库根目录安装 launchd 服务，并用当前仓库路径替换 plist 占位符：

```bash
ROOT="$(pwd)"
sed "s#__QUANTTAURUS_ROOT__#$ROOT#g" deploy/com.quanttaurus.server.plist \
  > ~/Library/LaunchAgents/com.quanttaurus.server.plist
launchctl load ~/Library/LaunchAgents/com.quanttaurus.server.plist
```

日志默认写入 `/tmp/qt-server.log`。如果要部署 collector，对 `deploy/com.quanttaurus.collector.plist` 使用同样的占位符替换流程。

## 策略自迭代机制

1. 散布折验证：验证折分散在留出窗口之前的历史中，候选必须跨多个市场状态稳定。
2. 进化搜索：多个策略家族通过 `(mu+lambda)` 流程搜索参数空间。
3. Ensemble 挑战者：跨家族 top 候选组合后，与最佳单点候选竞争。
4. 冠军-挑战者晋升：挑战者必须在未参与搜索的留出窗口上超过现任冠军，并且留出 Sharpe 必须为正。
5. 自动再训练和扫描：通过 `QT_AUTORETRAIN_*` 和 `QT_AUTOSWEEP_HOURS` 控制。

## 研究参考

- Moskowitz, Ooi & Pedersen (2012), *Time Series Momentum*
- Moreira & Muir (2017), *Volatility-Managed Portfolios*
- Cont, Kukanov & Stoikov (2014), *The Price Impact of Order Book Events*
- Bailey & Lopez de Prado (2014), *The Deflated Sharpe Ratio*
- Lopez de Prado (2018), Purged Walk-Forward / CPCV
- Liu, Tsyvinski & Wu (2022), *Common Risk Factors in Cryptocurrency*
