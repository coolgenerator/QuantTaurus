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
- [x] P8a 多折验证适应度（CPCV-lite：3折，fitness = 折均值 - 0.75×折标准差）
- [x] P8b 4h 周期 BTC/ETH 实验（见下方发现）
- [x] P8c 自动再训练调度器（QHH_AUTORETRAIN_HOURS 默认6h，0=关；SYMBOL/INTERVAL/DAYS 可配）
- [x] P8d 晋升绝对底线 promotion_floor（留出 Sharpe ≤0 永不晋升，宁缺毋滥；champion.json 已清空重置）
- [x] P9 策略质量迭代完成：
      a. 折散布全历史（evolve v3）：4h 高 Sharpe 幻象消失（折均值跌到 ~0.5），
         证明之前是 regime 拟合 → 4h 在 0.15% 成本下无净边际
      b. Ensemble 冠军（StrategySpec::Ensemble，top-k 跨家族等权）
      c. 1d 实验（4 年、3 标的）：✅ SOLUSDT 1d ensemble 通过全部闸门晋升
         （4折全正 [0.62,1.65,1.63,0.51]，holdout Sharpe +0.48 / 年化+26%）
         BTC -0.06 / ETH -0.31 接近但未达 floor，未晋升（正确）
      d. 前端展示 fold_sharpes 徽章
- [x] P10 实盘模拟（paper trading）：后端引擎（mark-to-market + 周期调仓 +
      冠军热更新）+ 前端 PaperPanel，已验证 WS 推送
- [x] P10.5 美股支持（用户要求）：Yahoo 数据源、252 交易日年化、低佣金成本、
      前端分组选择器。实验：SPY ensemble 留出 Sharpe 1.59 晋升 ✅，
      QQQ vol-managed 0.52 晋升 ✅ —— 股票边际显著好于加密
- [ ] P11 多槽冠军注册表（急迫：QQQ 晋升把 SPY/SOL 冠军顶掉了——
      champion.json 改为 {"SPY|1d": {...}, "QQQ|1d": {...}} 映射，
      /api/champion 返回全部，paper 引擎每个冠军各开一个会话）
- [x] P11 多槽冠军注册表 + 前端多会话 PaperPanel + ChampionRegistry 面板
      （注册表现有 SPY|1d 1.59 / QQQ|1d 0.52 / SOLUSDT|1d 0.48 三冠军并行模拟盘）
- [x] P11.5 板块模块（用户要求）：33 股票×6 产业板块（科技/芯片/内存/AI基建/
      设备/电力），sectors.rs 横截面动量轮动信号（rel+accel+breadth z合成），
      /api/sectors 10min 缓存；TopBar 股票按板块分组；SectorPanel 前端
      （agent 构建中：排行榜+热力格+联动主图）
- [x] P12 美股盘中报价轮询（15s，仅模拟盘股票，盘外静默）
- [x] P13a 热门个股实验：NVDA(holdout 0.37/DSR 0.94)、MU ensemble(2.24)、
      AMD(1.48) 全部晋升 → 注册表 6 冠军并行模拟盘
- [x] P15 moomoo 集成（用户要求）：成本模型 moomoo 口径、OpenD 已安装登录、
      下单桥接器 bridge/moomoo_bridge.py（待用户 dry-run 验证）
- [x] P16 模拟盘持久化（重启不清零，已实测）+ Market Feed 标题澄清
- [x] P17 期权分析（用户要求）：bridge/options_service.py（OpenD期权链+
      PCR/MaxPain/ATM IV/25Δ偏度，8788端口，120s缓存）+ 前端期权Tab
      （IV微笑/OI分布/T型报价）+ 顶层Tab导航
- [x] P18 短线成本回测：CostModel min_fee_usd/capital_usd + 前端成本预设
- [ ] P13b 打磨：lint 基线清理、回测报告导出
- [ ] P14 可选：VIX regime 过滤因子、SectorPanel 一键进化按钮、
      期权服务 launchd 自启、期权策略回测引擎（大工程，需单独设计）

## 运行中的进程清单（重启机器后需手动拉起，或装 launchd）

- engine/target/release/server（:8787）
- web: npm run dev（:5174）
- bridge/options_service.py（:8788，需 OpenD 已登录）
- /Applications/moomoo_OpenD.app（:11111，需手动登录）
- bridge/moomoo_bridge.py（可选，同步 moomoo 模拟盘）

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
- 2026-06-09 23:3x: P8a-d 完成。4h 多折实验（BTC/ETH 各 600 evals）：
  - 折间 Sharpe 已稳定为正（BTC [3.34,1.18,3.64]，ETH [2.41,3.28,2.87]）
    但留出 45 天仍为负（-2.57/-1.70）→ 是 regime shift 不是工具 bug。
  - 结论：2 年数据 + 相邻折不足以泛化到最新行情，P9a-d 是对策。
  - 实验产物：/tmp/qhh-evolve-{BTCUSDT,ETHUSDT}-4h.json
  - 服务运行中：release server :8787（auto-retrain 6h），Vite dev :5174

## 约定

- Rust 需 `source $HOME/.cargo/env`
- 数据缓存在 `engine/data/`（gitignore）
- 每完成一个阶段：更新本文件勾选 + git commit
