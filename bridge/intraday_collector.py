#!/usr/bin/env python3
"""热门科技股分钟级数据采集器 → SQLite。

Yahoo 的 1 分钟K线只保留 7 天，本采集器持续把它们落入本地数据库，
为日后的日内策略研究/回测积累原料。

- 启动时回填每只股票过去 7 天的 1m 数据
- 美股盘中（UTC 13:30-20:30 工作日）每 30 分钟增量抓当日数据
- 盘后/周末每小时轻量巡检（无新数据时零写入）
- 存储：engine/data/intraday.db，表 bars_1m(symbol, ts, o,h,l,c,v)，
  主键 (symbol, ts) 幂等去重，WAL 模式

用法:
    python3 bridge/intraday_collector.py            # 常驻
    python3 bridge/intraday_collector.py --stats    # 查看库存统计
    python3 bridge/intraday_collector.py --once     # 跑一轮采集后退出
"""

import argparse
import json
import logging
import os
import sqlite3
import time
import urllib.request

DB_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "engine", "data", "intraday.db"
)

# Top 52 热门科技/明星股 + 核心ETF（按板块组织）
SYMBOLS = [
    # 大型科技
    "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "NVDA",
    # 半导体
    "AMD", "AVGO", "TSM", "INTC", "QCOM", "ARM", "MRVL", "TXN", "ADI", "NXPI", "ON",
    # 半导体设备
    "ASML", "AMAT", "LRCX", "KLAC", "TER",
    # 内存/存储
    "MU", "WDC", "STX", "SNDK",
    # AI 基建/算力
    "SMCI", "DELL", "VRT", "ANET", "ORCL", "PLTR", "CRWV",
    # 软件/互联网明星
    "CRM", "NOW", "SNOW", "DDOG", "NET", "CRWD", "PANW", "SHOP", "UBER", "COIN", "MSTR", "HOOD",
    # AI 电力
    "VST", "CEG",
    # 核心 ETF
    "SPY", "QQQ", "SMH", "SOXX",
]

POLL_OPEN_SEC = 30 * 60   # 盘中每30分钟
POLL_IDLE_SEC = 60 * 60   # 盘外每小时巡检
REQ_GAP_SEC = 0.35        # 请求间隔，对 Yahoo 温和

log = logging.getLogger("intraday")


def db() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS bars_1m (
            symbol TEXT NOT NULL,
            ts     INTEGER NOT NULL,  -- bar开始时刻 ms epoch (UTC)
            open REAL, high REAL, low REAL, close REAL, volume REAL,
            PRIMARY KEY (symbol, ts)
        ) WITHOUT ROWID"""
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_bars_ts ON bars_1m (ts)"
    )
    return conn


def fetch_1m(symbol: str, range_str: str) -> list[tuple]:
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol.replace('^', '%5E')}"
        f"?interval=1m&range={range_str}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        v = json.loads(r.read())
    result = v["chart"]["result"][0]
    ts = result.get("timestamp") or []
    q = result["indicators"]["quote"][0]
    rows = []
    for i, t in enumerate(ts):
        o, h, lo, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (t, o, h, lo, c):
            continue
        rows.append((symbol, t * 1000, o, h, lo, c, q["volume"][i] or 0.0))
    return rows


def collect_round(conn: sqlite3.Connection, range_str: str) -> int:
    total = 0
    for sym in SYMBOLS:
        try:
            rows = fetch_1m(sym, range_str)
            cur = conn.executemany(
                "INSERT OR IGNORE INTO bars_1m VALUES (?,?,?,?,?,?,?)", rows
            )
            conn.commit()
            total += cur.rowcount if cur.rowcount > 0 else 0
        except Exception as e:  # noqa: BLE001
            log.warning("%s fetch failed: %s", sym, e)
        time.sleep(REQ_GAP_SEC)
    return total


def market_session() -> bool:
    """粗略美股盘中: UTC 周一~五 13:30-20:30（含收盘后半小时收尾）"""
    now = time.time()
    days = int(now // 86400)
    dow = days % 7  # 0=Thu 1=Fri 2=Sat 3=Sun 4=Mon 5=Tue 6=Wed
    if dow in (2, 3):
        return False
    tod = now % 86400
    return 13.5 * 3600 <= tod <= 20.5 * 3600


def stats() -> None:
    conn = db()
    n, syms, lo, hi = conn.execute(
        "SELECT COUNT(*), COUNT(DISTINCT symbol), MIN(ts), MAX(ts) FROM bars_1m"
    ).fetchone()
    print(f"总行数: {n:,} | 标的数: {syms} | 数据库: {DB_PATH}")
    if n:
        print(f"时间范围: {time.strftime('%F %T', time.gmtime(lo/1000))} ~ "
              f"{time.strftime('%F %T', time.gmtime(hi/1000))} UTC")
        for sym, cnt in conn.execute(
            "SELECT symbol, COUNT(*) FROM bars_1m GROUP BY symbol ORDER BY 2 DESC LIMIT 10"
        ):
            print(f"  {sym:6s} {cnt:,}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stats", action="store_true")
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.stats:
        stats()
        return

    conn = db()
    log.info("启动回填：%d 只标的 × 过去7天 1m 数据…", len(SYMBOLS))
    inserted = collect_round(conn, "7d")
    log.info("回填完成，新增 %s 行", f"{inserted:,}")
    if args.once:
        return

    while True:
        in_session = market_session()
        time.sleep(POLL_OPEN_SEC if in_session else POLL_IDLE_SEC)
        if market_session():
            n = collect_round(conn, "1d")
            log.info("盘中增量采集: +%s 行", f"{n:,}")


if __name__ == "__main__":
    main()
