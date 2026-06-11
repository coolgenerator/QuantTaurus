"""moomoo 账户面板的纯计算逻辑（不依赖 futu，可单测）。

模拟环境拿不到官方 today_pl_val（仅真实环境有效），这里用
昨收 + 当日已成交订单近似还原，口径与 moomoo App 的「今日盈亏」一致：

    今日盈亏 = 未动的昨日底仓 ×（现价 − 昨收）
             + 今日卖出 ×（卖价 − 昨收）
             + 今日买入仍持有 ×（现价 − 买价）

近似极限：同一天内先买后卖（日内往返）会把卖出错配到昨日底仓上，
偏差 = 往返数量 ×（昨收 − 买价），通常远小于持仓盈亏本身。
"""

import re

# US.AAPL250620C200000 → 标的 + YYMMDD + C/P + 行权价×1000
_OPTION_RE = re.compile(r"^(?:[A-Z]+\.)?([A-Z]+)(\d{6})([CP])(\d+)$")


def parse_option_code(code: str) -> dict | None:
    """期权代码 → {underlying, expiry, opt_type, strike}；非期权返回 None。"""
    m = _OPTION_RE.match(code)
    if not m:
        return None
    sym, ymd, cp, strike = m.groups()
    return {
        "underlying": sym,
        "expiry": f"20{ymd[:2]}-{ymd[2:4]}-{ymd[4:6]}",
        "opt_type": cp,
        "strike": int(strike) / 1000.0,
    }


def today_pl(
    qty: float,
    last: float,
    prev_close: float | None,
    buys: list[tuple[float, float]],
    sells: list[tuple[float, float]],
    multiplier: float = 1.0,
) -> float | None:
    """近似今日盈亏；buys/sells 为今日已成交的 [(数量, 成交均价)]。

    昨收缺失（新上市/快照失败）时返回 None，前端显示 “—”。
    """
    if not prev_close:
        return None
    bought = sum(q for q, _ in buys)
    sold = sum(q for q, _ in sells)
    base_yesterday = qty - bought + sold
    pl = (base_yesterday - sold) * (last - prev_close)
    pl += sum(q * (p - prev_close) for q, p in sells)
    pl += sum(q * (last - p) for q, p in buys)
    return pl * multiplier


def position_pct(market_val: float, total_abs: float) -> float:
    """占总持仓比例（绝对市值口径，空头也计权重）。"""
    if total_abs <= 0:
        return 0.0
    return abs(market_val) / total_abs
