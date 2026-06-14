#!/usr/bin/env python3
"""期权数据/分析服务：moomoo OpenD → HTTP JSON。

QuantTaurus 前端期权分析 Tab 的数据后端。Rust server 不直接说 OpenD 的
protobuf 协议，这个 sidecar 用 futu-api 取期权链 + 快照（IV/希腊字母/
未平仓量），并计算 Put/Call 比、最大痛点 (Max Pain)、IV 微笑等分析。

运行（OpenD 已登录的前提下）:
    python3 bridge/options_service.py        # 监听 127.0.0.1:8788

端点:
    GET /health
    GET /expirations?symbol=SPY
    GET /chain?symbol=SPY&expiry=2026-06-19
    GET /plans          期权交易计划（从股票冠军信号推导）
    GET /paper-options  期权模拟盘状态
    GET /account                    moomoo 模拟账户余额+持仓（含自算今日盈亏）
    GET /account/orders?code=US.AAPL  单标的历史买卖订单
"""

import json
import logging
import math
import os
import threading
import time
import urllib.parse
import urllib.request
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from futu import (
    Currency,
    OpenQuoteContext,
    OpenSecTradeContext,
    OptionType,
    RET_OK,
    SecurityFirm,
    TrdEnv,
    TrdMarket,
)

from account_math import parse_option_code, position_pct, today_pl

OPEND_HOST, OPEND_PORT = "127.0.0.1", 11111
LISTEN_HOST, LISTEN_PORT = "127.0.0.1", 8788
SNAPSHOT_BATCH = 380  # 单次快照上限 400，留余量  # 单次快照上限 400，留余量
CACHE_TTL = 120       # 秒；期权快照接口有频率限制（60次/30s），必须缓存

QHH_API = "http://localhost:8787"
# ---- 期权计划规则参数 ----
MIN_SIGNAL = 0.10        # 股票信号绝对值低于此不出期权计划
DELTA_TARGET = 0.35      # 选 |delta|≈0.35 的虚值档
MIN_OI = 100             # 流动性底线
HORIZON_BUFFER = 1.5     # 到期日 = 持有期 × 1.5
MIN_DTE = 14
# ---- 期权模拟盘参数 ----
PAPER_CASH0 = 10_000.0
PREMIUM_BUDGET = 1_000.0     # 每标的权利金预算（期权账户 10% —— 期权可归零，严格限额）
MAX_SINGLE_PREMIUM = 2_000.0 # 单张权利金超过此值的合约不买（如 MU 深度高价合约）
FEE_PER_CONTRACT = 0.65  # 保守按 $0.65/张（监管+平台费上限）
# 退出规则参数（可用环境变量覆盖，不再写死）
CLOSE_DTE = int(os.environ.get("QHH_OPT_CLOSE_DTE", "7"))      # 距到期≤N天无条件平仓
TP_PCT = float(os.environ.get("QHH_OPT_TP", "1.00"))           # 权利金止盈
SL_PCT = float(os.environ.get("QHH_OPT_SL", "-0.50"))          # 权利金止损（基准）
# IV 自适应止损：合约 IV 高于此阈值时止损放宽 1.2 倍（高IV合约权利金波动大，
# 固定-50%容易被噪声打掉），低于一半阈值时收紧到 0.8 倍
IV_WIDE_THRESHOLD = float(os.environ.get("QHH_OPT_IV_WIDE", "60"))
PAPER_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "engine", "data", "options_paper.json"
)

log = logging.getLogger("options-service")
_quote_lock = threading.Lock()
# 交互请求计数：>0 时后台预热在标的之间让路，保证前端加载不排队
_interactive = 0
_interactive_lock = threading.Lock()


class interactive_request:
    def __enter__(self):
        global _interactive
        with _interactive_lock:
            _interactive += 1

    def __exit__(self, *a):
        global _interactive
        with _interactive_lock:
            _interactive -= 1


def _yield_to_interactive():
    for _ in range(100):
        with _interactive_lock:
            busy = _interactive > 0
        if not busy:
            return
        time.sleep(0.3)
