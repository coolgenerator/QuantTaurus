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
import { fetchKlines, fetchTa, fetchTaStats, fmtNum, toUnixSec, type DistStat, type TaResponse, type TaRuleStat, type TaStatsResponse } from '../api'

interface Props {
  symbol: string
  interval: string
}

const UP = '#34d399'
const DOWN = '#fb7185'
const INITIAL_DAYS = 730 // MA200 需要足够暖机 bar
/** 左滑加载的天数上限：日线20年；小时级数据源最多~4年 */
const maxDays = (interval: string) => (interval === '1d' ? 7300 : 1460)

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

type ClassicMode = 'lite' | 'all' | 'off'

/** 双层信号 → markers。文字一律不上图（细节走 hover），精简模式只画共振强信号。 */
function buildMarkers(ta: TaResponse, classicMode: ClassicMode, showChampion: boolean) {
  const ms: SeriesMarker<Time>[] = []
  if (classicMode !== 'off') {
    for (const s of ta.classic_signals) {
      const strong = s.strength >= 2
      if (classicMode === 'lite' && !strong) continue
      ms.push({
        time: toUnixSec(s.time) as UTCTimestamp,
        position: s.side === 'buy' ? 'belowBar' : 'aboveBar',
        shape: s.side === 'buy' ? 'arrowUp' : 'arrowDown',
        color: s.side === 'buy' ? UP : DOWN,
        size: strong ? 2 : 1,
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
      })
    }
  }
  ms.sort((a, b) => (a.time as number) - (b.time as number))
  return ms
}

interface BarSignal {
  side: 'buy' | 'sell'
  rules: string[]
  price: number
  layer: 'classic' | 'champion'
}

/** unix秒 → 该 bar 全部信号（含被精简模式隐藏的），hover 提示用。 */
function buildSigMap(ta: TaResponse) {
  const m = new Map<number, BarSignal[]>()
  const add = (t: number, sig: BarSignal) => {
    const arr = m.get(t)
    if (arr) arr.push(sig)
    else m.set(t, [sig])
  }
  for (const s of ta.classic_signals)
    add(toUnixSec(s.time), { side: s.side, rules: s.rules, price: s.price, layer: 'classic' })
  for (const s of ta.champion_signals)
    add(toUnixSec(s.time), { side: s.side, rules: s.rules, price: s.price, layer: 'champion' })
  return m
}

/** 10日收益分布缩略图：左5箱(≤0)红、右5箱(>0)绿。 */
function HistThumb({ hist, big = false }: { hist: number[]; big?: boolean }) {
  const max = Math.max(...hist, 1)
  const w = big ? 9 : 6
  const gap = 1
  const H = big ? 40 : 26
  return (
    <svg width={hist.length * (w + gap)} height={H} className="shrink-0">
      {hist.map((v, i) => {
        const h = Math.max(1, (v / max) * (H - 2))
        return (
          <rect
            key={i}
            x={i * (w + gap)}
            y={H - h}
            width={w}
            height={h}
            rx={1}
            fill={i < 5 ? '#fb7185' : '#34d399'}
            opacity={0.85}
          />
        )
      })}
    </svg>
  )
}

/** 总分布卡片：方向 n/胜率/期望/中位 + 大号直方图。 */
function DistCard({ title, d, cls }: { title: string; d: DistStat; cls: string }) {
  const e = d.avg10 * 100
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-white/5 px-3 py-2">
      <div>
        <p className={`text-xs font-bold ${cls}`}>{title}</p>
        <p className="font-mono text-sm font-bold text-slate-200">
          E {e >= 0 ? '+' : ''}
          {e.toFixed(2)}%
          <span className="ml-2 text-xs font-medium text-slate-400">
            胜率 {(d.win10 * 100).toFixed(1)}% · 中位 {(d.med10 * 100).toFixed(2)}%
          </span>
        </p>
        <p className="text-[10px] text-slate-500">n = {d.n.toLocaleString()}（10日符号化收益）</p>
      </div>
      <HistThumb hist={d.hist} big />
    </div>
  )
}

