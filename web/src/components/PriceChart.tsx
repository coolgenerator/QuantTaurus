import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { fetchKlines, fmtNum, toUnixSec, type Kline } from '../api'
import { useI18n } from '../i18n'
import { useWsMessages } from '../ws'

interface Props {
  symbol: string
  interval: string
}

const UP = '#34d399'
const DOWN = '#fb7185'
const INITIAL_DAYS = 365
/** 左滑加载的天数上限（数据源历史深度）：日/周/月线20年；1h约2年；5m/30m约60天；1m约7天 */
const maxDays = (iv: string) =>
  iv === '1d' || iv === '1w' || iv === '1mo'
    ? 7300
    : iv === '1m'
      ? 7
      : iv === '5m' || iv === '30m'
        ? 59
        : 1460
/** 初始窗口：周/月线直接拉满20年（bar数少），其余取默认与上限的较小值 */
const initialDays = (iv: string, base: number) =>
  iv === '1w' || iv === '1mo' ? 7300 : Math.min(base, maxDays(iv))

function klineToCandle(k: Kline) {
  return {
    time: toUnixSec(k.open_time) as UTCTimestamp,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
  }
}

function klineToVolume(k: Kline) {
  return {
    time: toUnixSec(k.open_time) as UTCTimestamp,
    value: k.volume,
    color: k.close >= k.open ? 'rgba(52,211,153,0.35)' : 'rgba(251,113,133,0.35)',
  }
}

export default function PriceChart({ symbol, interval }: Props) {
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const lastBarTimeRef = useRef<number>(0)
  // 左滑加载更早历史
  const [days, setDays] = useState(() => initialDays(interval, INITIAL_DAYS))
  const fetchingRef = useRef(false)
  const loadedKeyRef = useRef('')
  const lastLenRef = useRef(0)
  const loadMoreRef = useRef<() => void>(() => {})

  const [last, setLast] = useState<{ price: number; dir: 'up' | 'down' | 'flat'; tick: number }>({
    price: 0,
    dir: 'flat',
    tick: 0,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  loadMoreRef.current = () => {
    if (fetchingRef.current || loading) return
    const max = maxDays(interval)
    if (days >= max) return
    setDays(Math.min(days * 2, max))
  }

  // Create chart once.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const chart = createChart(el, {
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
    })
    const candle = chart.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    })
    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    })
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    })
    candle.priceScale().applyOptions({
      scaleMargins: { top: 0.06, bottom: 0.22 },
    })

    // 左滑触底自动加载更早历史
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range && range.from < 10) loadMoreRef.current()
    })

    chartRef.current = chart
    candleRef.current = candle
    volumeRef.current = volume
    return () => {
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
    }
  }, [])

  // Load history when symbol/interval/days changes; days growth = 左滑加载更早.
  useEffect(() => {
    const key = `${symbol}|${interval}`
    const init = initialDays(interval, INITIAL_DAYS)
    if (loadedKeyRef.current !== key && days !== init) {
      setDays(init) // 换标的/周期先重置窗口，让位给重置后的那次加载
      return
    }
    const isMore = loadedKeyRef.current === key
    let cancelled = false
    fetchingRef.current = true
    setLoading(!isMore)
    setError(null)
    if (!isMore) lastBarTimeRef.current = 0
    fetchKlines(symbol, interval, days)
      .then((klines) => {
        if (cancelled || !candleRef.current || !volumeRef.current) return
        const viewRange = chartRef.current?.timeScale().getVisibleLogicalRange()
        candleRef.current.setData(klines.map(klineToCandle))
        volumeRef.current.setData(klines.map(klineToVolume))
        if (isMore && viewRange && klines.length > lastLenRef.current) {
          const shift = klines.length - lastLenRef.current
          chartRef.current
            ?.timeScale()
            .setVisibleLogicalRange({ from: viewRange.from + shift, to: viewRange.to + shift })
        } else if (!isMore) {
          chartRef.current?.timeScale().fitContent()
        }
        lastLenRef.current = klines.length
        loadedKeyRef.current = key
        fetchingRef.current = false
        const lastK = klines[klines.length - 1]
        if (lastK) {
          lastBarTimeRef.current = toUnixSec(lastK.open_time)
          if (!isMore) setLast({ price: lastK.close, dir: 'flat', tick: 0 })
        }
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

  // Live updates over WS — only when symbol/interval match.
  useWsMessages((msg) => {
    if (msg.channel !== 'market' || msg.type !== 'kline') return
    if (msg.symbol !== symbol || msg.interval !== interval) return
    const barTime = toUnixSec(msg.kline.open_time)
    // Never update with an older bar (chart would throw).
    if (barTime < lastBarTimeRef.current) return
    lastBarTimeRef.current = barTime
    candleRef.current?.update(klineToCandle(msg.kline))
    volumeRef.current?.update(klineToVolume(msg.kline))
    const price = msg.kline.close
    setLast((prev) => ({
      price,
      dir: price > prev.price ? 'up' : price < prev.price ? 'down' : prev.dir,
      tick: price !== prev.price ? prev.tick + 1 : prev.tick,
    }))
  })

  return (
    <section className="glass-card relative flex h-[440px] flex-col p-4">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <h2 className="panel-title">{t('chart.market')}</h2>
          <p className="font-mono text-lg font-bold text-slate-100">
            {symbol} <span className="text-sm font-medium text-slate-500">· {interval}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-widest text-slate-500">
            {t('chart.lastPrice')}
          </p>
          <p
            key={last.tick}
            className={`font-mono text-2xl font-bold ${
              last.dir === 'up'
                ? 'animate-flash-up'
                : last.dir === 'down'
                  ? 'animate-flash-down'
                  : 'text-slate-200'
            }`}
          >
            {last.price ? fmtNum(last.price, last.price >= 1000 ? 1 : 3) : '—'}
            {last.dir !== 'flat' && (
              <span className={`ml-1 text-sm ${last.dir === 'up' ? 'text-neon-green' : 'text-neon-red'}`}>
                {last.dir === 'up' ? '▲' : '▼'}
              </span>
            )}
          </p>
        </div>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-ink/60">
          <span className="text-sm text-slate-400">{t('chart.loading')}</span>
        </div>
      )}
      {error && (
        <div className="absolute inset-x-4 bottom-4 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {error}
        </div>
      )}
    </section>
  )
}
