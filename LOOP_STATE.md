# Loop 迭代状态（供 /loop 每次唤醒时读取）

任务：量化交易全栈 web 应用（数据采集/因子/策略/回测/炫酷前端/自迭代机制）

## 阶段计划与状态

- [x] P0 环境：安装 Rust 工具链、git init、架构文档
- [x] P1 core + data crate：Binance 历史K线下载 + WS 实时流，落盘缓存
- [x] P2 factors crate：动量/反转/波动率/RSI/MACD/OFI 等因子（4 单测通过）
- [x] P3 backtest crate：事件驱动回测（手续费+滑点+next-bar 成交防前视），Sharpe/Sortino/MaxDD/Calmar/DSR（4 单测通过）
- [x] P4 strategy + evolve：4 策略家族 + walk-forward (μ+λ) 进化 + 冠军挑战者（已在真实 BTC 1h 数据上验证：72 evals，valid Sharpe 1.22→1.66，冠军持久化到 data/champion.json）
- [x] P5 server crate：axum REST（/klines /factors /backtest /evolve /champion）+ WS（/ws 实时行情+进化事件）— 全部端点已冒烟测试通过
- [x] P6 web 前端：React+Vite+Tailwind+lightweight-charts 暗色霓虹仪表盘，build 零错误（commit 5e5198b）
- [x] P7 集成联调：Vite 代理验证通过（注意：本机 5173 被其他项目占用，我们的前端在 **5174**）；2年BTC 1h 全量进化（600 evals）端到端跑通
- [ ] P8 策略质量迭代（当前冠军留出 Sharpe 为负，需改进）：
      a. 适应度改为多折验证（CPCV-lite：≥3 个不重叠验证窗的平均/最差 Sharpe）+ 换手惩罚
      b. 尝试 4h / 1d 周期（噪声小、成本拖累低）与 ETHUSDT/SOLUSDT 多标的稳健性筛选
      c. server 内置自动再训练调度器（每N小时自动重跑进化）
- [ ] P9 打磨：README 完善、回测报告导出

## 当前进度备注

- 2026-06-09 22:2x: rustup 1.96.0 安装完成。Node v25.4.0。
- 2026-06-09 23:0x: 后端 6 crate 全部完成，11 单测通过。
  - 重要：api.binance.com 在本机返回 451（地域限制），已切换到镜像
    data-api.binance.vision / data-stream.binance.vision
  - 冒烟测试：/api/klines 拉到真实 BTC 数据；/api/backtest 正常；/api/evolve
    小配置（pop8/off16/gen4）全流程跑通，promoted=true
  - 调试用 server 进程可能仍在运行（端口 8787，日志 /tmp/qhh-server.log）
  - 前端由后台 agent 构建中（Vite+React+TS+Tailwind+lightweight-charts）
- 2026-06-09 23:1x: 前端完成并 commit。release server 运行中（8787），Vite dev 在 5174。
  - 全量进化（BTCUSDT 1h 730d，600 evals）：挑战者 valid Sharpe 2.25 但
    holdout 不达标 → 正确拒绝晋升。说明 1h 单标的 + 单验证窗易过拟合，
    P8a/P8b 是下一步重点。
  - 经验：单验证窗的 (μ+λ) 搜索会把 valid 窗也"用旧"——fitness 必须多折。

## 约定

- Rust 需 `source $HOME/.cargo/env`
- 数据缓存在 `engine/data/`（gitignore）
- 每完成一个阶段：更新本文件勾选 + git commit