/** 1..20日期望收益曲线缩略图（虚线=零轴）。 */
function CurveThumb({ curve }: { curve: number[] }) {
  const w = 64
  const h = 26
  const amax = Math.max(...curve.map(Math.abs), 1e-9)
  const pts = curve
    .map((v, i) => `${((i / (curve.length - 1)) * w).toFixed(1)},${(h / 2 - (v / amax) * (h / 2 - 2)).toFixed(1)}`)
    .join(' ')
  const up = curve[curve.length - 1] >= 0
  return (
    <svg width={w} height={h} className="shrink-0">
      <line x1={0} y1={h / 2} x2={w} y2={h / 2} stroke="rgba(148,163,184,0.3)" strokeDasharray="2 2" />
      <polyline points={pts} fill="none" stroke={up ? '#34d399' : '#fb7185'} strokeWidth={1.5} />
    </svg>
  )
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
  const tipRef = useRef<HTMLDivElement>(null)

  const chartsRef = useRef<IChartApi[]>([])
  const seriesRef = useRef<Record<string, ISeriesApi<'Line' | 'Candlestick' | 'Histogram'>>>({})
  const taRef = useRef<TaResponse | null>(null)
  const sigMapRef = useRef<Map<number, BarSignal[]>>(new Map())

  const [days, setDays] = useState(INITIAL_DAYS)
  // 左滑加载更多：防重入 + 记录上次成功加载的 symbol|interval（区分"加载更早"与"换标的"）
  const fetchingRef = useRef(false)
  const loadedKeyRef = useRef('')
  const loadMoreRef = useRef<() => void>(() => {})

  const [ta, setTa] = useState<TaResponse | null>(null)
  const [stats, setStats] = useState<TaStatsResponse | null>(null)
  const [statScope, setStatScope] = useState<'uni' | 'sym'>('uni')
  const statsRef = useRef<Map<string, TaRuleStat>>(new Map())
  // 当前标的的规则级统计（rule → stat），hover 提示"本标的"行用
  const symStatsRef = useRef<Map<string, { win10: number; avg10: number; n: number }>>(new Map())
  const [classicMode, setClassicMode] = useState<ClassicMode>('lite')
  const [showChampion, setShowChampion] = useState(true)
  const [showEma, setShowEma] = useState(false)
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
    S.ema12.applyOptions({ visible: false })
    S.ema26.applyOptions({ visible: false })
    S.bollUp = line('rgba(148,163,184,0.45)', 1, LineStyle.Dashed)
    S.bollMid = line('rgba(148,163,184,0.3)', 1)
    S.bollDn = line('rgba(148,163,184,0.45)', 1, LineStyle.Dashed)
    // SuperTrend(10,3)：多头段绿轨在价格下方，空头段红轨在上方
    S.stUp = line('rgba(52,211,153,0.85)', 2)
    S.stDn = line('rgba(251,113,133,0.85)', 2)
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

    // hover 提示：crosshair 落在有信号的 bar 上时，浮层显示当天全部信号明细
    main.subscribeCrosshairMove((param) => {
      const tip = tipRef.current
      const wrap = mainRef.current
      if (!tip || !wrap) return
      const sigs = param.time != null ? sigMapRef.current.get(param.time as number) : undefined
      if (!sigs?.length || !param.point) {
        tip.style.display = 'none'
        return
      }
      const date = new Date((param.time as number) * 1000).toISOString().slice(0, 10)
      tip.innerHTML =
        `<div style="color:#64748b;font-family:monospace;margin-bottom:4px">${date}</div>` +
        sigs
          .map((s) => {
            const color = s.side === 'buy' ? UP : DOWN
            const icon = s.layer === 'champion' ? '◉' : s.side === 'buy' ? '▲' : '▼'
            const tag = s.layer === 'champion' ? '冠军' : s.side === 'buy' ? '买' : '卖'
            const head = `<div style="color:${color};line-height:1.5">${icon} ${tag} · ${s.rules.join(' + ')} <span style="color:#64748b">@${s.price.toFixed(2)}</span></div>`
            // 每条规则附历史统计（52标的×10年）：胜率 / 10日期望 / 期望止盈日
            const statLines = s.layer === 'classic'
              ? s.rules
                  .map((r) => {
                    const st = statsRef.current.get(r)
                    if (!st) return ''
                    const e = st.avg10 * 100
                    const sy = symStatsRef.current.get(r)
                    const symPart = sy
                      ? ` · 本标的 ${(sy.win10 * 100).toFixed(0)}%/${sy.avg10 >= 0 ? '+' : ''}${(sy.avg10 * 100).toFixed(1)}% (n=${sy.n})`
                      : ''
                    return `<div style="color:#64748b;padding-left:14px;line-height:1.4">${r}: 胜率${(st.win10 * 100).toFixed(0)}% · E10d ${e >= 0 ? '+' : ''}${e.toFixed(1)}% · 止盈~${st.exp_tp_day.toFixed(0)}d (n=${st.n})${symPart}</div>`
                  })
                  .join('')
              : ''
            return head + statLines
          })
          .join('')
      tip.style.display = 'block'
      const x = Math.max(4, Math.min(param.point.x + 14, wrap.clientWidth - tip.offsetWidth - 8))
      const y = Math.max(4, param.point.y - tip.offsetHeight - 12)
      tip.style.left = `${x}px`
      tip.style.top = `${y}px`
    })

    // 左滑触底自动加载更早历史（视野贴近最左10根bar时触发）
    main.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range && range.from < 10) loadMoreRef.current()
    })

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

  // 最新闭包：左滑加载更早数据（翻倍直到上限）
  loadMoreRef.current = () => {
    if (fetchingRef.current || loading) return
    const max = maxDays(interval)
    if (days >= max) return
    setDays(Math.min(days * 2, max))
  }

  // 数据加载：K线 + TA 并行，按时间对齐（两次请求间可能差一根 bar）。
  useEffect(() => {
    const key = `${symbol}|${interval}`
    // 换标的/周期：先把窗口重置回初始值（本次effect让位给重置后的那次）
    if (loadedKeyRef.current !== key && days !== INITIAL_DAYS) {
      setDays(INITIAL_DAYS)
      return
    }
    const isMore = loadedKeyRef.current === key
    let cancelled = false
    fetchingRef.current = true
    setLoading(!isMore) // 加载更早历史时不盖全屏遮罩
    setError(null)
    Promise.all([fetchKlines(symbol, interval, days), fetchTa(symbol, interval, days)])
      .then(([klines, taResp]) => {
        if (cancelled || !chartsRef.current.length) return
        const prevLen = taRef.current?.times.length ?? 0
        const viewRange = chartsRef.current[0].timeScale().getVisibleLogicalRange()
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
        S.stUp.setData(lineData(t, taResp.st_up))
        S.stDn.setData(lineData(t, taResp.st_dn))
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
        // 加载更早历史：按新增bar数平移视野，画面不跳；换标的则适配全幅
        if (isMore && viewRange && taResp.times.length > prevLen) {
          const shift = taResp.times.length - prevLen
          chartsRef.current[0]
            .timeScale()
            .setVisibleLogicalRange({ from: viewRange.from + shift, to: viewRange.to + shift })
        } else if (!isMore) {
          chartsRef.current[0]?.timeScale().fitContent()
        }
        loadedKeyRef.current = key
        fetchingRef.current = false
        taRef.current = taResp
        sigMapRef.current = buildSigMap(taResp)
        setTa(taResp)
        setLoading(false)
      })
      .catch((e: unknown) => {
        fetchingRef.current = false
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
      fetchingRef.current = false
    }
  }, [symbol, interval, days])

  // 信号层开关 → 重建 markers。
  useEffect(() => {
    const candle = seriesRef.current.candle as ISeriesApi<'Candlestick'> | undefined
    if (!candle || !ta) return
    candle.setMarkers(buildMarkers(ta, classicMode, showChampion))
  }, [ta, classicMode, showChampion])

  // EMA 虚线显隐
  useEffect(() => {
    seriesRef.current.ema12?.applyOptions({ visible: showEma })
    seriesRef.current.ema26?.applyOptions({ visible: showEma })
  }, [showEma])

  // 规则历史统计：全宇宙一份，挂载时拉取（服务端6h缓存，首算~10s）
  useEffect(() => {
    let cancelled = false
    fetchTaStats()
      .then((s) => {
        if (cancelled) return
        statsRef.current = new Map(s.rules.map((r) => [r.rule, r]))
        setStats(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // 当前标的的规则级统计映射（tooltip 的"本标的"行）
  useEffect(() => {
    symStatsRef.current = new Map(
      (stats?.symbol_rules ?? [])
        .filter((r) => r.symbol === symbol)
        .map((r) => [r.rule, { win10: r.win10, avg10: r.avg10, n: r.n }]),
    )
  }, [stats, symbol])

  const trendNow = ta ? TREND_LABEL[ta.trend[ta.trend.length - 1] ?? 0] : null
  const rsiNow = ta ? lastVal(ta.rsi14) : null
  const adxNow = ta ? lastVal(ta.adx) : null

  return (
    <section className="glass-card relative flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="panel-title">技术分析 · Technical Analysis</h2>
          <p className="font-mono text-lg font-bold text-slate-100">
            {symbol} <span className="text-sm font-medium text-slate-500">· {interval} · {days}d（左滑自动加载更早）</span>
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
              <Chip
                label="ADX14"
                value={adxNow !== null ? `${fmtNum(adxNow, 1)} ${adxNow > 25 ? '强趋势' : '弱趋势'}` : '—'}
                cls={adxNow !== null && adxNow > 25 ? 'text-amber-300' : undefined}
              />
            </>
          )}
          <div className="flex overflow-hidden rounded-full border border-white/10 text-xs font-bold">
            {(
              [
                ['lite', `精简 ${ta ? ta.classic_signals.filter((s) => s.strength >= 2).length : ''}`],
                ['all', `全部 ${ta ? ta.classic_signals.length : ''}`],
                ['off', '关'],
              ] as [ClassicMode, string][]
            ).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setClassicMode(mode)}
                className={`px-3 py-1 transition ${
                  classicMode === mode
                    ? 'bg-emerald-400/15 text-emerald-300'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowEma((v) => !v)}
            className={`rounded-full border px-3 py-1 text-xs font-bold transition ${
              showEma
                ? 'border-amber-400/50 bg-amber-400/10 text-amber-300'
                : 'border-white/10 text-slate-500 hover:text-slate-300'
            }`}
          >
            EMA
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
        ▲▼ 经典信号（36种规则·六大类，<span className="text-amber-400/80">未经回测验证仅供参考</span>）：
        精简模式只画同日多规则共振的大箭头，<span className="text-slate-300">鼠标悬停任意信号 bar
        可看当天全部规则明细</span>。◉ 冠军 = evolve 闸门策略翻仓点。主图绿/红轨道 =
        SuperTrend(10,3)，底部色带 = 均线趋势。
      </p>

      <div className="relative">
        <div ref={mainRef} className="h-[400px] w-full" />
        <div
          ref={tipRef}
          className="pointer-events-none absolute z-20 hidden max-w-[340px] rounded-lg border border-white/10 bg-slate-900/95 px-3 py-2 text-xs shadow-xl"
        />
      </div>
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

      {/* 规则统计：53标的×20年历史，总分布 + 按规则 / 按规则×当前标的 两档 */}
      <div className="mt-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] uppercase tracking-widest text-slate-500">
            规则统计 · Rule Stats{' '}
            {stats && (
              <span className="normal-case tracking-normal">
                （{stats.symbols}标的 · {(stats.events / 1000).toFixed(0)}k 信号事件 · {stats.years}年日线）
              </span>
            )}
          </p>
          <div className="flex overflow-hidden rounded-full border border-white/10 text-xs font-bold">
            {(
              [
                ['uni', '全宇宙'],
                ['sym', `当前标的 ${symbol}`],
              ] as ['uni' | 'sym', string][]
            ).map(([sc, label]) => (
              <button
                key={sc}
                onClick={() => setStatScope(sc)}
                className={`px-3 py-1 transition ${
                  statScope === sc ? 'bg-neon-cyan/15 text-neon-cyan' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="mb-1 text-[11px] leading-snug text-slate-500">
          口径：信号后10个交易日的符号化收益（卖出信号=做空视角，跌了才算赢）；止盈日 =
          20日内收益峰值出现日的均值；直方图 = 10日收益分布（红≤0 / 绿&gt;0，±2.5%分箱）。
          <span className="text-amber-400/80">
            同一规则在不同个股上期望差异巨大（如九买：PLTR +7.7% vs COIN -0.9%），
            全体均值仅是先验，请结合"当前标的"档查看；样本跨标的同期相关且窗口重叠，仅供参考。
          </span>
        </p>
        {!stats ? (
          <p className="py-3 text-center text-xs text-slate-500">统计计算中（首次约10秒）…</p>
        ) : (
          <>
            {/* 总概率分布卡片：全宇宙或当前标的的买/卖两方向 */}
            <div className="mb-2 grid grid-cols-1 gap-2 md:grid-cols-2">
              {(() => {
                const st = statScope === 'sym' ? stats.symbol_totals.find((s) => s.symbol === symbol) : null
                const buy = statScope === 'sym' ? st?.buy : stats.total_buy
                const sell = statScope === 'sym' ? st?.sell : stats.total_sell
                const tag = statScope === 'sym' ? symbol : '全宇宙'
                if (!buy || !sell)
                  return (
                    <p className="col-span-full py-2 text-center text-xs text-slate-500">
                      {symbol} 不在统计宇宙内（仅覆盖美股/ETF）
                    </p>
                  )
                return (
                  <>
                    <DistCard title={`▲ ${tag} · 全部买入信号总分布`} d={buy} cls="text-neon-green" />
                    <DistCard title={`▼ ${tag} · 全部卖出信号总分布（做空视角）`} d={sell} cls="text-neon-red" />
                  </>
                )
              })()}
            </div>

            <div className="max-h-[420px] overflow-y-auto rounded-lg border border-white/5">
              <table className="w-full text-right text-[11px] tabular-nums">
                <thead className="sticky top-0 bg-panel/95 text-slate-500 backdrop-blur">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">规则</th>
                    <th className="px-2 py-1.5 font-medium">n</th>
                    <th className="px-2 py-1.5 font-medium">胜率</th>
                    <th className="px-2 py-1.5 font-medium">E·10d</th>
                    <th className="px-2 py-1.5 font-medium">止盈日</th>
                    <th className="px-2 py-1.5 text-center font-medium">10d分布</th>
                    {statScope === 'uni' && <th className="px-2 py-1.5 text-center font-medium">期望路径</th>}
                  </tr>
                </thead>
                <tbody>
                  {(statScope === 'uni'
                    ? stats.rules
                    : stats.symbol_rules.filter((r) => r.symbol === symbol)
                  ).map((r) => {
                    const pos = r.avg10 >= 0
                    return (
                      <tr key={r.rule} className="border-t border-white/5 hover:bg-white/5">
                        <td className="px-2 py-1 text-left">
                          <span className={r.side === 'buy' ? 'text-neon-green' : 'text-neon-red'}>
                            {r.side === 'buy' ? '▲' : '▼'}
                          </span>{' '}
                          <span className="text-slate-200">{r.rule}</span>
                        </td>
                        <td className={`px-2 py-1 ${r.n < 100 ? 'text-slate-600' : 'text-slate-400'}`}>{r.n}</td>
                        <td className={`px-2 py-1 ${r.win10 >= 0.55 ? 'text-neon-green' : r.win10 < 0.45 ? 'text-neon-red' : 'text-slate-300'}`}>
                          {(r.win10 * 100).toFixed(1)}%
                        </td>
                        <td className={`px-2 py-1 font-bold ${pos ? 'text-neon-green' : 'text-neon-red'}`}>
                          {pos ? '+' : ''}
                          {(r.avg10 * 100).toFixed(2)}%
                        </td>
                        <td className="px-2 py-1 text-slate-400">{r.exp_tp_day.toFixed(1)}d</td>
                        <td className="px-2 py-1">
                          <div className="flex justify-center"><HistThumb hist={r.hist} /></div>
                        </td>
                        {statScope === 'uni' && 'curve' in r && (
                          <td className="px-2 py-1">
                            <div className="flex justify-center"><CurveThumb curve={(r as TaRuleStat).curve} /></div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {statScope === 'sym' && stats.symbol_rules.filter((r) => r.symbol === symbol).length === 0 && (
                <p className="py-3 text-center text-xs text-slate-500">
                  该标的无 n≥8 的规则样本（上市时间短或不在统计宇宙）
                </p>
              )}
            </div>
          </>
        )}
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