# OpenD 期权接口限频：官方 10 次/30 秒，留余量按 8 次执行
_od_calls: list[float] = []
_od_lock = threading.Lock()  # 保护 _od_calls（throttle 不再在 _quote_lock 内调用）
OD_MAX_PER_30S = 8
# 后台给交互让路的时间上限：交互计数可能因前端 abort 泄漏，无上限会饿死后台
OD_YIELD_DEADLINE_S = 120.0


def _od_throttle():
    """等待 OpenD 期权接口配额。

    必须在拿 _quote_lock **之前**调用：曾经在持锁状态下等配额/让路，
    后台线程拿着锁睡觉，交互请求（持仓页/期权页）全部排队甚至互相等死。
    """
    background = threading.current_thread().name == "options-plans"
    yield_deadline = time.time() + OD_YIELD_DEADLINE_S
    while True:
        if background and time.time() < yield_deadline:
            with _interactive_lock:
                busy = _interactive > 0
            if busy:
                time.sleep(0.3)
                continue
        with _od_lock:
            now = time.time()
            while _od_calls and now - _od_calls[0] > 30:
                _od_calls.pop(0)
            cap = 5 if background else OD_MAX_PER_30S
            if len(_od_calls) < cap:
                _od_calls.append(now)
                return
        time.sleep(0.5)
_cache: dict[str, tuple[float, dict]] = {}

quote_ctx: OpenQuoteContext | None = None


def get_ctx() -> OpenQuoteContext:
    global quote_ctx
    if quote_ctx is None:
        quote_ctx = OpenQuoteContext(host=OPEND_HOST, port=OPEND_PORT)
    return quote_ctx


# 在飞去重：同 key 刷新进行中时，有旧值的并发请求直接回旧值（不排队重算），
# 没旧值的等在飞结果。ThreadingHTTPServer 每请求一线程，前端轮询会堆出
# 大量重复 fetch_account/fetch_chain，全部打到 OpenD 配额上。
_inflight: dict[str, threading.Event] = {}
_inflight_lock = threading.Lock()


def cached(key: str, fn, ttl: float = CACHE_TTL):
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    with _inflight_lock:
        ev = _inflight.get(key)
        if ev is None:
            ev = threading.Event()
            _inflight[key] = ev
            owner = True
        else:
            owner = False
    if not owner:
        if hit:
            return hit[1]
        ev.wait(timeout=90)
        hit = _cache.get(key)
        if hit:
            return hit[1]
        raise RuntimeError(f"refresh of {key} did not complete in time")
    try:
        val = fn()
        _cache[key] = (time.time(), val)
        return val
    except Exception:
        if hit:
            log.exception("refresh failed for %s, serving stale", key)
            return hit[1]
        raise
    finally:
        with _inflight_lock:
            _inflight.pop(key, None)
        ev.set()


def fetch_expirations(symbol: str) -> dict:
    code = f"US.{symbol.upper()}"
    _od_throttle()  # 先等配额再拿锁，持锁等配额会堵死所有交互请求
    with _quote_lock:
        ret, df = get_ctx().get_option_expiration_date(code=code)
    if ret != RET_OK:
        raise RuntimeError(f"get_option_expiration_date: {df}")
    return {"symbol": symbol.upper(), "expirations": df["strike_time"].tolist()}


