"""account_math 纯函数单测：python3 bridge/test_account_math.py"""

import unittest

from account_math import parse_option_code, position_pct, today_pl


class TestTodayPl(unittest.TestCase):
    def test_no_trades_today(self):
        # 昨日持有 10 股，昨收 100 → 现价 103：今日盈亏 = 10×3
        self.assertAlmostEqual(today_pl(10, 103.0, 100.0, [], []), 30.0)

    def test_bought_today_still_held(self):
        # 昨日 0 股，今日 101 买入 10 股，现价 103 → 10×(103−101)
        self.assertAlmostEqual(today_pl(10, 103.0, 100.0, [(10, 101.0)], []), 20.0)

    def test_mixed_old_and_new(self):
        # 昨日底仓 5（昨收100），今日 101 加仓 5，现价 103
        # = 5×3 + 5×2 = 25
        self.assertAlmostEqual(today_pl(10, 103.0, 100.0, [(5, 101.0)], []), 25.0)

    def test_sold_all_today(self):
        # 昨日 10 股，今日 102 全部卖出 → 10×(102−100)，现价无关
        self.assertAlmostEqual(today_pl(0, 999.0, 100.0, [], [(10, 102.0)]), 20.0)

    def test_partial_sell(self):
        # 昨日 10 股，今日 102 卖 4，现价 103：剩 6×3 + 卖 4×2 = 26
        self.assertAlmostEqual(today_pl(6, 103.0, 100.0, [], [(4, 102.0)]), 26.0)

    def test_option_multiplier(self):
        # 期权 2 张昨日持有，每股涨 0.5 → 2×0.5×100
        self.assertAlmostEqual(today_pl(2, 3.5, 3.0, [], [], multiplier=100), 100.0)

    def test_missing_prev_close_returns_none(self):
        self.assertIsNone(today_pl(10, 103.0, None, [], []))
        self.assertIsNone(today_pl(10, 103.0, 0.0, [], []))


class TestPositionPct(unittest.TestCase):
    def test_basic(self):
        self.assertAlmostEqual(position_pct(2500.0, 10000.0), 0.25)

    def test_negative_market_val_uses_abs(self):
        self.assertAlmostEqual(position_pct(-2500.0, 10000.0), 0.25)

    def test_zero_total(self):
        self.assertEqual(position_pct(100.0, 0.0), 0.0)


class TestParseOptionCode(unittest.TestCase):
    def test_call(self):
        p = parse_option_code("US.AAPL250620C200000")
        self.assertEqual(p, {
            "underlying": "AAPL", "expiry": "2025-06-20",
            "opt_type": "C", "strike": 200.0,
        })

    def test_put_fractional_strike(self):
        p = parse_option_code("US.SOFI260116P22500")
        self.assertEqual(p["opt_type"], "P")
        self.assertAlmostEqual(p["strike"], 22.5)
        self.assertEqual(p["expiry"], "2026-01-16")

    def test_plain_stock_returns_none(self):
        self.assertIsNone(parse_option_code("US.AAPL"))
        self.assertIsNone(parse_option_code("US.BRK.B"))


if __name__ == "__main__":
    unittest.main()
