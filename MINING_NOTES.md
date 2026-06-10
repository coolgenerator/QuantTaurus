# 因子挖掘 agentic 回路笔记（每轮 loop 由 Claude 读取/追加）

## Run 1 — 2026-06-10 02:1x（首次，默认配置）

- 面板: 50 标的 × 2513 日；pop150×gen25=2025 evals；horizon=5d
- 入库: `-1 * (open * ts_rank(open, 42))` 搜索|IC| .032 / ICIR 1.15 / 留出 .0315 ✅
- 观察:
  1. 只有 1 个因子过了贪心选择——redundancy/正适应度过滤偏严，
     大量候选 adj fitness ≤0 被剔
  2. 进化在 ~20 代收敛，后 5 代无改进 → 种群多样性不足
  3. 选出的因子用了 raw price level (open)，cs_zscore 部分消化了量纲，
     但混入了"价格水平"倾斜——下轮考虑对 leaf 做预标准化变体

## 下轮假设（agentic 提议，Run 2 执行）

- [ ] horizon=10/21 各跑一轮（不同预测期挖不同信号源）
- [ ] 种子补充: 量价相关 ts_corr 类（需新增算子）、缺口反转 (open/close[-1])、
      vol-adjusted momentum (mom/ts_std)
- [ ] redundancy 阈值 0.7→0.8，top_k 5→8，提高入库多样性
- [ ] seed 多换几个（7/13/99）对比挖掘稳定性
