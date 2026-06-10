import { useEffect, useRef, useState } from 'react'
import { fetchFactors, fmtNum, type FactorSeries } from '../api'

interface Props {
  symbol: string
  interval: string
}

const FACTOR_DEFS: { key: keyof Omit<FactorSeries, 'times'>; label: string }[] = [
  { key: 'momentum', label: 'Momentum' },
  { key: 'rsi', label: 'RSI' },
  { key: 'realized_vol', label: 'Realized Vol' },
  { key: 'bollinger_z', label: 'Bollinger Z' },
  { key: 'macd_hist', label: 'MACD Hist' },
  { key: 'flow_imbalance', label: 'Flow Imbalance' },
  { key: 'volume_price_corr', label: 'Vol-Price Corr' },
]

const POS = '#34d399'
const NEG = '#fb7185'
const NEUTRAL = '#22d3ee'

/** Color for a factor's latest value. RSI is centered on 50, vol is always neutral. */
function factorColor(key: string, v: number | null): string {
  if (v === null) return NEUTRAL
  if (key === 'rsi') return v >= 50 ? POS : NEG
  if (key === 'realized_vol') return NEUTRAL
  return v >= 0 ? POS : NEG
}

function Sparkline({ values, color }: { values: (number | null)[]; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    const pts = values
      .map((v, i) => ({ v, i }))
      .filter((p): p is { v: number; i: number } => p.v !== null && Number.isFinite(p.v))
    if (pts.length < 2) return

    let min = Infinity
    let max = -Infinity
    for (const p of pts) {
      if (p.v < min) min = p.v
      if (p.v > max) max = p.v
    }
    const span = max - min || 1
    const pad = 2
    const x = (i: number) => (i / (values.length - 1)) * (w - 2 * pad) + pad
    const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad)

    // Soft area fill.
    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, color + '44')
    grad.addColorStop(1, color + '00')
    ctx.beginPath()
    ctx.moveTo(x(pts[0].i), h - pad)
    for (const p of pts) ctx.lineTo(x(p.i), y(p.v))
    ctx.lineTo(x(pts[pts.length - 1].i), h - pad)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()

    // Line with glow.
    ctx.beginPath()
    pts.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(x(p.i), y(p.v))
      else ctx.lineTo(x(p.i), y(p.v))
    })
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.shadowColor = color
    ctx.shadowBlur = 6
    ctx.stroke()
  }, [values, color])

  return <canvas ref={ref} className="h-10 w-full" />
}

export default function FactorPanel({ symbol, interval }: Props) {
  const [factors, setFactors] = useState<FactorSeries | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setFactors(null)
    setError(null)
    fetchFactors(symbol, interval, 365, 14)
      .then((f) => {
        if (!cancelled) setFactors(f)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [symbol, interval])

  return (
    <section className="glass-card flex h-[440px] flex-col p-4">
      <h2 className="panel-title mb-3">Alpha Factors</h2>
      {error && <p className="text-xs text-neon-red">{error}</p>}
      {!factors && !error && <p className="text-xs text-slate-500">loading factors…</p>}
      {factors && (
        <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-2 overflow-y-auto pr-1">
          {FACTOR_DEFS.map(({ key, label }) => {
            const series = factors[key]
            const tail = series.slice(-120)
            const latest = [...series].reverse().find((v) => v !== null) ?? null
            const color = factorColor(key, latest)
            return (
              <div
                key={key}
                className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-3 py-1.5 transition hover:border-white/15"
              >
                <div className="w-28 shrink-0">
                  <p className="truncate text-[11px] font-medium text-slate-400">{label}</p>
                  <p className="font-mono text-sm font-bold" style={{ color }}>
                    {fmtNum(latest, 4)}
                  </p>
                </div>
                <div className="min-w-0 flex-1">
                  <Sparkline values={tail} color={color} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