def fetch_chain(symbol: str, expiry: str) -> dict:
    code = f"US.{symbol.upper()}"
    ctx = get_ctx()
    _od_throttle()  # 先等配额再拿锁，持锁等配额会堵死所有交互请求
    with _quote_lock:
        ret, df = ctx.get_option_chain(
            code=code, start=expiry, end=expiry, option_type=OptionType.ALL
        )
    if ret != RET_OK:
        raise RuntimeError(f"get_option_chain: {df}")
    if df.empty:
        return {"symbol": symbol.upper(), "expiry": expiry, "rows": []}

    # 标的现价
    with _quote_lock:
        ret_u, udf = ctx.get_market_snapshot([code])
    spot = float(udf.iloc[0]["last_price"]) if ret_u == RET_OK else 0.0

    # 行权价窗口：现价±30%之外的深虚值合约直接略过（没人看且省快照配额）
    if spot > 0:
        df = df[(df["strike_price"] >= spot * 0.7) & (df["strike_price"] <= spot * 1.3)]

    # 期权快照（单批最多400码；超出才分批）
    codes = df["code"].tolist()
    snaps = {}
    for i in range(0, len(codes), SNAPSHOT_BATCH):
        batch = codes[i : i + SNAPSHOT_BATCH]
        with _quote_lock:
            ret_s, sdf = ctx.get_market_snapshot(batch)
        if ret_s != RET_OK:
            log.warning("snapshot failed for batch %d: %s", i, sdf)
            continue
        for _, row in sdf.iterrows():
            snaps[row["code"]] = row
        if i + SNAPSHOT_BATCH < len(codes):
            time.sleep(0.6)

    def fnum(row, key):
        try:
            v = float(row[key])
            return v if v == v else None  # NaN -> None
        except (KeyError, TypeError, ValueError):
            return None

    rows = []
    for _, opt in df.iterrows():
        snap = snaps.get(opt["code"])
        item = {
            "code": opt["code"],
            "type": "call" if str(opt["option_type"]).lower().endswith("call") else "put",
            "strike": float(opt["strike_price"]),
            "last": fnum(snap, "last_price") if snap is not None else None,
            "volume": fnum(snap, "volume") if snap is not None else None,
            "open_interest": fnum(snap, "option_open_interest") if snap is not None else None,
            "iv": fnum(snap, "option_implied_volatility") if snap is not None else None,
            "delta": fnum(snap, "option_delta") if snap is not None else None,
            "gamma": fnum(snap, "option_gamma") if snap is not None else None,
            "theta": fnum(snap, "option_theta") if snap is not None else None,
            "vega": fnum(snap, "option_vega") if snap is not None else None,
        }
        rows.append(item)

    return {
        "symbol": symbol.upper(),
        "expiry": expiry,
        "spot": spot,
        "rows": rows,
        "analysis": analyze(rows, spot),
    }


def analyze(rows: list[dict], spot: float) -> dict:
    calls = [r for r in rows if r["type"] == "call"]
    puts = [r for r in rows if r["type"] == "put"]

    def total(rs, key):
        return sum(r[key] or 0 for r in rs)

    vol_c, vol_p = total(calls, "volume"), total(puts, "volume")
    oi_c, oi_p = total(calls, "open_interest"), total(puts, "open_interest")

    # 最大痛点：到期时让全体期权买方损失最大的标的价（= 卖方支付的内在价值最小）
    strikes = sorted({r["strike"] for r in rows})
    max_pain = None
    if strikes:
        best_cost = None
        for s in strikes:
            cost = sum((s - c["strike"]) * (c["open_interest"] or 0) for c in calls if s > c["strike"])
            cost += sum((p["strike"] - s) * (p["open_interest"] or 0) for p in puts if s < p["strike"])
            if best_cost is None or cost < best_cost:
                best_cost, max_pain = cost, s

    # ATM IV 与 25-delta 偏度（put IV - call IV，正值=下行保护贵=偏空情绪）
    def atm_iv(rs):
        with_iv = [r for r in rs if r["iv"] and r["strike"]]
        if not with_iv or not spot:
            return None
        return min(with_iv, key=lambda r: abs(r["strike"] - spot))["iv"]

    def delta_iv(rs, target):
        cand = [r for r in rs if r["iv"] and r["delta"] is not None]
        if not cand:
            return None
        return min(cand, key=lambda r: abs(abs(r["delta"]) - target))["iv"]

    iv_call_atm, iv_put_atm = atm_iv(calls), atm_iv(puts)
    skew_25d = None
    p25, c25 = delta_iv(puts, 0.25), delta_iv(calls, 0.25)
    if p25 is not None and c25 is not None:
        skew_25d = p25 - c25

    return {
        "pcr_volume": (vol_p / vol_c) if vol_c else None,
        "pcr_oi": (oi_p / oi_c) if oi_c else None,
        "max_pain": max_pain,
        "atm_iv_call": iv_call_atm,
        "atm_iv_put": iv_put_atm,
        "skew_25d": skew_25d,
        "total_oi_call": oi_c,
        "total_oi_put": oi_p,
    }


# ====================== 期权交易计划（由股票冠军信号推导） ======================


def fetch_stock_plans() -> list[dict]:
    with urllib.request.urlopen(f"{QHH_API}/api/plan", timeout=60) as r:
        return json.loads(r.read())


def dte(expiry: str) -> int:
    y, m, d = map(int, expiry.split("-"))
    return (date(y, m, d) - date.today()).days


