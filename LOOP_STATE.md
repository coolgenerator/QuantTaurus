# Loop 迭代状态（供 /loop 每次唤醒时读取）

## 模型评估 loop（2026-06-10 04:1x 首轮基线，后续唤醒对比这些数字）

- 股票冠军 holdout Sharpe：SPY 1.59 / MU 2.24 / AMD 1.48 / QQQ 0.52 / SOL 0.48 / NVDA 0.37
- 全样本4年（含训练期，偏乐观）：SPY S1.67/年化8.8%/DD4.0%；NVDA S1.42/11.3%/4.6%；
  MU S0.89/17.4%/DD38.6%；SOL S1.04/76%/DD48%
- 期权回测（合成BS）：冠军信号直搬期权 Sharpe -0.34~0.66、MaxDD 37-62%、胜率~30% → 日线信号买单腿吃theta，不及格
- 单形态实验：纯布林超跌反弹期权 QQQ S0.90/年化33% ✅、SPY 0.33；NVDA -1.11 / AMD -0.35 ❌
  → 均值回归形态只在指数上成立，个股动量主导
- 开盘诱多/诱空：1m库存仅7个交易日（14.2万根/52标的），样本不足以回测开盘形态；需≥1年积累
- 模拟盘 2026-06-10 重启，equity=1.0，前向战绩从零起算 —— 后续唤醒检查 /api/paper 漂移
- 下轮可做：① 指数reversion期权形态做成独立策略家族进evolve闸门 ② 期权改价差结构降theta ③ 检查模拟盘 vs 回测一致性

### Round 2 — 2026-06-10 04:5x（QQQ反弹形态稳健性审查 → 降级）

- 参数邻域网格 16组（w∈{15,20,24,30}×z∈{1.0,1.2,1.5,2.0}, exit_z=0.1）：
  正Sharpe仅 7/16，中位数 0.00；z1.0 全负，z2.0 零交易，甜区窄（w20-30×z1.2-1.5）
- exit_z 敏感性：0.07→0.1 就把 w24/z1.2 从 Sharpe 0.90 打到 0.29 —— 参数脆弱，疑似过拟合
- 时间切片（原参数）：4年 0.90 / 近2年 0.84 —— 时间维度倒是稳定
- **结论降级**：QQQ反弹期权"可研究、不可直接交易"；必须走 evolve 闸门（多折+留出）选参，
  不能用手挑参数。最稳健的邻域点是 w30/z1.5（Sharpe 1.10, DD 10.6%, 但仅17笔样本不足）
- 模拟盘漂移：美股5会话 equity=1.0000 未动（盘前）；SOLUSDT 1.0195（空仓盈利中）
- 下轮：① 美股开盘后（06:30 PDT）复查模拟盘首日表现 ② 若推进期权形态：写 reversion-only
  策略家族进 evolve，或先验证股票端纯反弹信号的多折表现

### Round 3 — 2026-06-10 05:5x（股票端反弹信号散布折验证 → QQQ只多形态过闸）

- evolve 不支持限定单家族（EvolveConfig 无 families 字段；加功能=改引擎，留待用户拍板）
- 改用 Python 精确复刻 bollinger_reversion（注意 bollinger_z 是 2σ 标准化）做4折+留出90d：
  - **QQQ w24/z1.2 只多: 折 [0.23, 3.12, 1.34, 1.53] 全正 | 留出 3.57 | 全样本 1.66，在场仅31%** ✅
  - QQQ 多空版折 [0.63,0.49,1.24,1.90] 弱于只多 → 做空超买（诱空腿）是拖累，砍掉
  - SPY 留出 -0.04 未过底线 ❌；w30/z1.5 在场仅2-3%样本不足
- 结论回升：「指数超跌只做多」单形态在 QQQ 股票端结构性成立（全折正+留出正+低暴露），
  期权表达=只买 QQQ call（对应期权回测 S0.90/年化33%）。仓位要小：参数源于SPY冠军搜索
  （轻度污染）+ 合成期权定价偏乐观。开盘诱多/诱空仍受限于1m数据仅7天，不可回测
- 下轮：开盘后首查 6 会话模拟盘首日实盘表现 vs 回测预期

### Round 4 — 2026-06-10 06:4x（开盘后首查：科技股下杀日，实现一致性 ✓）

- 开盘9分钟，科技普跌（QQQ -1.6%，AMD -3.8%，MU -3.9%）。6会话首日：
  QQQ -0.68% / MU -0.64% / AMD -0.60% / SPY -0.40% / NVDA -0.15% / SOL -0.12%（空仓回吐）
- **实现一致性检验通过**：各会话亏损 ≈ position × 标的跌幅（QQQ 0.424×-1.6%≈-0.68% ✓，
  SOL -0.854×+2.4%≈-2.05%，1.0195→0.9988 ✓）——模拟盘记账与信号执行无偏差
- 组合均值净值 -0.43%，距 15% 熔断线很远
- **QQQ 布林z = -0.49**（触发超跌买入需 < -1.20）：今日下杀正把形态推向触发区，
  若再跌 ~3-4% 将出现 Round 3 验证过的「超跌只多」入场信号 —— 持续盯
- 下轮：盘中复查漂移 + z 值；若 z 接近 -1.2 提示用户期权入场窗口

### Round 5 — 2026-06-10 07:1x（盘中复查：小幅回血，信号距离尚远）

- 开盘41分钟，QQQ 704.6→707.45 回血：6会话回撤收窄（QQQ -0.51%，SPY -0.23%，组合均值≈-0.39%）
- QQQ 盘中 z = -0.41，**触发价 ≈ 678（还需再跌 4.2%）**——非一日内大概率事件，降低盯盘频率
- 下轮：1小时心跳；若 z < -0.9（价 < ~690）改回30分钟密集盯

