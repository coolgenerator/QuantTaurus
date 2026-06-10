# Loop 迭代状态（供 /loop 每次唤醒时读取）

任务：量化交易全栈 web 应用（数据采集/因子/策略/回测/炫酷前端/自迭代机制）

## 阶段计划与状态

- [x] P0 环境：安装 Rust 工具链、git init、架构文档
- [x] P1 core + data crate：Binance 历史K线下载 + WS 实时流，落盘缓存
- [x] P2 factors crate：动量/反转/波动率/RSI/MACD/OFI 等因子（4 单测通过）
- [x] P3 backtest crate：事件驱动回测（手续费+滑点+next-bar 成交防前视），Sharpe/Sortino/MaxDD/Calmar/DSR（4 单测通过）
- [x] P4 strategy + evolve：4 策略家族 + walk-forward (μ+λ) 进化 + 冠军挑战者（已在真实 BTC 1h 数据上验证：72 evals，valid Sharpe 1.22→1.66，冠军持久化到 data/champion.json）
- [x] P5 server crate：axum REST（/klines /factors /backtest /evolve /champion）+ WS（/ws 实时行情+进化事件）— 全部端点已冒烟测试通过
- [ ] P6 web 前端：React+Vite+Tailwind+lightweight-charts（后台 agent 构建中）
- [ ] P7 集成联调：前后端联调，跑大规模进化找到留出集表现好的策略，git commit
- [ ] P8 打磨：自动再训练调度器（新数据到达自动重跑进化）、README 完善

## 当前进度备注

- 2026-06-09 22:2x: rustup 1.96.0 安装完成。Node v25.4.0。
- 2026-06-09 23:0x: 后端 6 crate 全部完成，11 单测通过。
  - 重要：api.binance.com 在本机返回 451（地域限制），已切换到镜像
    data-api.binance.vision / data-stream.binance.vision
  - 冒烟测试：/api/klines 拉到真实 BTC 数据；/api/backtest 正常；/api/evolve
    小配置（pop8/off16/gen4）全流程跑通，promoted=true
  - 调试用 server 进程可能仍在运行（端口 8787，日志 /tmp/qhh-server.log）
  - 前端由后台 agent 构建中（Vite+React+TS+Tailwind+lightweight-charts）

## 约定

- Rust 需 `source $HOME/.cargo/env`
- 数据缓存在 `engine/data/`（gitignore）
- 每完成一个阶段：更新本文件勾选 + git commit
