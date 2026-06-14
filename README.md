# QuantTaurus - Quant Research and Paper-Trading Platform

[Chinese](README.zh-CN.md)

QuantTaurus is a local-first quant research platform. The Rust engine handles market data caching, factor calculation, backtesting, strategy evolution, and paper trading. The React dashboard provides charts, factor research panels, backtest results, champion strategy tracking, trade plans, and portfolio views.

> Research and paper trading only. This project is not investment advice and is not a complete production trading risk system.

## Architecture

```text
web/                       React + TypeScript + Vite + Tailwind
  Charts, technical analysis, factor lab, backtests, evolution jobs, paper trading
      | REST + WebSocket
engine/                    Rust workspace
  crates/core              Shared types: Kline, Signal, MarketEvent, metrics
  crates/data              Binance/Yahoo data clients and local cache
  crates/factors           Momentum, reversal, volatility, TA rules, cross-sectional factors
  crates/backtest          Event-driven backtesting with fees, slippage, and equity curves
  crates/strategy          Strategy definitions and parameter spaces
  crates/evolve            Walk-forward validation, evolutionary search, champion/challenger flow
  crates/mine              Expression-based factor mining
  crates/server            axum API, WebSocket streaming, auto sweeps, paper engine
bridge/                    Python sidecars for moomoo/OpenD integration
```

Local runtime state is stored in `engine/data/` by default. This includes kline caches, champion registries, paper-trading state, and risk-halt markers. The directory is excluded from Git.

## Supported Data

| Asset / feature | Source | Notes |
|---|---|---|
| Crypto klines | Binance public market data mirror | Uses `data-api.binance.vision` and `data-stream.binance.vision`; no API key required |
| Crypto live stream | Binance WebSocket | Starts BTCUSDT, ETHUSDT, and SOLUSDT by default |
| US stocks, ETFs, indexes | Yahoo Finance chart API | Supports symbols such as SPY, QQQ, AAPL, and ^GSPC; no API key required, but rate-limited |
| Symbol search | Yahoo Finance search API | Used by the frontend symbol picker |
| Options chain, Greeks, account positions | moomoo OpenD | Requires a local logged-in OpenD instance; the Python sidecar listens on `127.0.0.1:8788` |

Intervals are defined by `qcore::Interval`: `1m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `1d`, `1w`, and `1M`.

Known limits:

- Yahoo Finance does not support `2h` or `4h` for stocks. The frontend falls back to `1h` or `1d`.
- Yahoo intraday history is limited: `1m` is about 7 days, `5m`/`15m`/`30m` about 60 days, and `1h` about 2 years.
- Stocks do not include taker-buy volume, so order-flow imbalance factors degrade to a neutral proxy.
- moomoo/OpenD integration is for local simulated-account views and options snapshots. The project does not place real orders by default.

## Quick Start

Requirements:

- Rust stable toolchain
- Node.js 18+
- Python 3.10+ only for the moomoo bridge and options sidecar

```bash
# Backend API on :8787
cd engine
cargo run --release -p server

# Frontend on :5173; Vite will pick another port if needed
cd ../web
npm install
npm run dev
```

Open the local URL printed by Vite. The dev server proxies `/api` and `/ws` to `http://localhost:8787`.

## Configuration

New configuration variables use the `QT_*` prefix. For compatibility with older local deployments, the code still falls back to matching `QHH_*` variables when `QT_*` is unset. New deployments should use `QT_*`.

Common variables:

| Variable | Default | Purpose |
|---|---:|---|
| `QT_DATA_DIR` | `data` | Backend data directory, relative to the `engine/` working directory |
| `QT_AUTOSWEEP_HOURS` | `24` | Full-universe evolution sweep interval; `0` disables it |
| `QT_AUTORETRAIN_HOURS` | `6` | Single-symbol auto-retrain interval; `0` disables it |
| `QT_AUTORETRAIN_SYMBOL` | `BTCUSDT` | Auto-retrain symbol |
| `QT_AUTORETRAIN_INTERVAL` | `4h` | Auto-retrain interval |
| `QT_AUTORETRAIN_DAYS` | `730` | Auto-retrain history window |
| `QT_MAX_DD` | `0.15` | Portfolio paper-trading max drawdown kill switch |
| `QT_INTRADAY_MINUTES` | `30` | Intraday decision interval; `0` disables it |
| `QT_STOCK_LONG_ONLY` | `1` | Whether stock strategies are long-only |
| `QT_GROSS_CAP` | `1.0` | Portfolio gross leverage cap |
| `QT_VOL_TARGET` | `0.15` | Portfolio target annualized volatility |
| `QT_STOCK_FEE` | `0.00002` | Stock one-way fee assumption |
| `QT_STOCK_SLIPPAGE` | `0.0003` | Stock slippage assumption |
| `QT_API` | `http://localhost:8787` | Rust API address used by Python sidecars |

See [.env.example](.env.example) for a sample configuration.

## moomoo / OpenD Sidecars

Options analysis and the moomoo simulated-account panel require a local OpenD instance:

```bash
pip install futu-api requests

# Options chain, options paper account, and moomoo account panel
python3 bridge/options_service.py

# Optional: sync QuantTaurus stock target positions to a moomoo simulated account
python3 bridge/moomoo_bridge.py --dry-run --once
python3 bridge/moomoo_bridge.py
```

OpenD listens on `127.0.0.1:11111` by default. The frontend dev server proxies `/opt-api` to `127.0.0.1:8788`.

## macOS Deployment

Build the backend release binary:

```bash
cd engine
cargo build --release -p server
```

From the repository root, install the launchd service by replacing the plist placeholder with the current repository path:

```bash
ROOT="$(pwd)"
sed "s#__QUANTTAURUS_ROOT__#$ROOT#g" deploy/com.quanttaurus.server.plist \
  > ~/Library/LaunchAgents/com.quanttaurus.server.plist
launchctl load ~/Library/LaunchAgents/com.quanttaurus.server.plist
```

Logs go to `/tmp/qt-server.log` by default. Use the same placeholder replacement flow for `deploy/com.quanttaurus.collector.plist` if you want to deploy the collector.

## Strategy Evolution

1. Scattered-fold validation: validation folds are spread across the pre-holdout history so candidates must survive multiple regimes.
2. Evolutionary search: strategy families are searched with a `(mu+lambda)` process.
3. Ensemble challengers: top candidates across families are combined and compared with the best single candidate.
4. Champion/challenger promotion: a challenger must beat the current champion on an untouched holdout window, and holdout Sharpe must be positive.
5. Auto retraining and sweeps: controlled by `QT_AUTORETRAIN_*` and `QT_AUTOSWEEP_HOURS`.

## References

- Moskowitz, Ooi & Pedersen (2012), *Time Series Momentum*
- Moreira & Muir (2017), *Volatility-Managed Portfolios*
- Cont, Kukanov & Stoikov (2014), *The Price Impact of Order Book Events*
- Bailey & Lopez de Prado (2014), *The Deflated Sharpe Ratio*
- Lopez de Prado (2018), Purged Walk-Forward / CPCV
- Liu, Tsyvinski & Wu (2022), *Common Risk Factors in Cryptocurrency*
