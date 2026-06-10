#!/usr/bin/env python3
"""QuantHaHa → moomoo 模拟盘桥接器。

把 QuantHaHa 注册表冠军的目标仓位同步到 moomoo (Futu) 模拟交易账户：
每 POLL_SEC 秒读取 /api/paper 的各会话目标仓位，与 moomoo 模拟账户
当前持仓对比，差额超过阈值就以市价单补齐。

前置条件（需要手动完成一次）:
  1. 下载安装 moomoo OpenD 网关并用你的 moomoo 账号登录:
     https://www.moomoo.com/download/OpenAPI
     （默认监听 127.0.0.1:11111）
  2. pip install futu-api requests
  3. 运行: python3 bridge/moomoo_bridge.py
     （加 --dry-run 只打印不下单）

资金分配: 每个策略槽位分配 ALLOC_USD 美元名义资金，
目标股数 = 目标仓位 × ALLOC_USD / 现价。仅同步美股槽位（跳过加密）。
"""

import argparse
import logging
import math
import time

import requests

try:
    from futu import (
        OpenSecTradeContext,
        OrderType,
        RET_OK,
        SecurityFirm,
        TrdEnv,
        TrdMarket,
        TrdSide,
    )
except ImportError:  # pragma: no cover
    raise SystemExit("请先安装 SDK: pip install futu-api")

QHH_API = "http://localhost:8787"
OPEND_HOST, OPEND_PORT = "127.0.0.1", 11111
POLL_SEC = 60
ALLOC_USD = 10_000.0   # 每个策略槽位的名义资金
MIN_ORDER_USD = 100.0  # 差额小于此值不下单（避免碎单）

log = logging.getLogger("moomoo-bridge")

CRYPTO_SUFFIXES = ("USDT", "USDC", "BUSD")


def is_crypto(symbol: str) -> bool:
    return symbol.upper().endswith(CRYPTO_SUFFIXES)


def fetch_targets() -> dict[str, tuple[float, float]]:
    """返回 {symbol: (目标仓位[-1,1], 最新价)}，仅美股。"""
    r = requests.get(f"{QHH_API}/api/paper", timeout=10)
    r.raise_for_status()
    sessions = r.json().get("sessions", {})
    out = {}
    for sess in sessions.values():
        sym = sess["symbol"]
        if is_crypto(sym) or sess["last_price"] <= 0:
            continue
        # 同一股票多周期槽位时取仓位均值
        if sym in out:
            out[sym] = ((out[sym][0] + sess["position"]) / 2, sess["last_price"])
        else:
            out[sym] = (sess["position"], sess["last_price"])
    return out


def current_positions(trd) -> dict[str, float]:
    ret, df = trd.position_list_query(trd_env=TrdEnv.SIMULATE)
    if ret != RET_OK:
        raise RuntimeError(f"position_list_query failed: {df}")
    pos = {}
    for _, row in df.iterrows():
        code = str(row["code"])  # 形如 "US.SPY"
        sym = code.split(".", 1)[-1]
        pos[sym] = float(row["qty"]) * (1 if row["position_side"] == "LONG" else -1)
    return pos


def place(trd, symbol: str, delta_shares: int, price: float, dry: bool) -> None:
    side = TrdSide.BUY if delta_shares > 0 else TrdSide.SELL
    qty = abs(delta_shares)
    code = f"US.{symbol}"
    if dry:
        log.info("[dry-run] %s %s x%d @~%.2f", side, code, qty, price)
        return
    ret, data = trd.place_order(
        price=price,  # 市价单价格字段仍需传参考价
        qty=qty,
        code=code,
        trd_side=side,
        order_type=OrderType.MARKET,
        trd_env=TrdEnv.SIMULATE,
    )
    if ret == RET_OK:
        log.info("下单成功 %s %s x%d", side, code, qty)
    else:
        log.error("下单失败 %s %s x%d: %s", side, code, qty, data)


def sync_once(trd, dry: bool) -> None:
    targets = fetch_targets()
    if not targets:
        log.info("没有美股模拟盘会话，跳过")
        return
    held = current_positions(trd)
    for sym, (frac, price) in targets.items():
        want = math.floor(frac * ALLOC_USD / price)
        have = int(held.get(sym, 0))
        delta = want - have
        if abs(delta) * price < MIN_ORDER_USD:
            continue
        log.info("%s: 目标 %+d 股 (仓位 %+.2f), 现持 %+d, 调整 %+d", sym, want, frac, have, delta)
        place(trd, sym, delta, price, dry)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只打印，不真正下单")
    ap.add_argument("--once", action="store_true", help="同步一次后退出")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    trd = OpenSecTradeContext(
        filter_trdmarket=TrdMarket.US,
        host=OPEND_HOST,
        port=OPEND_PORT,
        security_firm=SecurityFirm.FUTUINC,
    )
    log.info("已连接 OpenD，开始同步（SIMULATE 环境，每 %ds）", POLL_SEC)
    try:
        while True:
            try:
                sync_once(trd, args.dry_run)
            except Exception:
                log.exception("本轮同步失败，下轮重试")
            if args.once:
                break
            time.sleep(POLL_SEC)
    finally:
        trd.close()


if __name__ == "__main__":
    main()
