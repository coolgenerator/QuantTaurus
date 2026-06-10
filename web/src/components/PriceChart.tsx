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
import { useWsMessages } from '../ws'

interface Props {
  symbol: string
  interval: string
}

const UP = '#34d399'
const DOWN = '#fb7185'

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
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const lastBarTimeRef = useRef<number>(0)

  const [last, setLast] = useState<{ price: number; dir: 'up' | 'down' | 'flat'; tick: number }>({
    price: 0,
    dir: 'flat',
    tick: 0,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  // Load history when symbol/interval changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    lastBarTimeRef.current = 0
    fetchKlines(symbol, interval, 365)
      .then((klines) => {
        if (cancelled || !candleRef.current || !volumeRef.current) return
        candleRef.current.setData(klines.map(klineToCandle))
        volumeRef.current.setData(klines.map(klineToVolume))
        chartRef.current?.timeScale().fitContent()
        const lastK = klines[klines.length - 1]
        if (lastK) {
          lastBarTimeRef.current = toUnixSec(lastK.open_time)
          setLast({ price: lastK.close, dir: 'flat', tick: 0 })
        }
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
          <h2 className="panel-title">Market</h2>
          <p className="font-mono text-lg font-bold text-slate-100">
            {symbol} <span className="text-sm font-medium text-slate-500">· {interval}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-widest text-slate-500">last price</p>
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
          <span className="text-sm text-slate-400">loading candles…</span>
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