def pick_expiry(symbol: str, horizon_days: float) -> str | None:
    """选最近的满足 持有期×1.5（且≥MIN_DTE）的到期日"""
    exps = cached(f"exp:{symbol}", lambda: fetch_expirations(symbol), ttl=3600)["expirations"]
    want = max(MIN_DTE, math.ceil(horizon_days * HORIZON_BUFFER))
    for e in exps:
        if dte(e) >= want:
            return e
    return exps[-1] if exps else None


def pick_contract(chain: dict, direction: int) -> dict | None:
    """方向→Call/Put；|delta|≈DELTA_TARGET 且 OI≥MIN_OI；退化取虚值5%最近行权价"""
    want_type = "call" if direction > 0 else "put"
    rows = [r for r in chain["rows"] if r["type"] == want_type]
    liquid = [
        r for r in rows
        if r["delta"] is not None and (r["open_interest"] or 0) >= MIN_OI and (r["last"] or 0) > 0
    ]
    if liquid:
        return min(liquid, key=lambda r: abs(abs(r["delta"]) - DELTA_TARGET))
    spot = chain.get("spot") or 0
    otm = spot * (1.05 if direction > 0 else 0.95)
    priced = [r for r in rows if (r["last"] or 0) > 0]
    return min(priced, key=lambda r: abs(r["strike"] - otm)) if priced else None


def build_option_plans() -> dict:
    plans = []
    stock_plans = sorted(
        fetch_stock_plans(), key=lambda p: abs(p.get("target_position", 0)), reverse=True
    )[:12]  # 限频预算：每标的≥2次OpenD调用，12个 ≈ 1.5个30秒窗口
    for sp in stock_plans:
        _yield_to_interactive()
        sym = sp["symbol"]
        if sym.endswith(("USDT", "USDC", "BUSD")):
            continue  # 期权仅美股
        tgt = sp["target_position"]
        if abs(tgt) < MIN_SIGNAL:
            continue
        direction = 1 if tgt > 0 else -1
        expiry = pick_expiry(sym, sp.get("horizon_days") or 10)
        if not expiry:
            continue
        chain = cached(f"chain:{sym}:{expiry}", lambda s=sym, e=expiry: fetch_chain(s, e))
        contract = pick_contract(chain, direction)
        if not contract:
            continue
        premium = contract["last"] or 0
        qty = int(PREMIUM_BUDGET // (premium * 100)) if premium > 0 else 0
        # 预算买不起一张但单张未超上限 → 仍买1张（小账户现实处理）
        if qty == 0 and 0 < premium * 100 <= MAX_SINGLE_PREMIUM:
            qty = 1
        flip = sp.get("flip_price")
        exit_rules = [
            (
                f"股票信号反转：现价{'跌破' if direction > 0 else '升破'} "
                f"{flip:.2f} 时平仓" if flip else "股票信号反转时平仓（每日收盘检查）"
            ),
            f"距到期 ≤{CLOSE_DTE} 天无条件平仓（避开 theta/gamma 末期）",
            f"权利金 {SL_PCT*100:+.0f}% 止损 / {TP_PCT*100:+.0f}% 止盈",
        ]
        plans.append({
            "underlying": sym,
            "action": "BUY CALL" if direction > 0 else "BUY PUT",
            "code": contract["code"],
            "strike": contract["strike"],
            "expiry": expiry,
            "dte": dte(expiry),
            "premium": premium,
            "qty_suggested": qty,
            "iv": contract["iv"],
            "delta": contract["delta"],
            "theta": contract["theta"],
            "open_interest": contract["open_interest"],
            "spot": chain.get("spot"),
            "entry_rule": "信号有效期内买入；建议限价 = 买卖中间价，避免市价单滑点",
            "exit_rules": exit_rules,
            "rationale": (
                f"标的信号：{sp['rationale']}｜置信度 {sp['confidence']:.0f}({sp['confidence_label']})。"
                f"期权层：|Δ|≈{abs(contract['delta'] or 0):.2f} 虚值档平衡杠杆与时间损耗；"
                f"IV {contract['iv'] or 0:.1f}%；到期 {expiry}（{dte(expiry)}天 ≈ 持有期×{HORIZON_BUFFER}）；"
                f"权利金预算 ${PREMIUM_BUDGET:.0f}/标的（槽位资金 2%，期权可归零故严格限额）"
            ),
            "stock_confidence": sp["confidence"],
            "stock_target": tgt,
        })
    return {"as_of": int(time.time() * 1000), "plans": plans}


# ====================== 期权模拟盘 ======================

_paper_lock = threading.Lock()


def _paper_load() -> dict:
    try:
        with open(PAPER_FILE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"cash": PAPER_CASH0, "positions": {}, "trades": [], "equity": PAPER_CASH0}


def _paper_save(st: dict) -> None:
    os.makedirs(os.path.dirname(PAPER_FILE), exist_ok=True)
    tmp = PAPER_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=1)
    os.replace(tmp, PAPER_FILE)


