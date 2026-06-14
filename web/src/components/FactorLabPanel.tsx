import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import {
  fetchFactorForecast,
  fetchMinedFactors,
  fetchMineStatus,
  runFactorStrategy,
  startMine,
  fmtNum,
  fmtPct,
  toUnixSec,
  type BacktestMetrics,
  type FactorForecast,
  type FactorStrategyResult,
  type MineConfig,
  type MinedFactor,
  type MineReport,
  type MineReportFactor,
  type MineStatus,
} from '../api'
import { useI18n } from '../i18n'

// ---------- small helpers ----------

function fmtDate(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function fmtDateTime(ms: number, locale = 'zh-CN'): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString(locale, { hour12: false })
}

function fmtElapsed(ms: number, zh: boolean): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const sec = s % 60
  return m > 0 ? (zh ? `${m} 分 ${sec} 秒` : `${m}m ${sec}s`) : (zh ? `${sec} 秒` : `${sec}s`)
}

/** IC values are small (±0.1); show 3 decimals with sign. */
function fmtIc(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(3)}`
}

/** 区块标题：与 panel-title 风格一致。 */
function BlockHeader({
  index,
  title,
  sub,
  children,
}: {
  index: string
  title: string
  sub: string
  children?: React.ReactNode
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs font-extrabold text-neon-purple drop-shadow-[0_0_8px_rgba(167,139,250,0.5)]">
        {index}
      </span>
      <h2 className="panel-title">
        {title} <span className="text-slate-500">· {sub}</span>
      </h2>
      {children}
    </div>
  )
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <p className="mb-2 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
      {msg}
    </p>
  )
}

// ---------- evolution curve (canvas, same style as EvolvePanel fitness curve) ----------

function EvolutionCurve({ values }: { values: number[] }) {
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
    grad.addColorStop(0, 'rgba(34,211,238,0.30)')
    grad.addColorStop(1, 'rgba(34,211,238,0)')
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
    ctx.shadowColor = '#22d3ee'
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

// ---------- ① mining console ----------

const HORIZON_OPTIONS = [5, 10, 21]

interface AdvField {
  key: 'days' | keyof MineConfig
  labelZh: string
  labelEn: string
  step: string
}

const ADV_FIELDS: AdvField[] = [
  { key: 'days', labelZh: '数据天数 days', labelEn: 'Data days', step: '1' },
  { key: 'max_depth', labelZh: '表达式深度 max_depth', labelEn: 'Expression depth', step: '1' },
  { key: 'folds', labelZh: '交叉验证折数 folds', labelEn: 'CV folds', step: '1' },
  { key: 'holdout_frac', labelZh: '留出比例 holdout_frac', labelEn: 'Holdout fraction', step: '0.05' },
  { key: 'stability_lambda', labelZh: '稳定性惩罚 λ_stability', labelEn: 'Stability penalty', step: '0.1' },
  { key: 'complexity_lambda', labelZh: '复杂度惩罚 λ_complexity', labelEn: 'Complexity penalty', step: '0.01' },
  { key: 'redundancy_lambda', labelZh: '冗余惩罚 λ_redundancy', labelEn: 'Redundancy penalty', step: '0.1' },
  { key: 'top_k', labelZh: '入库上限 top_k', labelEn: 'Library cap', step: '1' },
  { key: 'holdout_ic_floor', labelZh: '留出IC门槛 ic_floor', labelEn: 'Holdout IC floor', step: '0.005' },
]

const CONFIG_KEYS: (keyof MineConfig)[] = [
  'max_depth',
  'folds',
  'holdout_frac',
  'stability_lambda',
  'complexity_lambda',
  'redundancy_lambda',
  'top_k',
  'holdout_ic_floor',
]

function parseNum(s: string): number | undefined {
  const t = s.trim()
  if (!t) return undefined
  const v = Number(t)
  return Number.isFinite(v) ? v : undefined
}

/** 单个挖掘出的因子卡：表达式 + IC 体检指标 + 留出验收徽章。 */
function MinedFactorCard({ f }: { f: MineReportFactor }) {
  const { lang } = useI18n()
  const zh = lang === 'zh'
  return (
    <div
      className={`rounded-xl border bg-black/20 p-3 transition hover:bg-white/5 ${
        f.passed_holdout ? 'border-neon-green/35 hover:border-neon-green/60' : 'border-white/10 hover:border-white/20'
      }`}
    >
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all font-mono text-xs font-bold leading-relaxed text-neon-cyan">
          {f.expression}
        </code>
        {f.passed_holdout ? (
          <span className="badge shrink-0 border border-neon-green/40 bg-neon-green/10 text-neon-green">
            {zh ? '✓ 通过留出' : '✓ holdout pass'}
          </span>
        ) : (
          <span className="badge shrink-0 border border-neon-red/40 bg-neon-red/10 text-neon-red">
            {zh ? '✗ 未通过' : '✗ failed'}
          </span>
        )}
      </div>

      {/* 核心指标 chips */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
        <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-slate-300">
          {zh ? '搜索IC' : 'search IC'} <b className={f.mean_ic >= 0 ? 'text-neon-green' : 'text-neon-red'}>{fmtIc(f.mean_ic)}</b>
        </span>
        <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-slate-300">
          ICIR <b className={f.icir >= 0 ? 'text-neon-green' : 'text-neon-red'}>{fmtNum(f.icir)}</b>
        </span>
        <span
          className={`rounded-md border px-2 py-0.5 ${
            f.holdout_ic >= 0
              ? 'border-neon-green/40 bg-neon-green/10 text-neon-green'
              : 'border-neon-red/40 bg-neon-red/10 text-neon-red'
          }`}
        >
          {zh ? '留出IC' : 'holdout IC'} <b>{fmtIc(f.holdout_ic)}</b>
        </span>
        <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-slate-400">
          {zh ? '复杂度' : 'complexity'} {f.complexity}
        </span>
        <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-slate-400">
          fitness {fmtNum(f.fitness, 3)}
        </span>
      </div>

      {/* 各折 IC chips */}
      {f.fold_ics.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {f.fold_ics.map((ic, i) => (
            <span
              key={i}
              title={zh ? `第 ${i + 1} 折 IC` : `fold ${i + 1} IC`}
              className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${
                ic >= 0
                  ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                  : 'border-rose-400/30 bg-rose-400/10 text-rose-300'
              }`}
            >
              F{i + 1} {fmtIc(ic)}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function MineReportView({ report }: { report: MineReport }) {
  const { lang } = useI18n()
  const zh = lang === 'zh'
  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-slate-500">
        <span className="badge border border-neon-green/40 bg-neon-green/10 text-neon-green">{zh ? '本轮挖掘完成' : 'Mining run complete'}</span>
        <span>{zh ? '共评估' : 'Evaluated'} {report.total_evaluated} {zh ? '个候选因子' : 'candidate factors'}</span>
        <span>
          {zh ? '搜索期' : 'search'} {fmtDate(report.search_dates[0])} ~ {fmtDate(report.search_dates[1])}
        </span>
        <span>
          {zh ? '留出期' : 'holdout'} {fmtDate(report.holdout_dates[0])} ~ {fmtDate(report.holdout_dates[1])}
        </span>
      </div>

      {/* 进化曲线 */}
      <div>
        <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
          {zh ? 'evolution curve · 每代最优 fitness' : 'evolution curve · best fitness per generation'}
        </p>
        <EvolutionCurve values={report.generations_best} />
      </div>

      {/* 本轮发现的因子 */}
      <div>
        <p className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-500">
          {zh ? '本轮发现的因子' : 'Discovered factors'} · {report.factors.length}
        </p>
        {report.factors.length === 0 ? (
          <p className="text-xs text-slate-500">{zh ? '本轮未发现合格因子，可调大 population/generations 再试。' : 'No accepted factor found. Try larger population or generations.'}</p>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
            {report.factors.map((f, i) => (
              <MinedFactorCard key={`${f.expression}-${i}`} f={f} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MiningConsole({ onMineDone }: { onMineDone: () => void }) {
  const { lang } = useI18n()
  const zh = lang === 'zh'
  const [horizon, setHorizon] = useState(10)
  const [seed, setSeed] = useState('42')
  const [population, setPopulation] = useState('200')
  const [generations, setGenerations] = useState('30')
  const [advOpen, setAdvOpen] = useState(false)
  const [adv, setAdv] = useState<Record<string, string>>(() =>
    Object.fromEntries(ADV_FIELDS.map((f) => [f.key, ''])),
  )
  const [status, setStatus] = useState<MineStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const prevStatusRef = useRef<MineStatus['status'] | null>(null)

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await fetchMineStatus())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // 挂载时同步一次（可能已有任务在跑或上一轮报告还在）。
  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  // running 时每 3s 轮询状态。
  useEffect(() => {
    if (status?.status !== 'running') return
    const id = window.setInterval(() => void refreshStatus(), 3000)
    return () => window.clearInterval(id)
  }, [status?.status, refreshStatus])

  // running 时每秒刷新已运行时长。
  useEffect(() => {
    if (status?.status !== 'running') return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [status?.status])

  // running → done 时通知因子库刷新。
  useEffect(() => {
    const cur = status?.status ?? null
    if (prevStatusRef.current === 'running' && cur === 'done') onMineDone()
    prevStatusRef.current = cur
  }, [status?.status, onMineDone])

  const running = status?.status === 'running'

  const start = useCallback(async () => {
    if (running) return
    setError(null)
    const config: MineConfig = { horizon }
    const seedV = parseNum(seed)
    if (seedV !== undefined) config.seed = seedV
    const popV = parseNum(population)
    if (popV !== undefined) config.population = popV
    const genV = parseNum(generations)
    if (genV !== undefined) config.generations = genV
    for (const k of CONFIG_KEYS) {
      const v = parseNum(adv[k] ?? '')
      if (v !== undefined) config[k] = v
    }
    const days = parseNum(adv.days ?? '')
    try {
      await startMine({ ...(days !== undefined ? { days } : {}), config })
      setNow(Date.now())
      setStatus({ status: 'running', started_ms: Date.now() })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg.includes('400') ? (zh ? '已有一个挖掘任务在运行，同时只能跑一个。' : 'A mining job is already running; only one can run at a time.') : msg)
      void refreshStatus()
    }
  }, [running, horizon, seed, population, generations, adv, refreshStatus])

  const elapsed = running && status?.started_ms ? now - status.started_ms : 0

  return (
    <section className="glass-card flex flex-col p-4">
      <BlockHeader index="①" title="Mining Console" sub={zh ? '挖掘控制台' : 'mining controls'}>
        {status && (
          <span
            className={`badge ml-auto font-mono ${
              status.status === 'running'
                ? 'border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan'
                : status.status === 'done'
                  ? 'border border-neon-green/40 bg-neon-green/10 text-neon-green'
                  : status.status === 'failed'
                    ? 'border border-neon-red/40 bg-neon-red/10 text-neon-red'
                    : 'border border-white/15 bg-white/5 text-slate-400'
            }`}
          >
            {status.status}
          </span>
        )}
      </BlockHeader>

      {error && <ErrorBox msg={error} />}

      {/* 参数表单 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">{zh ? '预测窗口 horizon' : 'Forecast horizon'}</span>
          <select
            className="select-dark"
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
            disabled={running}
          >
            {HORIZON_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {zh ? `${h} 天` : `${h}d`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">{zh ? '随机种子 seed' : 'Random seed'}</span>
          <input
            className="input-dark"
            type="number"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            disabled={running}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">{zh ? '种群规模 population' : 'Population'}</span>
          <input
            className="input-dark"
            type="number"
            value={population}
            onChange={(e) => setPopulation(e.target.value)}
            disabled={running}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">{zh ? '进化代数 generations' : 'Generations'}</span>
          <input
            className="input-dark"
            type="number"
            value={generations}
            onChange={(e) => setGenerations(e.target.value)}
            disabled={running}
          />
        </label>
      </div>

      {/* 高级参数（折叠） */}
      <button
        className="mt-2 self-start font-mono text-[11px] text-slate-500 transition hover:text-neon-cyan"
        onClick={() => setAdvOpen((v) => !v)}
      >
        {advOpen ? (zh ? '▴ 收起高级参数' : '▴ Collapse advanced') : (zh ? '▾ 高级参数（留空 = 后端默认）' : '▾ Advanced parameters, blank = backend default')}
      </button>
      {advOpen && (
        <div className="mt-2 grid grid-cols-2 gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-3 sm:grid-cols-3 lg:grid-cols-5">
          {ADV_FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="text-[10px] tracking-wider text-slate-500">{zh ? f.labelZh : f.labelEn}</span>
              <input
                className="input-dark py-1 text-xs"
                type="number"
                step={f.step}
                placeholder={zh ? '后端默认' : 'backend default'}
                value={adv[f.key] ?? ''}
                onChange={(e) => setAdv((prev) => ({ ...prev, [f.key]: e.target.value }))}
                disabled={running}
              />
            </label>
          ))}
        </div>
      )}

      {/* 开始按钮 / 运行状态 */}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button className="btn-neon" onClick={() => void start()} disabled={running}>
          {running ? (zh ? '挖掘中...' : 'Mining...') : `⛏ ${zh ? '开始挖掘' : 'Start Mining'}`}
        </button>
        {running && (
          <div className="flex items-center gap-2 rounded-xl border border-neon-cyan/30 bg-neon-cyan/5 px-3 py-1.5">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-neon-cyan border-t-transparent" />
            <span className="font-mono text-xs text-neon-cyan">
              {zh ? '遗传规划进化中 · 已运行' : 'Genetic programming running · elapsed'} {fmtElapsed(elapsed, zh)}
            </span>
          </div>
        )}
        {status?.status === 'idle' && (
          <span className="text-xs text-slate-500">{zh ? '尚未运行过挖掘，设置参数后点「开始挖掘」。' : 'No mining run yet. Set parameters and start mining.'}</span>
        )}
      </div>

      {status?.status === 'failed' && status.error && (
        <p className="mt-3 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {zh ? '挖掘失败' : 'Mining failed'}: {status.error}
        </p>
      )}

      {status?.status === 'done' && status.report && <MineReportView report={status.report} />}
    </section>
  )
}

// ---------- ② factor library ----------

function FactorLibrary({ refreshKey }: { refreshKey: number }) {
  const { lang } = useI18n()
  const zh = lang === 'zh'
  const [factors, setFactors] = useState<MinedFactor[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchMinedFactors()
      .then((fs) => {
        if (cancelled) return
        setFactors([...fs].sort((a, b) => b.holdout_ic - a.holdout_ic))
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  return (
    <section className="glass-card flex flex-col p-4">
      <BlockHeader index="②" title="Factor Library" sub={zh ? '因子库' : 'factor library'}>
        <span className="badge border border-white/15 bg-white/5 font-mono text-slate-400">
          {factors?.length ?? 0} {zh ? '因子' : 'factors'}
        </span>
        <span className="ml-auto font-mono text-[10px] text-slate-500">{zh ? '仅收录通过留出验收的因子' : 'Only factors that pass holdout are stored'}</span>
      </BlockHeader>

      {error && <ErrorBox msg={error} />}

      {factors !== null && factors.length === 0 && !error && (
        <div className="flex h-24 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          {zh ? '因子库为空——先在上方挖掘控制台跑一轮挖掘' : 'Factor library is empty. Run mining above first.'}
        </div>
      )}

      {factors !== null && factors.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <th className="py-2 pr-3 font-medium">{zh ? '表达式' : 'Expression'}</th>
                <th className="py-2 pr-3 font-medium">horizon</th>
                <th className="py-2 pr-3 text-right font-medium">{zh ? '搜索IC' : 'Search IC'}</th>
                <th className="py-2 pr-3 text-right font-medium">ICIR</th>
                <th className="py-2 pr-3 text-right font-medium">{zh ? '留出IC' : 'Holdout IC'}</th>
                <th className="py-2 pr-3 text-right font-medium">{zh ? '复杂度' : 'Complexity'}</th>
                <th className="py-2 text-right font-medium">{zh ? '入库时间' : 'Mined'}</th>
              </tr>
            </thead>
            <tbody>
              {factors.map((f, i) => (
                <tr key={`${f.expression}-${i}`} className="border-b border-white/5 transition hover:bg-white/5">
                  <td className="max-w-[380px] py-2 pr-3">
                    <span className="block truncate font-mono text-neon-cyan" title={f.expression}>
                      {f.expression}
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-300">{f.horizon}d</td>
                  <td
                    className={`py-2 pr-3 text-right font-mono ${
                      f.mean_ic >= 0 ? 'text-slate-200' : 'text-neon-red'
                    }`}
                  >
                    {fmtIc(f.mean_ic)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-slate-200">{fmtNum(f.icir)}</td>
                  <td className="py-2 pr-3 text-right font-mono font-bold text-neon-green">
                    {fmtIc(f.holdout_ic)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-slate-400">{f.complexity}</td>
                  <td className="py-2 text-right font-mono text-slate-500">{fmtDate(f.mined_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ---------- ③ composite strategy validation ----------

function PeriodMetric({ label, value, tone }: { label: string; value: string; tone: 'pos' | 'neg' | 'neutral' }) {
  const cls = tone === 'pos' ? 'text-neon-green' : tone === 'neg' ? 'text-neon-red' : 'text-slate-200'
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`font-mono text-base font-bold ${cls}`}>{value}</p>
    </div>
  )
}

function PeriodCard({
  title,
  sub,
  m,
  highlight,
}: {
  title: string
  sub: string
  m: BacktestMetrics
  highlight?: boolean
}) {
  const { lang } = useI18n()
  const zh = lang === 'zh'
  return (
    <div
      className={`rounded-xl border p-3 ${
        highlight
          ? 'border-neon-green/60 bg-neon-green/5 shadow-[0_0_18px_rgba(52,211,153,0.18)]'
          : 'border-white/10 bg-white/[0.03]'
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={`text-sm font-extrabold ${highlight ? 'text-neon-green' : 'text-slate-200'}`}>
          {title}
        </span>
        <span className="font-mono text-[10px] text-slate-500">{sub}</span>
        {highlight && (
          <span className="badge border border-neon-green/50 bg-neon-green/10 text-[10px] text-neon-green">
            {zh ? '从未参与挖掘' : 'never used for mining'}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <PeriodMetric label="Sharpe" value={fmtNum(m.sharpe)} tone={m.sharpe >= 0 ? 'pos' : 'neg'} />
        <PeriodMetric
          label={zh ? '年化收益' : 'Annual Return'}
          value={fmtPct(m.annual_return)}
          tone={m.annual_return >= 0 ? 'pos' : 'neg'}
        />
        <PeriodMetric label={zh ? '最大回撤' : 'Max Drawdown'} value={fmtPct(m.max_drawdown)} tone="neg" />
        <PeriodMetric
          label={zh ? '命中率' : 'Hit Rate'}
          value={fmtPct(m.hit_rate, 1)}
          tone={m.hit_rate >= 0.5 ? 'pos' : 'neg'}
        />
      </div>
    </div>
  )
}

function CompositeEquityChart({ result }: { result: FactorStrategyResult }) {
  const chartDivRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null)

  useEffect(() => {
    if (!chartDivRef.current) return
    if (!chartRef.current) {
      const chart = createChart(chartDivRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: '#94a3b8',
          fontSize: 10,
        },
        grid: {
          vertLines: { color: 'rgba(148,163,184,0.06)' },
          horzLines: { color: 'rgba(148,163,184,0.06)' },
        },
        rightPriceScale: { borderColor: 'rgba(148,163,184,0.15)' },
        timeScale: { borderColor: 'rgba(148,163,184,0.15)', timeVisible: true },
        autoSize: true,
      })
      seriesRef.current = chart.addAreaSeries({
        lineColor: '#22d3ee',
        topColor: 'rgba(34,211,238,0.25)',
        bottomColor: 'rgba(34,211,238,0.0)',
        lineWidth: 2,
        priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      })
      chartRef.current = chart
    }
    const series = seriesRef.current
    if (!series) return
    series.setData(
      result.equity.map((p) => ({ time: toUnixSec(p.time) as UTCTimestamp, value: p.equity })),
    )
    // 留出期起点标记：净值曲线上从这里开始是「从未参与挖掘」的数据。
    if (result.holdout_start_ms) {
      series.setMarkers([
        {
          time: toUnixSec(result.holdout_start_ms) as UTCTimestamp,
          position: 'aboveBar',
          color: '#34d399',
          shape: 'arrowDown',
          text: '留出期开始',
        },
      ])
    }
    chartRef.current.timeScale().fitContent()
  }, [result])

  useEffect(
    () => () => {
      chartRef.current?.remove()
      chartRef.current = null
      seriesRef.current = null
    },
    [],
  )

  return <div ref={chartDivRef} className="mt-3 h-56 w-full" />
}

function CompositeSection() {
  const { lang } = useI18n()
  const zh = lang === 'zh'
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<FactorStrategyResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    try {
      setResult(await runFactorStrategy({}))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }, [])

  return (
    <section className="glass-card flex flex-col p-4">
      <BlockHeader index="③" title="Composite Strategy" sub={zh ? '组合策略验证' : 'composite validation'}>
        <button className="btn-neon ml-auto px-4 py-1.5 text-xs" onClick={() => void run()} disabled={running}>
          {running ? (zh ? '回测中...' : 'Backtesting...') : `▶ ${zh ? '跑组合回测' : 'Run Composite Backtest'}`}
        </button>
      </BlockHeader>

      {error && <ErrorBox msg={error} />}

      {!result && !error && (
        <p className="text-xs text-slate-500">
          {zh
            ? '用整个因子库等权合成截面多空组合，对比搜索期 / 留出期 / 全期表现，检验是否过拟合。'
            : 'Build an equal-weight cross-sectional long/short portfolio from the full factor library and compare search, holdout, and full-sample performance.'}
        </p>
      )}

      {result && (
        <>
          {/* 因子与组合概况 */}
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[10px] text-slate-500">
            <span>
              {zh ? '使用因子' : 'factors'} <b className="text-slate-300">{result.factors_used.length}</b>
            </span>
            <span>
              {zh ? '平均换手' : 'avg turnover'} <b className="text-slate-300">{fmtPct(result.avg_turnover, 1)}</b>
            </span>
            <span>
              {zh ? '单边持仓' : 'names per side'} <b className="text-slate-300">{result.names_per_side}</b>
            </span>
            <span>
              {zh ? '留出期自' : 'holdout starts'} <b className="text-neon-green">{fmtDate(result.holdout_start_ms)}</b>
            </span>
          </div>

          {/* 三段指标对比 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <PeriodCard title={zh ? '搜索期' : 'In-Search'} sub="In-Search" m={result.metrics_search} />
            <PeriodCard title={zh ? '留出期' : 'Holdout'} sub="Holdout" m={result.metrics_holdout} highlight />
            <PeriodCard title={zh ? '全期' : 'Full Sample'} sub="Full Sample" m={result.metrics_full} />
          </div>

          {/* 净值曲线 */}
          <CompositeEquityChart result={result} />

          {result.note && (
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{result.note}</p>
          )}
        </>
      )}
    </section>
  )
}

// ---------- ④ forecast ----------

function ScoreRow({
  rank,
  symbol,
  score,
  maxAbs,
  tone,
}: {
  rank: number
  symbol: string
  score: number
  maxAbs: number
  tone: 'green' | 'red'
}) {
  const frac = maxAbs > 0 ? Math.min(Math.abs(score) / maxAbs, 1) : 0
  const barStyle =
    tone === 'green'
      ? {
          width: `${Math.max(frac * 100, 2)}%`,
          background: 'linear-gradient(to right, rgba(52,211,153,0.35), #34d399)',
          boxShadow: '0 0 8px rgba(52,211,153,0.4)',
        }
      : {
          width: `${Math.max(frac * 100, 2)}%`,
          background: 'linear-gradient(to right, rgba(251,113,133,0.35), #fb7185)',
          boxShadow: '0 0 8px rgba(251,113,133,0.35)',
        }
  return (
    <div className="flex items-center gap-2">
      <span className="w-5 text-right font-mono text-[10px] text-slate-600">{rank}</span>
      <span className="w-14 font-mono text-xs font-bold text-slate-100">{symbol}</span>
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/5">
        <div className="h-full rounded-full" style={barStyle} />
      </div>
      <span
        className={`w-16 text-right font-mono text-[11px] font-bold ${
          tone === 'green' ? 'text-neon-green' : 'text-neon-red'
        }`}
      >
        {fmtIc(score)}
      </span>
    </div>
  )
}

function ForecastSection() {
  const { lang } = useI18n()
  const zh = lang === 'zh'
  const [forecast, setForecast] = useState<FactorForecast | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setForecast(await fetchFactorForecast())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // 自动加载一次。
  useEffect(() => {
    void load()
  }, [load])

  const top = forecast ? [...forecast.rankings].sort((a, b) => b.score - a.score).slice(0, 10) : []
  const bottom = forecast
    ? [...forecast.rankings].sort((a, b) => a.score - b.score).slice(0, 10)
    : []
  const maxAbs = forecast
    ? Math.max(...forecast.rankings.map((r) => Math.abs(r.score)), 0)
    : 0

  return (
    <section className="glass-card flex flex-col p-4">
      <BlockHeader index="④" title="Forecast" sub={zh ? '预测' : 'forecast'}>
        {forecast && (
          <>
            <span className="badge border border-white/10 bg-white/5 font-mono text-slate-500">
              as of {fmtDateTime(forecast.as_of, zh ? 'zh-CN' : 'en-US')}
            </span>
            <span className="badge border border-neon-purple/40 bg-neon-purple/10 font-mono text-neon-purple">
              {zh ? `${forecast.horizon_days} 天展望` : `${forecast.horizon_days}d horizon`}
            </span>
          </>
        )}
        <button
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300 transition hover:border-neon-cyan/50 hover:text-neon-cyan disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (zh ? '刷新中...' : 'Refreshing...') : `↻ ${zh ? '刷新预测' : 'Refresh Forecast'}`}
        </button>
      </BlockHeader>

      {error && <ErrorBox msg={error} />}

      {!forecast && !error && <p className="text-xs text-slate-500">loading forecast…</p>}

      {forecast && forecast.rankings.length === 0 && (
        <div className="flex h-24 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          {zh ? '暂无预测——因子库为空时无法打分，请先挖掘因子' : 'No forecast yet. The factor library is empty, so scores cannot be computed.'}
        </div>
      )}

      {forecast && forecast.rankings.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* 看强 Top 10 */}
          <div className="rounded-xl border border-neon-green/20 bg-white/[0.02] p-3">
            <p className="mb-2 text-sm font-extrabold text-neon-green drop-shadow-[0_0_8px_rgba(52,211,153,0.5)]">
              {zh ? '看强 Top 10' : 'Bullish Top 10'} <span className="font-mono text-[10px] font-medium text-slate-500">{zh ? '综合因子得分最高' : 'highest composite factor scores'}</span>
            </p>
            <div className="flex flex-col gap-1.5">
              {top.map((r, i) => (
                <ScoreRow key={r.symbol} rank={i + 1} symbol={r.symbol} score={r.score} maxAbs={maxAbs} tone="green" />
              ))}
            </div>
          </div>

          {/* 看弱 Bottom 10 */}
          <div className="rounded-xl border border-neon-red/20 bg-white/[0.02] p-3">
            <p className="mb-2 text-sm font-extrabold text-neon-red drop-shadow-[0_0_8px_rgba(251,113,133,0.5)]">
              {zh ? '看弱 Bottom 10' : 'Bearish Bottom 10'} <span className="font-mono text-[10px] font-medium text-slate-500">{zh ? '综合因子得分最低' : 'lowest composite factor scores'}</span>
            </p>
            <div className="flex flex-col gap-1.5">
              {bottom.map((r, i) => (
                <ScoreRow key={r.symbol} rank={i + 1} symbol={r.symbol} score={r.score} maxAbs={maxAbs} tone="red" />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 诚实声明：置信度解释（醒目琥珀色） */}
      {forecast && (
        <div className="mt-3 rounded-xl border border-amber-400/50 bg-amber-400/10 px-4 py-3">
          <p className="text-xs font-bold text-amber-300">
            {zh ? '置信度声明' : 'Confidence statement'} ·{' '}
            <span className="font-mono font-medium">
              {zh ? '平均留出IC' : 'avg holdout IC'} {fmtIc(forecast.confidence.avg_holdout_ic)} · {zh ? '基于' : 'based on'} {forecast.confidence.n_factors} {zh ? '个因子' : 'factors'}
            </span>
          </p>
          <p className="mt-1 text-xs leading-relaxed text-amber-200/90">
            {forecast.confidence.interpretation}
          </p>
        </div>
      )}
    </section>
  )
}

// ---------- panel ----------

export default function FactorLabPanel() {
  // 挖掘完成后因子库自动刷新。
  const [libraryVersion, setLibraryVersion] = useState(0)
  const bumpLibrary = useCallback(() => setLibraryVersion((v) => v + 1), [])

  return (
    <div className="flex flex-col gap-4">
      <MiningConsole onMineDone={bumpLibrary} />
      <FactorLibrary refreshKey={libraryVersion} />
      <CompositeSection />
      <ForecastSection />
    </div>
  )
}
