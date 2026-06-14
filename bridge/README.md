# moomoo 模拟盘桥接

把 QuantTaurus 冠军策略的目标仓位自动同步到你的 moomoo 模拟交易账户。

## 一次性设置

1. **安装 OpenD**（moomoo 官方 API 网关）：
   https://www.moomoo.com/download/OpenAPI
   下载后启动并用你的 moomoo 账号登录（默认监听 `127.0.0.1:11111`）
2. **安装 SDK**：`pip install futu-api requests`
3. QuantTaurus server 在跑（`:8787`）

## 运行

```bash
# 先 dry-run 看看会下什么单
python3 bridge/moomoo_bridge.py --dry-run --once

# 确认无误后常驻运行（每 60s 同步一次）
python3 bridge/moomoo_bridge.py
```

## 工作原理

- 每 60s 读 `GET /api/paper` 的各冠军会话目标仓位（仅美股槽位）
- 每槽位分配 `ALLOC_USD`（默认 $10,000）名义资金：
  目标股数 = 仓位 × 名义资金 ÷ 现价
- 与 moomoo 模拟账户实际持仓比较，差额超过 `MIN_ORDER_USD`（默认 $100）
  时以**市价单**（`TrdEnv.SIMULATE`）补齐
- 冠军是日线策略，正常情况下每 2~4 周才会有实际调仓

## 服务器开机自启（可选）

```bash
ROOT="$(pwd)"
sed "s#__QUANTTAURUS_ROOT__#$ROOT#g" deploy/com.quanttaurus.server.plist \
  > ~/Library/LaunchAgents/com.quanttaurus.server.plist
launchctl load ~/Library/LaunchAgents/com.quanttaurus.server.plist
```

之后 server 开机自动运行、崩溃自动拉起，模拟盘在每个交易日开盘时段
（北京时间 21:30–04:00）自动 mark 净值并在日线收盘后调仓。