def _snapshot_last(codes: list[str]) -> dict[str, float]:
    if not codes:
        return {}
    with _quote_lock:
        ret, df = get_ctx().get_market_snapshot(codes)
    if ret != RET_OK:
        log.warning("paper snapshot failed: %s", df)
        return {}
    return {row["code"]: float(row["last_price"]) for _, row in df.iterrows()}


def paper_tick() -> None:
    """开仓新信号 → 标记持仓 → 按三条规则平仓。每5分钟一次。"""
    with _paper_lock:
        st = _paper_load()
        # 用后台预热好的计划缓存；锁内绝不做分钟级的链拉取
        hit = _cache.get("option_plans")
        report = hit[1] if hit else {"plans": []}
        plan_by_underlying = {p["underlying"]: p for p in report["plans"]}

        # 标记现价
        marks = _snapshot_last([p["code"] for p in st["positions"].values()])

        # 平仓检查
        for und in list(st["positions"]):
            pos = st["positions"][und]
            last = marks.get(pos["code"], pos.get("mark", pos["entry_premium"]))
            pos["mark"] = last
            pnl_pct = (last / pos["entry_premium"] - 1.0) if pos["entry_premium"] > 0 else 0.0
            plan_now = plan_by_underlying.get(und)
            reason = None
            sl_eff = effective_sl(pos)
            if dte(pos["expiry"]) <= CLOSE_DTE:
                reason = f"距到期≤{CLOSE_DTE}天"
            elif pnl_pct >= TP_PCT:
                reason = f"止盈{TP_PCT:+.0%}"
            elif pnl_pct <= sl_eff:
                reason = f"止损{sl_eff:+.0%}(IV自适应)"
            elif plan_now is None or (plan_now["stock_target"] > 0) != (pos["direction"] > 0):
                reason = "股票信号反转/消失"
            if reason:
                proceeds = last * 100 * pos["qty"] - FEE_PER_CONTRACT * pos["qty"]
                st["cash"] += proceeds
                st["trades"].append({
                    "time": int(time.time() * 1000), "side": "SELL", "code": pos["code"],
                    "qty": pos["qty"], "premium": last, "reason": reason,
                    "pnl": proceeds - pos["cost_basis"],
                })
                del st["positions"][und]
                log.info("期权模拟平仓 %s %s: %s", und, pos["code"], reason)

        # 开仓：有计划、无持仓、买得起
        for und, plan in plan_by_underlying.items():
            if und in st["positions"] or plan["qty_suggested"] < 1 or not plan["premium"]:
                continue
            cost = plan["premium"] * 100 * plan["qty_suggested"] + FEE_PER_CONTRACT * plan["qty_suggested"]
            if cost > st["cash"]:
                continue
            st["cash"] -= cost
            st["positions"][und] = {
                "code": plan["code"], "qty": plan["qty_suggested"],
                "direction": 1 if plan["action"] == "BUY CALL" else -1,
                "entry_premium": plan["premium"], "mark": plan["premium"],
                "cost_basis": cost, "entry_ms": int(time.time() * 1000),
                "expiry": plan["expiry"], "strike": plan["strike"],
                "action": plan["action"], "rationale": plan["rationale"],
                "iv_at_entry": plan.get("iv"), "delta_at_entry": plan.get("delta"),
            }
            st["trades"].append({
                "time": int(time.time() * 1000), "side": "BUY", "code": plan["code"],
                "qty": plan["qty_suggested"], "premium": plan["premium"], "reason": "信号开仓",
                "pnl": None,
            })
            log.info("期权模拟开仓 %s %s x%d @%.2f", und, plan["code"], plan["qty_suggested"], plan["premium"])

        st["equity"] = st["cash"] + sum(
            p["mark"] * 100 * p["qty"] for p in st["positions"].values()
        )
        st["updated_ms"] = int(time.time() * 1000)
        _paper_save(st)


