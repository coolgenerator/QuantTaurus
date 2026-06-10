//! 面板数据：股票池 × 交易日对齐的矩阵。

use qcore::Kline;
use serde::{Deserialize, Serialize};

/// 对齐后的面板。所有矩阵布局为 [symbol][t]，t 与 dates 对齐。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Panel {
    pub symbols: Vec<String>,
    pub dates: Vec<i64>,
    pub open: Vec<Vec<f64>>,
    pub high: Vec<Vec<f64>>,
    pub low: Vec<Vec<f64>>,
    pub close: Vec<Vec<f64>>,
    pub volume: Vec<Vec<f64>>,
    /// 日对数收益（t 与 dates 对齐，首日 NaN）
    pub ret1: Vec<Vec<f64>>,
}

impl Panel {
    /// 从各标的K线构建：取全体共有的交易日（按毫秒时间戳对齐），
    /// 缺日的标的对应列填 NaN（要求 ≥min_coverage 覆盖率才纳入该标的）。
    pub fn build(series: &[(String, Vec<Kline>)], min_coverage: f64) -> Self {
        use std::collections::{BTreeSet, HashMap};
        // 全部出现过的日期（用最长历史的标的做主轴：取并集再按覆盖过滤更稳）
        let mut all_dates: BTreeSet<i64> = BTreeSet::new();
        for (_, ks) in series {
            for k in ks {
                all_dates.insert(k.open_time);
            }
        }
        let dates: Vec<i64> = all_dates.into_iter().collect();
        let idx: HashMap<i64, usize> = dates.iter().enumerate().map(|(i, d)| (*d, i)).collect();
        let n = dates.len();

        let mut symbols = Vec::new();
        let (mut open, mut high, mut low, mut close, mut volume) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for (sym, ks) in series {
            if ks.is_empty() || (ks.len() as f64) < min_coverage * n as f64 {
                continue;
            }
            let mut o = vec![f64::NAN; n];
            let mut h = vec![f64::NAN; n];
            let mut l = vec![f64::NAN; n];
            let mut c = vec![f64::NAN; n];
            let mut v = vec![f64::NAN; n];
            for k in ks {
                if let Some(&i) = idx.get(&k.open_time) {
                    o[i] = k.open;
                    h[i] = k.high;
                    l[i] = k.low;
                    c[i] = k.close;
                    v[i] = k.volume;
                }
            }
            symbols.push(sym.clone());
            open.push(o);
            high.push(h);
            low.push(l);
            close.push(c);
            volume.push(v);
        }

        let ret1: Vec<Vec<f64>> = close
            .iter()
            .map(|c| {
                let mut r = vec![f64::NAN; n];
                for t in 1..n {
                    if c[t].is_finite() && c[t - 1].is_finite() && c[t - 1] > 0.0 {
                        r[t] = (c[t] / c[t - 1]).ln();
                    }
                }
                r
            })
            .collect();

        Panel {
            symbols,
            dates,
            open,
            high,
            low,
            close,
            volume,
            ret1,
        }
    }

    pub fn n_dates(&self) -> usize {
        self.dates.len()
    }
    pub fn n_symbols(&self) -> usize {
        self.symbols.len()
    }

    /// 未来 h 日对数收益（预测目标），[symbol][t]，末尾 h 个为 NaN
    pub fn forward_returns(&self, h: usize) -> Vec<Vec<f64>> {
        let n = self.n_dates();
        self.close
            .iter()
            .map(|c| {
                let mut f = vec![f64::NAN; n];
                for t in 0..n.saturating_sub(h) {
                    if c[t].is_finite() && c[t + h].is_finite() && c[t] > 0.0 {
                        f[t] = (c[t + h] / c[t]).ln();
                    }
                }
                f
            })
            .collect()
    }
}
