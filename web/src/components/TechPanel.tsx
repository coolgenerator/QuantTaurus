import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts'
import { fetchKlines, fetchTa, fmtNum, toUnixSec, type TaResponse } from '../api'

interface Props {
  symbol: string
  interval: string
}

const UP = '#34d399'
const DOWN = '#fb7185'
const DAYS = 730 // MA200 需要足够暖机 bar

const CHART_OPTS = {
  layout: {
    background: { type: ColorType.Solid, color: 'transparent' },
    textColor: '#94a3b8',
    fontSize: 11,
  },
  grid: {
    vertLines: { color: 'rgba(148,163,184,0.07)' },
    horzLines: { color: 'rgba(148,163,184,0.07)' },
  },
  crosshair: { mode: CrosshairMode.Normal },
  rightPriceScale: { borderColor: 'rgba(148,163,184,0.15)' },
  timeScale: {
    borderColor: 'rgba(148,163,184,0.15)',
    timeVisible: true,
    secondsVisible: false,
  },
  autoSize: true,
} as const

/** (number|null)[] + times → line data，跳过 null。 */
function lineData(times: number[], vals: (number | null)[]) {
  const out: { time: UTCTimestamp; value: number }[] = []
  for (let i = 0; i < times.length; i++) {
    const v = vals[i]
    if (v !== null && v !== undefined) out.push({ time: toUnixSec(times[i]) as UTCTimestamp, value: v })
  }
  return out
}

function lastVal(vals: (number | null)[]): number | null {
  for (let i = vals.length - 1; i >= 0; i--) if (vals[i] !== null) return vals[i]
  return null
}

/** 双层信号 → lightweight-charts markers（按时间升序，库要求）。 */
function buildMarkers(ta: TaResponse, showClassic: boolean, showChampion: boolean) {
  const ms: SeriesMarker<Time>[] = []
  if (showClassic) {
    for (const s of ta.classic_signals) {
      const strong = s.strength >= 2
      ms.push({
        time: toUnixSec(s.time) as UTCTimestamp,
        position: s.side === 'buy' ? 'belowBar' : 'aboveBar',
        shape: s.side === 'buy' ? 'arrowUp' : 'arrowDown',
        color: s.side === 'buy' ? UP : DOWN,
        size: strong ? 2 : 1,
        // 共振强信号才标文字，避免满屏噪音
        text: strong ? s.rules.join('+') : undefined,
      })
    }
  }
  if (showChampion) {
    for (const s of ta.champion_signals) {
      ms.push({
        time: toUnixSec(s.time) as UTCTimestamp,
        position: s.side === 'buy' ? 'belowBar' : 'aboveBar',
        shape: 'circle',
        color: s.side === 'buy' ? '#22d3ee' : '#c084fc',
        size: 1,
        text: s.rules[0],
      })
    }
  }
  ms.sort((a, b) => (a.time as number) - (b.time as number))
  return ms
}

const TREND_LABEL: Record<number, { text: string; cls: string }> = {
  1: { text: '多头趋势', cls: 'text-neon-green' },
  [-1]: { text: '空头趋势', cls: 'text-neon-red' },
  0: { text: '震荡', cls: 'text-slate-400' },
}

function Chip({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-slate-400">
      {label} <span className={`font-mono font-bold ${cls ?? 'text-slate-200'}`}>{value}</span>
    </span>
  )
}