def effective_sl(pos: dict) -> float:
    """IV 自适应止损：高IV合约权利金噪声大放宽，低IV收紧"""
    iv = pos.get("iv_at_entry")
    if iv is None:
        return SL_PCT
    if iv >= IV_WIDE_THRESHOLD:
        return SL_PCT * 1.2
    if iv <= IV_WIDE_THRESHOLD / 2:
        return SL_PCT * 0.8
    return SL_PCT


def _stock_plans_by_symbol() -> dict:
    try:
        return {p["symbol"]: p for p in fetch_stock_plans()}
    except Exception:  # noqa: BLE001
        return {}


_paper_state_snap: dict = {}


def paper_state() -> dict:
    global _paper_state_snap
    # tick 可能持锁做报价拉取（限频下数秒~数十秒）：等2秒拿不到就回快照，不挂死前端
    if not _paper_lock.acquire(timeout=2):
        if _paper_state_snap:
            return {**_paper_state_snap, "stale": True}
        return {"positions": {}, "history": [], "equity": 1.0, "stale": True,
                "note": "模拟盘tick进行中，数秒后自动刷新"}
    try:
        st = _paper_load()
    finally:
        _paper_lock.release()
    # 动态退出参数（读取时实时计算，不落盘）
    plans = _stock_plans_by_symbol()
    for und, pos in st.get("positions", {}).items():
        sl = effective_sl(pos)
        entry = pos["entry_premium"]
        sp = plans.get(und) or {}
        horizon = sp.get("horizon_days") or 10
        # 动态预计售出 = min(到期-CLOSE_DTE, 建仓 + 信号持有期×1.5)
        y, m_, d_ = map(int, pos["expiry"].split("-"))
        hard_close = time.mktime((y, m_, d_, 0, 0, 0, 0, 0, -1)) * 1000 - CLOSE_DTE * 86_400_000
        signal_exit = pos["entry_ms"] + int(horizon * 1.5) * 86_400_000
        pos["exit_dynamic"] = {
            "tp_premium": entry * (1 + TP_PCT),
            "sl_premium": entry * (1 + sl),
            "sl_pct_effective": sl,
            "iv_adaptive": pos.get("iv_at_entry") is not None,
            "underlying_flip_price": sp.get("flip_price"),
            "underlying_last": sp.get("last_close"),
            "planned_exit_ms": int(min(hard_close, signal_exit)),
            "hard_close_ms": int(hard_close),
            "rules_note": (
                f"止盈{TP_PCT:+.0%} / 止损{sl:+.0%}(IV自适应) / "
                f"标的跌穿反转价平仓 / 到期前{CLOSE_DTE}天强平 —— 参数可经环境变量调整"
            ),
        }
    _paper_state_snap = st
    return st


def paper_loop() -> None:
    while True:
        try:
            paper_tick()
        except Exception:
            log.exception("options paper tick failed")
        time.sleep(300)


# ====================== moomoo 模拟账户（余额/持仓/订单） ======================

ACCOUNT_TTL = 15      # 资金/持仓接口限频 10次/30s，必须缓存
ORDERS_TTL = 60       # 历史订单接口同样限频；点击才拉取
HISTORY_START = "2024-01-01"

_trade_lock = threading.Lock()
trade_ctx: OpenSecTradeContext | None = None


def get_trd() -> OpenSecTradeContext:
    global trade_ctx
    if trade_ctx is None:
        trade_ctx = OpenSecTradeContext(
            filter_trdmarket=TrdMarket.US,
            host=OPEND_HOST,
            port=OPEND_PORT,
            security_firm=SecurityFirm.FUTUINC,
        )
    return trade_ctx


def _f(v) -> float | None:
    """pandas/numpy 标量 → 内建 float；NaN/缺失 → None（json 安全）。"""
    try:
        x = float(v)
        return x if x == x else None
    except (TypeError, ValueError):
        return None


