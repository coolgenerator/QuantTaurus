# 技术分析 Tab 设计（2026-06-10，已获用户批准）

## 目标

新增「技术分析」顶层 Tab：权威技术指标叠加蜡烛图，趋势、买点、卖点直接标注在图上。
双层信号：经典指标规则（教科书口径，未经回测闸门验证，仅供参考）+ 本项目冠军策略
实际信号（evolve 闸门验证过），可分别开关对比。

## 决策记录

- 信号来源：经典指标规则 + 冠军策略信号双层（用户选定）
- 指标集合：权威固定套餐——主图 MA20/50/200、EMA12/26、布林带(20,2σ)；
  副图 MACD(12,26,9)、RSI14、KDJ(9,3,3)、成交量（用户选定）
- 位置：新建顶层 Tab，与现有 Tab 导航一致（用户选定）
- 计算位置：后端 Rust 统一计算（方案 A）——指标数学只存在一份、与回测同源；
  前端只渲染。否决 B（前端 TS 重写一遍数学，必然漂移）和 C（混合，双口径）。

## 后端

1. `factors` crate 新增算子（各带单测）：
   - `sma(klines, n)`：滚动均线
   - `kdj(klines, 9, 3, 3)`：RSV=(C-LLV)/(HHV-LLV)×100；K/D 递推(2/3,1/3)；J=3K-2D；初值 50
   - `macd_full(klines, 12, 26, 9)`：返回 (DIF, DEA, HIST=DIF-DEA)，前 slow+sig 根 NaN
2. `server` 新增 `ta.rs` 模块（纯函数 `build(klines, champion) -> TaResponse`）+
   `GET /api/ta?symbol=&interval=&days=730`：
   - 指标线全集（NaN→null）
   - `trend[]`：每 bar ∈ {1,-1,0}——收盘>MA200 且 MA50>MA200 = 多头(1)；
     收盘<MA200 且 MA50<MA200 = 空头(-1)；其余/MA200 未就绪 = 震荡(0)
   - `classic_signals[]`：{time, side, rules[], strength, price}，四条规则——
     MACD 柱上/下穿零轴；RSI 上穿30/下穿70；收盘下穿布林下轨后收回/上穿上轨后回落；
     KDJ K 在 D<30 低位金叉 / D>70 高位死叉。strength=同 bar 命中规则数
   - `champion_signals[]`：注册表该 symbol|interval 冠军的仓位序列（deadband 0.05），
     翻多=买点、翻平/翻空=卖点；无冠军则为空数组
   - 数据不足 300 bar 返回 400（与现有口径一致）

## 前端

3. `api.ts`：`TaResponse` 类型 + `fetchTa()`
4. 新组件 `TechPanel.tsx`：
   - 主图（~420px）：蜡烛 + MA/EMA/BOLL 叠加 + 底部趋势色带（histogram 细条，
     绿/红/灰）+ `setMarkers` 买卖点（经典 ▲▼ 箭头，strength≥2 大号；冠军 ◉ 圆点区分）
   - 三个副图（各 ~140px）：MACD 柱+DIF/DEA、RSI+30/70 参考线、KDJ 三线；
     与主图 visibleLogicalRange 双向联动（防递归 guard）
   - 顶部图例胶囊：各指标最新值 + 趋势标签；经典/冠军信号两个独立开关（默认开）
   - 数据按 time 对齐（klines 与 ta 两次请求间可能差一根 bar）
   - 拉 730 天（MA200 需要 ≥200 根 bar 才有值）
5. `App.tsx`：View 增加 `'tech'`，懒挂载 + 隐藏不卸载（同期权 Tab 模式）

## 不做（YAGNI）

指标参数自定义 UI、画线工具、形态识别、经典信号的回测统计。

## 验收

- `cargo test`（factors 新单测 + 既有全绿）
- `/api/ta` 冒烟：SPY 1d 返回完整字段，信号数量合理（非零非爆炸）
- `npm run build` 零错误