export default function TechPanel({ symbol, interval }: Props) {
  const mainRef = useRef<HTMLDivElement>(null)
  const macdRef = useRef<HTMLDivElement>(null)
  const rsiRef = useRef<HTMLDivElement>(null)
  const kdjRef = useRef<HTMLDivElement>(null)

  const chartsRef = useRef<IChartApi[]>([])
  const seriesRef = useRef<Record<string, ISeriesApi<'Line' | 'Candlestick' | 'Histogram'>>>({})
  const taRef = useRef<TaResponse | null>(null)

  const [ta, setTa] = useState<TaResponse | null>(null)
  const [showClassic, setShowClassic] = useState(true)
  const [showChampion, setShowChampion] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 建图（一次）：主图 + MACD/RSI/KDJ 三副图，时间轴联动。
  useEffect(() => {
    const els = [mainRef.current, macdRef.current, rsiRef.current, kdjRef.current]
    if (els.some((e) => !e)) return
    const charts = els.map((el) => createChart(el!, CHART_OPTS))
    const [main, macd, rsi, kdj] = charts
    const S = seriesRef.current

    S.candle = main.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    })
    S.candle.priceScale().applyOptions({ scaleMargins: { top: 0.04, bottom: 0.1 } })
    const line = (color: string, width: 1 | 2 = 1, style = LineStyle.Solid) =>
      main.addLineSeries({
        color,
        lineWidth: width,
        lineStyle: style,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      })
    S.ma20 = line('#fbbf24', 1)
    S.ma50 = line('#22d3ee', 1)
    S.ma200 = line('#c084fc', 2)
    S.ema12 = line('rgba(251,191,36,0.5)', 1, LineStyle.Dotted)
    S.ema26 = line('rgba(34,211,238,0.5)', 1, LineStyle.Dotted)
    S.bollUp = line('rgba(148,163,184,0.45)', 1, LineStyle.Dashed)
    S.bollMid = line('rgba(148,163,184,0.3)', 1)
    S.bollDn = line('rgba(148,163,184,0.45)', 1, LineStyle.Dashed)
    // 趋势色带：底部细 histogram，绿=多头/红=空头/灰=震荡
    S.trend = main.addHistogramSeries({ priceScaleId: 'trend', priceLineVisible: false, lastValueVisible: false })
    main.priceScale('trend').applyOptions({ scaleMargins: { top: 0.97, bottom: 0 }, visible: false })

    S.macdHist = macd.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false })
    S.macdDif = macd.addLineSeries({ color: '#fbbf24', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    S.macdDea = macd.addLineSeries({ color: '#22d3ee', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })

    S.rsi = rsi.addLineSeries({ color: '#c084fc', lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
    S.rsi.createPriceLine({ price: 70, color: 'rgba(251,113,133,0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '超买' })
    S.rsi.createPriceLine({ price: 30, color: 'rgba(52,211,153,0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '超卖' })

    S.kdjK = kdj.addLineSeries({ color: '#fbbf24', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    S.kdjD = kdj.addLineSeries({ color: '#22d3ee', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    S.kdjJ = kdj.addLineSeries({ color: '#c084fc', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })

    // 时间轴四图联动（guard 防递归）
    let syncing = false
    for (const src of charts) {
      src.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (syncing || !range) return
        syncing = true
        for (const dst of charts) if (dst !== src) dst.timeScale().setVisibleLogicalRange(range)
        syncing = false
      })
    }

    chartsRef.current = charts
    return () => {
      charts.forEach((c) => c.remove())
      chartsRef.current = []
      seriesRef.current = {}
    }
  }, [])

  // 数据加载：K线 + TA 并行，按时间对齐（两次请求间可能差一根 bar）。
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([fetchKlines(symbol, interval, DAYS), fetchTa(symbol, interval, DAYS)])
      .then(([klines, taResp]) => {
        if (cancelled || !chartsRef.current.length) return
        const S = seriesRef.current
        const taTimes = new Set(taResp.times.map(toUnixSec))
        S.candle.setData(
          klines
            .filter((k) => taTimes.has(toUnixSec(k.open_time)))
            .map((k) => ({
              time: toUnixSec(k.open_time) as UTCTimestamp,
              open: k.open,
              high: k.high,
              low: k.low,
              close: k.close,
            })),
        )
        const t = taResp.times
        S.ma20.setData(lineData(t, taResp.ma20))
        S.ma50.setData(lineData(t, taResp.ma50))
        S.ma200.setData(lineData(t, taResp.ma200))
        S.ema12.setData(lineData(t, taResp.ema12))
        S.ema26.setData(lineData(t, taResp.ema26))
        S.bollUp.setData(lineData(t, taResp.boll_up))
        S.bollMid.setData(lineData(t, taResp.boll_mid))
        S.bollDn.setData(lineData(t, taResp.boll_dn))
        S.trend.setData(
          t.map((tm, i) => ({
            time: toUnixSec(tm) as UTCTimestamp,
            value: 1,
            color:
              taResp.trend[i] === 1
                ? 'rgba(52,211,153,0.8)'
                : taResp.trend[i] === -1
                  ? 'rgba(251,113,133,0.8)'
                  : 'rgba(148,163,184,0.35)',
          })),
        )
        S.macdHist.setData(
          t.flatMap((tm, i) => {
            const v = taResp.macd_hist[i]
            if (v === null) return []
            return [{ time: toUnixSec(tm) as UTCTimestamp, value: v, color: v >= 0 ? 'rgba(52,211,153,0.6)' : 'rgba(251,113,133,0.6)' }]
          }),
        )
        S.macdDif.setData(lineData(t, taResp.macd_dif))
        S.macdDea.setData(lineData(t, taResp.macd_dea))
        S.rsi.setData(lineData(t, taResp.rsi14))
        S.kdjK.setData(lineData(t, taResp.kdj_k))
        S.kdjD.setData(lineData(t, taResp.kdj_d))
        S.kdjJ.setData(lineData(t, taResp.kdj_j))
        chartsRef.current[0]?.timeScale().fitContent()
        taRef.current = taResp
        setTa(taResp)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [symbol, interval])

  // 信号层开关 → 重建 markers。
  useEffect(() => {
    const candle = seriesRef.current.candle as ISeriesApi<'Candlestick'> | undefined
    if (!candle || !ta) return
    candle.setMarkers(buildMarkers(ta, showClassic, showChampion))
  }, [ta, showClassic, showChampion])

  const trendNow = ta ? TREND_LABEL[ta.trend[ta.trend.length - 1] ?? 0] : null
  const rsiNow = ta ? lastVal(ta.rsi14) : null

  return (
    <section className="glass-card relative flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="panel-title">技术分析 · Technical Analysis</h2>
          <p className="font-mono text-lg font-bold text-slate-100">
            {symbol} <span className="text-sm font-medium text-slate-500">· {interval} · {DAYS}d</span>
            {trendNow && <span className={`ml-3 text-sm font-bold ${trendNow.cls}`}>{trendNow.text}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ta && (
            <>
              <Chip label="MA20" value={fmtNum(lastVal(ta.ma20))} cls="text-amber-300" />
              <Chip label="MA50" value={fmtNum(lastVal(ta.ma50))} cls="text-neon-cyan" />
              <Chip label="MA200" value={fmtNum(lastVal(ta.ma200))} cls="text-purple-300" />
              <Chip
                label="RSI14"
                value={fmtNum(rsiNow, 1)}
                cls={rsiNow !== null && rsiNow > 70 ? 'text-neon-red' : rsiNow !== null && rsiNow < 30 ? 'text-neon-green' : undefined}
              />
            </>
          )}
          <button
            onClick={() => setShowClassic((v) => !v)}
            className={`rounded-full border px-3 py-1 text-xs font-bold transition ${
              showClassic
                ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-300'
                : 'border-white/10 text-slate-500 hover:text-slate-300'
            }`}
          >
            ▲▼ 经典信号 {ta ? ta.classic_signals.length : ''}
          </button>
          <button
            onClick={() => setShowChampion((v) => !v)}
            disabled={!!ta && !ta.champion}
            title={ta && !ta.champion ? '该标的暂无冠军策略' : undefined}
            className={`rounded-full border px-3 py-1 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${
              showChampion
                ? 'border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan'
                : 'border-white/10 text-slate-500 hover:text-slate-300'
            }`}
          >
            ◉ 冠军信号 {ta?.champion ? ta.champion_signals.length : '无'}
          </button>
        </div>
      </div>

      <p className="text-[11px] leading-snug text-slate-500">
        经典信号为教科书口径（MACD金叉死叉 / RSI超买超卖 / 布林触轨收回 / KDJ高低位交叉 /
        神奇九转TD9 / MACD·RSI顶底背离 / 均线金叉死叉 / 多头空头排列 /
        唐奇安20日突破·放量突破——背离标注在第二摆动点确认后第4根bar，唐奇安同向10根内只标首次），
        <span className="text-amber-400/80">未经回测闸门验证，仅供参考</span>；大箭头 =
        同日多规则共振。◉ 冠军信号来自 evolve 闸门验证过的策略实际翻仓点。底部色带 =
        趋势（价格与MA50相对MA200位置）。
      </p>

      <div ref={mainRef} className="h-[400px] w-full" />
      <div className="grid grid-cols-1 gap-1">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-slate-500">MACD (12,26,9)</p>
          <div ref={macdRef} className="h-[120px] w-full" />
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-slate-500">RSI 14</p>
          <div ref={rsiRef} className="h-[110px] w-full" />
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-slate-500">KDJ (9,3,3)</p>
          <div ref={kdjRef} className="h-[110px] w-full" />
        </div>
      </div>

      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-ink/60">
          <span className="text-sm text-slate-400">computing indicators…</span>
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {error}（提示：数据不足 300 根K线时此页不可用，可换标的或周期）
        </div>
      )}
    </section>
  )
}