def _df_rows(ret, df, what: str) -> list:
    if ret != RET_OK:
        raise RuntimeError(f"{what}: {df}")
    return [] if df is None or len(df) == 0 else [row for _, row in df.iterrows()]


def _today_fills() -> dict[str, tuple[list, list]]:
    """当日订单的已成交部分 → {code: (buys, sells)}，每项 [(数量, 成交均价)]。

    模拟环境不支持成交(deal)查询，用订单的 dealt_qty/dealt_avg_price 还原。
    """
    with _trade_lock:
        ret, df = get_trd().order_list_query(trd_env=TrdEnv.SIMULATE)
    out: dict[str, tuple[list, list]] = {}
    for row in _df_rows(ret, df, "order_list_query"):
        dealt = _f(row.get("dealt_qty")) or 0.0
        if dealt <= 0:
            continue
        price = _f(row.get("dealt_avg_price")) or 0.0
        buys, sells = out.setdefault(str(row["code"]), ([], []))
        if "BUY" in str(row["trd_side"]).upper():
            buys.append((dealt, price))
        else:
            sells.append((dealt, price))
    return out


def _position_snapshots(codes: list[str]) -> dict:
    snaps = {}
    for i in range(0, len(codes), SNAPSHOT_BATCH):
        batch = codes[i : i + SNAPSHOT_BATCH]
        with _quote_lock:
            ret, df = get_ctx().get_market_snapshot(batch)
        if ret != RET_OK:
            log.warning("account snapshot failed: %s", df)
            continue
        for _, row in df.iterrows():
            snaps[row["code"]] = row
        if i + SNAPSHOT_BATCH < len(codes):
            time.sleep(0.6)
    return snaps


def fetch_account() -> dict:
    trd = get_trd()
    with _trade_lock:
        ret, fdf = trd.accinfo_query(trd_env=TrdEnv.SIMULATE, currency=Currency.USD)
    frow = _df_rows(ret, fdf, "accinfo_query")[0]
    funds = {k: _f(frow.get(k)) for k in ("total_assets", "cash", "market_val", "power")}

    with _trade_lock:
        ret, pdf = trd.position_list_query(trd_env=TrdEnv.SIMULATE)
    prows = [r for r in _df_rows(ret, pdf, "position_list_query") if (_f(r.get("qty")) or 0) != 0]

    fills = _today_fills()
    snaps = _position_snapshots([str(r["code"]) for r in prows])
    total_abs = sum(abs(_f(r.get("market_val")) or 0.0) for r in prows)

    positions = []
    for r in prows:
        code = str(r["code"])
        opt = parse_option_code(code)
        mult = 100.0 if opt else 1.0
        sign = -1.0 if str(r.get("position_side", "")).upper().endswith("SHORT") else 1.0
        qty = sign * (_f(r.get("qty")) or 0.0)
        snap = snaps.get(code)
        last = (_f(snap.get("last_price")) if snap is not None else None) or _f(r.get("nominal_price"))
        prev_close = _f(snap.get("prev_close_price")) if snap is not None else None
        avg_cost = _f(r.get("cost_price"))
        market_val = _f(r.get("market_val")) or 0.0
        pl_val = _f(r.get("pl_val"))
        cost_basis = abs(qty) * (avg_cost or 0.0) * mult
        buys, sells = fills.get(code, ([], []))
        positions.append({
            "code": code,
            "symbol": opt["underlying"] if opt else code.split(".", 1)[-1],
            "name": str(r.get("stock_name") or ""),
            "is_option": opt is not None,
            "opt": opt,
            "qty": qty,
            "can_sell_qty": _f(r.get("can_sell_qty")),
            "avg_cost": avg_cost,
            "last": last,
            "prev_close": prev_close,
            "market_val": market_val,
            "pl_val": pl_val,
            "pl_pct": (pl_val / cost_basis) if pl_val is not None and cost_basis > 0 else None,
            "today_pl": today_pl(qty, last, prev_close, buys, sells, multiplier=mult)
            if last is not None
            else None,
            "pct_of_positions": position_pct(market_val, total_abs),
        })
    positions.sort(key=lambda p: -abs(p["market_val"]))
    return {"funds": funds, "positions": positions, "updated_ms": int(time.time() * 1000)}