### Round 6 — 2026-06-10 08:1x（下杀重启 z=-0.65；开盘诱多/诱空基础赔率＝无朴素优势）

- 抛售重启：QQQ 699.42（z -0.41→**-0.65**），组合均值 -0.60%（AMD -1.06% 最深）；SOL空仓转正+0.40%
- 开盘形态描述性统计（8天×52标的，329个有效symbol-day，首30分钟|动|>0.2%）：
  **反转46% vs 延续54%**，幅度对称（2.17% vs 2.41%）；冲高回落45%、杀跌反弹46%
  → 朴素"逢开盘方向反着做"无基础赔率优势，若有edge必须来自条件化（缺口大小/盘前量/关键位），
    且本周期全是下跌行情（214杀跌 vs 115冲高），样本有强regime偏置。结论：继续攒数据，
    朴素版可以直接排除——这本身就是有价值的负结果
- 下轮：z 在 -0.65 → -0.9 区间移动中，30分钟密集盯
- Round 7（08:4x）：企稳回弹 QQQ 701.67 / z -0.59，组合 -0.70%，无触发无异常 → 回到1h心跳
- Round 8（09:4x）：阴跌继续 QQQ 698.57 / z -0.68（距触发仍~3%），组合 -0.68% 稳定，SOL空+0.24% → 维持1h

- Round 9（11:2x，用户重启loop）：QQQ 699.29 / z -0.66 横住未触发；组合 -0.51%（SOL空+1.01%）。
  新TA端点显示：日线趋势仍=多头（价>MA200），06-04 曾有 MACD死叉+KDJ高位死叉共振卖点——
  在本周下杀前出现，经典共振信号首个前向样本方向正确 → 1h心跳
- Round 10（10:5x-11:0x）：QQQ 699.68 / **z 跌深至 -0.838**（-0.66→-0.84，进入 -0.65～-0.9
  过渡带，距 -1.20 触发还差约 2% 下跌）；组合均值 -0.48% 稳定（SOL空 +1.15% 唯一正贡献，
  AMD -1.03% 最深）。无熔断风险。→ 按 Round 5 规则切 30 分钟密集盯，z 破 -0.9 后提示
  期权入场窗口临近（只买 QQQ call，Round 3 验证过的超跌只多形态）

## P20 技术面策略落地 loop（用户 2026-06-10 11:1x 新指令：列全集→逐批落地）

- 全集清单 docs/ta-strategy-catalog.md（A-G 七类 ~35 个策略，含落地批次规划）
- [x] 批次1（用户点名）：神奇九转 TD9 九买九卖 + MACD/RSI 顶底背离（pivot k=4 确认制，
      无重绘）。SPY 冒烟：130 经典信号，九卖16/九买3/MACD顶背离7/RSI顶背离8；
      **06-08 出现 MACD+RSI 双顶背离共振卖点——本周下杀前两天，前向首样本方向正确**
- [x] 批次2：均线金叉死叉(20/50) + 多头/空头排列翻转点 + 唐奇安20日突破(10根冷却) +
      放量突破(量>2×20日均量)。SPY 2年：167经典信号，上破23/金叉4/排列3/放量破位1
- [x] 批次3：K线形态族（看涨/看跌吞没、锤子/上吊、流星/倒锤、启明星/黄昏星、
      红三兵/三只乌鸦、高低位十字星），全部带 MA20 趋势背景过滤。
      SPY 2年45个形态信号（~2/月）、NVDA 95个（高波动多十字星）
- [x] 批次4：双顶双底（±2%等高+颈线破位确认）/ 头肩顶底（头超肩1.5%+双肩±3%）。
      SPY 2年26个结构信号；**SPY 06-10 当天触发双顶颈线破位卖点**（顶1≈顶2≈739，
      颈线在本周破位）——与本周下杀互相印证，又一个方向正确的前向样本
- [ ] 批次5（可选）：SuperTrend / ADX / Ichimoku 副图
- 注意：经典信号未经回测闸门，前端已声明；后续可逐条送 evolve 验证

## P19 技术分析Tab（用户要求，2026-06-10 完成 ✅ commit 3dfe889）

- factors 新增 sma/kdj/macd_full；server 新增 ta.rs + GET /api/ta；
  前端 TechPanel 四图联动 + 双层买卖点标注（经典▲▼ / 冠军◉）+ 趋势色带 + 顶层Tab
- 设计文档 docs/superpowers/specs/2026-06-10-tech-analysis-tab-design.md（用户批准过）
- 验收全过：cargo test 9绿 / npm build 零错误 / SPY冒烟 107经典+25冠军信号
- release server 已重启加载新端点（模拟盘状态持久化未受影响）

## 当前主线：因子挖掘框架（用户 2026-06-10 新指令"全都要"）

- [x] F1-F7 全部完成（2026-06-10 02:4x）：
      qmine 引擎 / 50股×10年面板 / 因子库2条（h5反转+h21位移溢价）/
      双因子组合留出 Sharpe 1.57（⚠️含selection-on-holdout乐观偏差，见MINING_NOTES）/
      预测端点 / 因子实验室Tab / agentic笔记已跑3轮假设
- [ ] F8 嵌套划分改造（留出只看一次）+ 因子组合接模拟盘做前向真验证
- [ ] F9 持续 agentic 挖掘节奏：每轮 loop 按 MINING_NOTES 假设跑新批次

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
