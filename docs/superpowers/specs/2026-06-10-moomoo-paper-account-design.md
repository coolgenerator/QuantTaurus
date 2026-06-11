# moomoo 模拟账户面板（持仓 Tab）设计

2026-06-10 · 已与用户确认的决策：放持仓 Tab 新卡片；Today's P/L 用近似计算；股票+期权持仓都列出。

## 背景

持仓 Tab 现有内容（HoldingsGuide / PaperPanel / OptionsPaperSection）全部来自**内部模拟盘引擎**的自我记账，与 moomoo 模拟账户的实际持仓不一致（bridge 同步有阈值、碎单过滤、资金分配差异）。本功能把 moomoo 模拟账户的真实数据拉进来，作为持仓 Tab 顶部的账户视角卡片。

## 可行性结论（moomoo OpenAPI 模拟环境）

- `accinfo_query(SIMULATE)` ✅ 总资产/现金/市值/购买力
- `position_list_query(SIMULATE)` ✅ 含 `pl_val`/`pl_ratio`；**`today_pl_val` 仅真实环境有效** → 自算
- `order_list_query` / `history_order_list_query` ✅ 模拟环境支持
- 成交明细（deal）❌ 模拟环境不支持 → 用已成交订单（dealt_qty/dealt_avg_price）替代

## 架构

扩展 `bridge/options_service.py`（8788，已连 OpenD、有 `/opt-api` vite 代理）：

- 新增 `OpenSecTradeContext`（懒初始化 + 锁，`TrdMarket.US` + `SecurityFirm.FUTUINC`）
- 纯计算逻辑独立成 `bridge/account_math.py`（不依赖 futu，可单测）

### `GET /account`（缓存 15s，接口限频 10次/30s）

```json
{
  "funds": { "total_assets": 0, "cash": 0, "market_val": 0, "power": 0 },
  "positions": [{
    "code": "US.AAPL", "symbol": "AAPL", "name": "苹果", "is_option": false,
    "qty": 0, "can_sell_qty": 0, "avg_cost": 0, "last": 0, "prev_close": 0,
    "market_val": 0, "pl_val": 0, "pl_pct": 0, "today_pl": 0, "pct_of_positions": 0
  }],
  "updated_ms": 0
}
```

- `pl_val` 来自 SDK；`pl_pct = pl_val / (|qty| × avg_cost)`（SDK 的 pl_ratio 单位语义不明，自算无歧义）
- `today_pl` 近似：昨日底仓 ×（现价−昨收）+ 今日卖出 ×（卖价−昨收）+ 今日买入仍持有 ×（现价−买价）；昨收来自 `get_market_snapshot`（期权代码同样支持），今日买卖来自当日订单的成交数量/均价
- `pct_of_positions = |market_val| / Σ|market_val|`
- 期权合约 `is_option=true`，显示名优先 SDK `stock_name`，否则解析代码（`US.AAPL250620C200000` → `AAPL 250620 $200 C`）

### `GET /account/orders?code=US.AAPL`（按 code 缓存 60s）

历史订单（start=2024-01-01）+ 当日订单合并、按 order_id 去重、时间倒序：

```json
{ "code": "US.AAPL", "orders": [{
  "order_id": "", "side": "BUY", "status": "FILLED_ALL",
  "qty": 0, "dealt_qty": 0, "dealt_avg_price": 0, "price": 0,
  "create_time": "", "updated_time": ""
}] }
```

### 错误处理

OpenD 不可用 → 502 + 错误信息（沿用现有 Handler 的兜底）；前端显示提示卡，不影响页面其余部分。

## 前端

新组件 `web/src/components/MoomooAccountPanel.tsx`，挂在持仓 Tab **最顶部**（用户期望持仓页与 moomoo 对齐，账户视角优先）：

- 余额条：总资产 / 现金 / 持仓市值 / 购买力 / 当日盈亏合计（Σ today_pl）
- 持仓表：`Symbol | Qty | Price | Market Val | P/L($/%) | Today's P/L | % of Positions`，红绿着色
- 点击行展开 → 拉 `/opt-api/account/orders?code=` 显示该标的历次买卖（日期/方向/成交数量/成交价/状态）
- 30s 轮询；加载与报错均为内嵌状态，不打断布局

## 测试

- `bridge/test_account_math.py`（unittest，纯函数）：today_pl 三分量、卖超底仓退化、pct_of_positions、期权代码解析
- 端到端：OpenD 实连后 `curl /account`、`/account/orders`，前端目检