def fetch_account_orders(code: str) -> dict:
    trd = get_trd()
    with _trade_lock:
        ret_h, hdf = trd.history_order_list_query(
            code=code, start=HISTORY_START, trd_env=TrdEnv.SIMULATE
        )
    with _trade_lock:
        ret_t, tdf = trd.order_list_query(code=code, trd_env=TrdEnv.SIMULATE)
    seen: set[str] = set()
    orders = []
    for row in _df_rows(ret_h, hdf, "history_order_list_query") + _df_rows(
        ret_t, tdf, "order_list_query"
    ):
        oid = str(row["order_id"])
        if oid in seen:
            continue
        seen.add(oid)
        orders.append({
            "order_id": oid,
            "side": "BUY" if "BUY" in str(row["trd_side"]).upper() else "SELL",
            "status": str(row["order_status"]),
            "qty": _f(row.get("qty")),
            "dealt_qty": _f(row.get("dealt_qty")) or 0.0,
            "dealt_avg_price": _f(row.get("dealt_avg_price")),
            "price": _f(row.get("price")),
            "create_time": str(row.get("create_time") or ""),
            "updated_time": str(row.get("updated_time") or ""),
        })
    orders.sort(key=lambda o: o["create_time"], reverse=True)
    return {"code": code, "orders": orders}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 安静一点
        log.debug(fmt, *args)

    def _send(self, status: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if parsed.path == "/health":
                self._send(200, {"ok": True})
            elif parsed.path == "/expirations":
                symbol = qs["symbol"][0]
                with interactive_request():
                    self._send(200, cached(f"exp:{symbol}", lambda: fetch_expirations(symbol), ttl=3600))
            elif parsed.path == "/chain":
                symbol, expiry = qs["symbol"][0], qs["expiry"][0]
                with interactive_request():
                    self._send(200, cached(f"chain:{symbol}:{expiry}", lambda: fetch_chain(symbol, expiry)))
            elif parsed.path == "/plans":
                hit = _cache.get("option_plans")
                if hit:
                    self._send(200, hit[1])
                else:
                    self._send(200, {"plans": [], "warming_up": True,
                                     "note": "期权计划后台预热中（OpenD限频，约1-2分钟）"})
            elif parsed.path == "/paper-options":
                with interactive_request():
                    self._send(200, paper_state())
            elif parsed.path == "/account":
                with interactive_request():
                    self._send(200, cached("account", fetch_account, ttl=ACCOUNT_TTL))
            elif parsed.path == "/account/orders":
                code = qs["code"][0]
                with interactive_request():
                    self._send(
                        200,
                        cached(f"acct_orders:{code}", lambda: fetch_account_orders(code), ttl=ORDERS_TTL),
                    )
            else:
                self._send(404, {"error": "not found"})
        except KeyError as e:
            self._send(400, {"error": f"missing param {e}"})
        except Exception as e:  # noqa: BLE001
            log.exception("request failed")
            self._send(502, {"error": str(e)})


PLANS_REFRESH_SEC = 300


def _prewarm_expirations():
    """预热全部冠军标的的到期日列表（TTL 1h）：前端切标的时日期瞬出。"""
    try:
        syms = sorted({
            p["symbol"] for p in fetch_stock_plans()
            if not p["symbol"].endswith(("USDT", "USDC", "BUSD"))
        })
    except Exception:
        return
    for sym in syms:
        _yield_to_interactive()
        try:
            cached(f"exp:{sym}", lambda s=sym: fetch_expirations(s), ttl=3600)
        except Exception:
            log.warning("exp prewarm failed for %s", sym)


def plans_refresher():
    """后台预热期权计划：HTTP 请求永远直接读缓存（秒回），重活在这条线程里干。"""
    while True:
        try:
            val = build_option_plans()
            _cache["option_plans"] = (time.time(), val)
            _prewarm_expirations()
        except Exception:
            log.exception("plans refresh failed (will retry)")
        time.sleep(PLANS_REFRESH_SEC)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    threading.Thread(target=paper_loop, daemon=True, name="options-paper").start()
    threading.Thread(target=plans_refresher, daemon=True, name="options-plans").start()
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    log.info("options service on http://%s:%d (OpenD %s:%d)", LISTEN_HOST, LISTEN_PORT, OPEND_HOST, OPEND_PORT)
    srv.serve_forever()


if __name__ == "__main__":
    main()
