"""锁/限频回归测试:后台预热线程不得拿着 _quote_lock 等配额堵死交互请求。

复现 2026-06 的持仓页永久卡死:后台线程持锁在 _od_throttle 里无限让路,
交互请求卡在等锁,_interactive 永不归零 → 互相等死。
"""
import threading
import time
import unittest

import pandas as pd

import options_service as svc


class FakeCtx:
    def get_option_expiration_date(self, code):
        return svc.RET_OK, pd.DataFrame({"strike_time": ["2026-07-17", "2026-08-21"]})


class DeadlockRegression(unittest.TestCase):
    def setUp(self):
        svc.quote_ctx = FakeCtx()  # 绕过真实 OpenD
        svc._cache.clear()
        svc._od_calls.clear()

    def test_interactive_not_blocked_by_background_throttle(self):
        # 模拟一个被前端 abort 后泄漏的交互计数(老 bug 的触发条件)
        with svc._interactive_lock:
            svc._interactive += 1
        try:
            # 耗尽后台配额(5/30s),迫使后台线程进入 throttle 等待
            svc._od_calls[:] = [time.time()] * 5

            def bg():
                svc.fetch_expirations("SPY")

            threading.Thread(target=bg, name="options-plans", daemon=True).start()
            time.sleep(0.5)  # 让后台线程先跑进 throttle

            ok = threading.Event()

            def fg():
                with svc.interactive_request():
                    svc.fetch_expirations("QQQ")
                ok.set()

            threading.Thread(target=fg, daemon=True).start()
            self.assertTrue(
                ok.wait(timeout=6.0),
                "交互请求被后台线程持锁堵死(_od_throttle 不得在持有 _quote_lock 时调用)",
            )
        finally:
            with svc._interactive_lock:
                svc._interactive -= 1


class CachedInflightDedup(unittest.TestCase):
    def setUp(self):
        svc._cache.clear()

    def test_stale_served_while_refresh_inflight(self):
        """有旧值时,刷新已在飞的并发请求应立即拿旧值,而不是排队重算。"""
        svc._cache["k"] = (time.time() - 9999, {"v": "stale"})
        gate = threading.Event()

        def slow_fn():
            gate.wait(timeout=10)
            return {"v": "fresh"}

        t = threading.Thread(target=lambda: svc.cached("k", slow_fn, ttl=1), daemon=True)
        t.start()
        time.sleep(0.3)  # 让刷新线程进入 slow_fn
        t0 = time.time()
        out = svc.cached("k", lambda: {"v": "should-not-run"}, ttl=1)
        self.assertLess(time.time() - t0, 1.0, "并发请求不应等待在飞刷新")
        self.assertEqual(out["v"], "stale")
        gate.set()
        t.join(timeout=5)
        self.assertEqual(svc._cache["k"][1]["v"], "fresh")


if __name__ == "__main__":
    unittest.main()
