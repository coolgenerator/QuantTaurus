#!/usr/bin/env python3
"""期权数据/分析服务：moomoo OpenD → HTTP JSON。

QuantHaHa 前端期权分析 Tab 的数据后端。Rust server 不直接说 OpenD 的
protobuf 协议，这个 sidecar 用 futu-api 取期权链 + 快照（IV/希腊字母/
未平仓量），并计算 Put/Call 比、最大痛点 (Max Pain)、IV 微笑等分析。

运行（OpenD 已登录的前提下）:
    python3 bridge/options_service.py        # 监听 127.0.0.1:8788

端点:
    GET /health
    GET /expirations?symbol=SPY
    GET /chain?symbol=SPY&expiry=2026-06-19
"""

import json
import logging
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from futu import OpenQuoteContext, OptionType, RET_OK

OPEND_HOST, OPEND_PORT = "127.0.0.1", 11111
LISTEN_HOST, LISTEN_PORT = "127.0.0.1", 8788
SNAPSHOT_BATCH = 380  # 单次快照上限 400，留余量
CACHE_TTL = 120       # 秒；期权快照接口有频率限制（60次/30s），必须缓存

log = logging.getLogger("options-service")
_quote_lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}

quote_ctx: OpenQuoteContext | None = None


def get_ctx() -> OpenQuoteContext:
    global quote_ctx
    if quote_ctx is None:
        quote_ctx = OpenQuoteContext(host=OPEND_HOST, port=OPEND_PORT)
    return quote_ctx


def cached(key: str, fn):
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_TTL:
        return hit[1]
    val = fn()
    _cache[key] = (now, val)
    return val


def fetch_expirations(symbol: str) -> dict:
    code = f"US.{symbol.upper()}"
    with _quote_lock:
        ret, df = get_ctx().get_option_expiration_date(code=code)
    if ret != RET_OK:
        raise RuntimeError(f"get_option_expiration_date: {df}")
    return {"symbol": symbol.upper(), "expirations": df["strike_time"].tolist()}


def fetch_chain(symbol: str, expiry: str) -> dict:
    code = f"US.{symbol.upper()}"
    ctx = get_ctx()
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

    # 期权快照（分批，限频 60/30s → 批间 sleep）
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
                self._send(200, cached(f"exp:{symbol}", lambda: fetch_expirations(symbol)))
            elif parsed.path == "/chain":
                symbol, expiry = qs["symbol"][0], qs["expiry"][0]
                self._send(200, cached(f"chain:{symbol}:{expiry}", lambda: fetch_chain(symbol, expiry)))
            else:
                self._send(404, {"error": "not found"})
        except KeyError as e:
            self._send(400, {"error": f"missing param {e}"})
        except Exception as e:  # noqa: BLE001
            log.exception("request failed")
            self._send(502, {"error": str(e)})


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    log.info("options service on http://%s:%d (OpenD %s:%d)", LISTEN_HOST, LISTEN_PORT, OPEND_HOST, OPEND_PORT)
    srv.serve_forever()


if __name__ == "__main__":
    main()
