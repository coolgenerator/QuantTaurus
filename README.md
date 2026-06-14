# QuantTaurus — 全栈量化研究与模拟交易平台

QuantTaurus 是一个本地运行的量化研究平台：Rust 核心引擎负责数据缓存、因子计算、回测、策略进化和模拟盘；React 前端负责实时图表、因子面板、回测面板、冠军注册表、交易计划和持仓视图。

> 仅供研究和模拟交易使用，不是投资建议，也不是完整实盘风控系统。

## 架构

```text
web/                       React + TS + Vite + Tailwind
  实时K线 · 技术分析 · 因子实验 · 回测 · 进化任务 · 模拟盘
      │ REST + WebSocket
engine/                    Rust workspace
  crates/core              共享类型：Kline、Signal、MarketEvent、指标
  crates/data              Binance/Yahoo 数据客户端 + 本地缓存
  crates/factors           动量、反转、波动率、技术规则、横截面因子
  crates/backtest          事件驱动回测：成本、滑点、净值曲线
  crates/strategy          策略定义和参数空间
  crates/evolve            walk-forward 验证、进化搜索、冠军挑战者
  crates/mine              表达式因子挖掘
  crates/server            axum API、WS 推送、自动扫描、模拟盘
bridge/                    moomoo/OpenD Python sidecar
```

本地状态默认写入 `engine/data/`，包括 K 线缓存、冠军注册表、模拟盘状态和风控标记。该目录已在 `.gitignore` 中排除。

## 支持的数据

| 资产/功能 | 数据源 | 说明 |
|---|---|---|
| 加密货币 K 线 | Binance public market data mirror | 使用 `data-api.binance.vision` 和 `data-stream.binance.vision`，无需 API key |
| 加密货币实时流 | Binance WebSocket | 默认启动 BTCUSDT、ETHUSDT、SOLUSDT 实时流 |
| 美股/ETF/指数 K 线 | Yahoo Finance chart API | 支持如 SPY、QQQ、AAPL、^GSPC；无需 API key，但会限流 |
| 股票搜索 | Yahoo Finance search API | 前端 SymbolPicker 使用 |
| 期权链/希腊字母/账户持仓 | moomoo OpenD | 需要本机安装并登录 OpenD，Python sidecar 监听 `127.0.0.1:8788` |

周期支持来自 `qcore::Interval`：`1m`、`5m`、`15m`、`30m`、`1h`、`2h`、`4h`、`1d`、`1w`、`1M`。限制：

- Yahoo 股票数据不支持 `2h`/`4h`，前端会回退到 `1h` 或 `1d`。
- Yahoo 盘中历史深度有限：`1m` 约 7 天，`5m`/`15m`/`30m` 约 60 天，`1h` 约 2 年。
- 股票没有 taker buy volume，订单流不平衡类因子会退化。
- moomoo/OpenD 只用于本地模拟账户和期权快照接入；项目默认不自动下真实订单。

## 快速开始

依赖：

- Rust stable toolchain
- Node.js 18+
- Python 3.10+（仅 moomoo bridge/期权 sidecar 需要）

```bash
# 后端 API，监听 :8787
cd engine
cargo run --release -p server

# 前端，监听 :5173；若端口被占用，Vite 会自动换端口
cd ../web
npm install
npm run dev
```

打开 Vite 输出的本地地址。前端会把 `/api` 和 `/ws` 代理到 `http://localhost:8787`。

## 配置

新配置前缀统一为 `QT_*`。为兼容旧本地部署，代码仍会在未设置 `QT_*` 时回退读取同名 `QHH_*` 变量。建议新部署只使用 `QT_*`。

常用变量：

| 变量 | 默认值 | 用途 |
|---|---:|---|
| `QT_DATA_DIR` | `data` | 后端数据目录，相对 `engine/` 工作目录 |
| `QT_AUTOSWEEP_HOURS` | `24` | 全宇宙自动进化扫描周期；`0` 关闭 |
| `QT_AUTORETRAIN_HOURS` | `6` | 单标的自动再训练周期；`0` 关闭 |
| `QT_AUTORETRAIN_SYMBOL` | `BTCUSDT` | 自动再训练标的 |
| `QT_AUTORETRAIN_INTERVAL` | `4h` | 自动再训练周期 |
| `QT_AUTORETRAIN_DAYS` | `730` | 自动再训练历史窗口 |
| `QT_MAX_DD` | `0.15` | 组合模拟盘最大回撤熔断 |
| `QT_INTRADAY_MINUTES` | `30` | 盘中再决策周期；`0` 关闭 |
| `QT_STOCK_LONG_ONLY` | `1` | 股票策略是否禁止做空 |
| `QT_GROSS_CAP` | `1.0` | 组合总杠杆上限 |
| `QT_VOL_TARGET` | `0.15` | 组合目标年化波动率 |
| `QT_STOCK_FEE` | `0.00002` | 股票单边费率假设 |
| `QT_STOCK_SLIPPAGE` | `0.0003` | 股票滑点假设 |
| `QT_API` | `http://localhost:8787` | Python bridge 访问 Rust API 的地址 |

示例配置见 [.env.example](.env.example)。

## moomoo/OpenD Sidecar

期权分析和 moomoo 模拟账户面板需要本机 OpenD：

```bash
pip install futu-api requests

# 期权链、期权模拟盘、moomoo 账户面板
python3 bridge/options_service.py

# 可选：把 QuantTaurus 的股票目标仓位同步到 moomoo 模拟账户
python3 bridge/moomoo_bridge.py --dry-run --once
python3 bridge/moomoo_bridge.py
```

OpenD 默认监听 `127.0.0.1:11111`。前端 dev server 已配置 `/opt-api` 代理到 `127.0.0.1:8788`。

## macOS 部署

后端可先编译 release 二进制：

```bash
cd engine
cargo build --release -p server
```

从仓库根目录安装 launchd 服务，用当前仓库路径替换 plist 占位符：

```bash
ROOT="$(pwd)"
sed "s#__QUANTTAURUS_ROOT__#$ROOT#g" deploy/com.quanttaurus.server.plist \
  > ~/Library/LaunchAgents/com.quanttaurus.server.plist
launchctl load ~/Library/LaunchAgents/com.quanttaurus.server.plist
```

日志默认写到 `/tmp/qt-server.log`。如果要部署 collector，同样处理 `deploy/com.quanttaurus.collector.plist`。

## 策略自迭代机制

1. 散布折验证：验证折均匀散布在留出窗之前的历史中，候选必须跨牛/熊/震荡都稳定。
2. 进化搜索：对多个策略家族的参数空间做 `(mu+lambda)` 搜索。
3. Ensemble 挑战者：top-k 跨家族候选等权组合，与单点最优竞争。
4. 冠军-挑战者晋升：挑战者必须在未参与搜索的留出窗上超过现任冠军，并且留出 Sharpe 必须为正。
5. 自动再训练/扫描：通过 `QT_AUTORETRAIN_*` 和 `QT_AUTOSWEEP_HOURS` 控制。

## 研究参考

- Moskowitz, Ooi & Pedersen (2012), *Time Series Momentum*
- Moreira & Muir (2017), *Volatility-Managed Portfolios*
- Cont, Kukanov & Stoikov (2014), *The Price Impact of Order Book Events*
- Bailey & Lopez de Prado (2014), *The Deflated Sharpe Ratio*
- Lopez de Prado (2018), Purged Walk-Forward / CPCV
- Liu, Tsyvinski & Wu (2022), *Common Risk Factors in Cryptocurrency*
