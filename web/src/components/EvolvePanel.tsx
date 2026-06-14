import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchEvolveStatus,
  startEvolve,
  fmtNum,
  type EvolveReport,
  type EvolveStatus,
} from '../api'
import { useI18n } from '../i18n'
import { useWsMessages } from '../ws'

interface Props {
  symbol: string
  interval: string
}

/** Canvas line chart for the fitness curve. */
function FitnessCurve({ values }: { values: number[] }) {
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
    if (values.length < 2) return

    const min = Math.min(...values)
    const max = Math.max(...values)
    const span = max - min || 1
    const pad = 6
    const x = (i: number) => (i / (values.length - 1)) * (w - 2 * pad) + pad
    const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad)

    // Area fill.
    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, 'rgba(167,139,250,0.35)')
    grad.addColorStop(1, 'rgba(167,139,250,0)')
    ctx.beginPath()
    ctx.moveTo(x(0), h - pad)
    values.forEach((v, i) => ctx.lineTo(x(i), y(v)))
    ctx.lineTo(x(values.length - 1), h - pad)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()

    // Gradient line cyan → purple.
    const lineGrad = ctx.createLinearGradient(0, 0, w, 0)
    lineGrad.addColorStop(0, '#22d3ee')
    lineGrad.addColorStop(1, '#a78bfa')
    ctx.beginPath()
    values.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))))
    ctx.strokeStyle = lineGrad
    ctx.lineWidth = 2
    ctx.shadowColor = '#a78bfa'
    ctx.shadowBlur = 8
    ctx.stroke()

    // End dot.
    const lastV = values[values.length - 1]
    ctx.beginPath()
    ctx.arc(x(values.length - 1), y(lastV), 3, 0, Math.PI * 2)
    ctx.fillStyle = '#a78bfa'
    ctx.fill()
  }, [values])
  return <canvas ref={ref} className="h-32 w-full" />
}

function specKind(spec: unknown): string {
  if (spec && typeof spec === 'object' && 'kind' in spec) return String((spec as { kind: unknown }).kind)
  return '?'
}

function Report({ report }: { report: EvolveReport }) {
  const { t } = useI18n()
  const population = [...report.final_population].sort(
    (a, b) => (b.valid_metrics?.sharpe ?? -Infinity) - (a.valid_metrics?.sharpe ?? -Infinity),
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wider text-slate-500">
            {t('evolve.fitness', { evals: report.total_evaluations })}
          </p>
          {report.promoted ? (
            <span className="badge border border-neon-green/40 bg-neon-green/10 text-neon-green">
              ★ {t('evolve.promoted')}
            </span>
          ) : (
            <span className="badge border border-white/15 bg-white/5 text-slate-400">
              {t('evolve.notPromoted')}
            </span>
          )}
        </div>
        <FitnessCurve values={report.fitness_curve} />
      </div>

      <div>
        <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
          champion · valid sharpe {fmtNum(report.champion.valid_metrics?.sharpe)} · holdout sharpe{' '}
          {fmtNum(report.champion.holdout_metrics?.sharpe)}
        </p>
        {report.champion.fold_sharpes && report.champion.fold_sharpes.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {report.champion.fold_sharpes.map((s, i) => (
              <span
                key={i}
                className={`rounded-md border px-2 py-0.5 font-mono text-[10px] ${
                  s >= 0
                    ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                    : 'border-rose-400/30 bg-rose-400/10 text-rose-300'
                }`}
                title={`validation fold ${i + 1} sharpe`}
              >
                F{i + 1} {s.toFixed(2)}
              </span>
            ))}
          </div>
        )}
        <pre className="max-h-32 overflow-auto rounded-xl border border-neon-purple/20 bg-black/40 p-3 font-mono text-xs leading-relaxed text-neon-cyan">
          {JSON.stringify(report.champion.spec, null, 2)}
        </pre>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-white/5">
        <table className="w-full text-left font-mono text-xs">
          <thead className="sticky top-0 bg-panel text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">gen</th>
              <th className="px-3 py-2">kind</th>
              <th className="px-3 py-2 text-right">valid sharpe</th>
            </tr>
          </thead>
          <tbody>
            {population.map((p, i) => {
              const sharpe = p.valid_metrics?.sharpe
              return (
                <tr key={i} className="border-t border-white/5 transition hover:bg-white/5">
                  <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                  <td className="px-3 py-1.5 text-slate-300">{p.generation}</td>
                  <td className="px-3 py-1.5 text-neon-purple">{specKind(p.spec)}</td>
                  <td
                    className={`px-3 py-1.5 text-right font-bold ${
                      (sharpe ?? 0) >= 0 ? 'text-neon-green' : 'text-neon-red'
                    }`}
                  >
                    {fmtNum(sharpe)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function EvolvePanel({ symbol, interval }: Props) {
  const { t } = useI18n()
  const [status, setStatus] = useState<EvolveStatus>({ status: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const s = await fetchEvolveStatus()
      setStatus(s)
      if (s.status !== 'running') stopPolling()
      return s
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      stopPolling()
      return null
    }
  }, [stopPolling])

  const startPolling = useCallback(() => {
    if (pollRef.current) return
    pollRef.current = setInterval(() => {
      void refresh()
    }, 2000)
  }, [refresh])

  // Initial status fetch; resume polling if a run is already in flight.
  useEffect(() => {
    void refresh().then((s) => {
      if (s?.status === 'running') startPolling()
    })
    return stopPolling
  }, [refresh, startPolling, stopPolling])

  // The backend pings us over WS when evolution finishes.
  useWsMessages((msg) => {
    if (msg.channel === 'evolve_done') {
      stopPolling()
      void refresh()
    }
  })

  const start = async () => {
    setError(null)
    try {
      await startEvolve(symbol, interval, 365)
      setStatus((prev) => ({ ...prev, status: 'running' }))
      startPolling()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const running = status.status === 'running'

  return (
    <section className="glass-card flex max-h-[640px] flex-col p-4">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="panel-title">{t('evolve.title')}</h2>
        <span
          className={`badge ml-1 border ${
            running
              ? 'border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan'
              : status.status === 'done'
                ? 'border-neon-green/40 bg-neon-green/10 text-neon-green'
                : status.status === 'failed'
                  ? 'border-neon-red/40 bg-neon-red/10 text-neon-red'
                  : 'border-white/15 bg-white/5 text-slate-400'
          }`}
        >
          {status.status}
        </span>
        <button className="btn-neon ml-auto" onClick={start} disabled={running}>
          {running ? t('evolve.running') : t('evolve.start')}
        </button>
      </div>

      {error && (
        <p className="mb-2 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {error}
        </p>
      )}

      {running && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 py-10">
          <div className="relative h-16 w-16">
            <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-neon-cyan border-r-neon-purple" />
            <div
              className="absolute inset-2 animate-spin rounded-full border-2 border-transparent border-t-neon-purple border-l-neon-cyan"
              style={{ animationDirection: 'reverse', animationDuration: '1.4s' }}
            />
            <div className="absolute inset-[26px] rounded-full bg-gradient-to-r from-cyan-400 to-violet-400 opacity-80" />
          </div>
          <p className="animate-shimmer bg-gradient-to-r from-slate-500 via-slate-200 to-slate-500 bg-[length:200%_100%] bg-clip-text text-sm font-medium text-transparent">
            {t('evolve.progress')}
          </p>
        </div>
      )}

      {!running && status.report && <Report report={status.report} />}

      {!running && !status.report && !error && (
        <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          {t('evolve.empty')}
        </div>
      )}
    </section>
  )
}
