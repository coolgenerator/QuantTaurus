import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchOptionChain,
  fetchOptionExpirations,
  fetchOptionPlans,
  fetchOptionsPaper,
  fmtNum,
  type OptionChain,
  type OptionPlan,
  type OptionPlansResponse,
  type OptionRow,
  type OptionsPaperStatus,
} from '../api'

const OPTION_SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MU', 'AMD'] as const

const SERVICE_HINT =
  '期权服务未运行：python3 bridge/options_service.py（需 OpenD 已登录）'

const CYAN = '#22d3ee'
const PURPLE = '#a78bfa'

// ---------- small helpers ----------

const isNum = (v: number | null | undefined): v is number =>
  v !== null && v !== undefined && Number.isFinite(v)

function fmtInt(v: number | null | undefined): string {
  if (!isNum(v)) return '—'
  return Math.round(v).toLocaleString('en-US')
}

/** One strike row of the T-table: call + put legs. */
interface StrikeRow {
  strike: number
  call?: OptionRow
  put?: OptionRow
}

function buildStrikeRows(rows: OptionRow[]): StrikeRow[] {
  const map = new Map<number, StrikeRow>()
  for (const r of rows) {
    let entry = map.get(r.strike)
    if (!entry) {
      entry = { strike: r.strike }
      map.set(r.strike, entry)
    }
    if (r.type === 'call') entry.call = r
    else entry.put = r
  }
  return [...map.values()].sort((a, b) => a.strike - b.strike)
}

// ---------- summary cards ----------

function StatCard({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string
  value: string
  sub?: string
  tone?: 'pos' | 'neg' | 'neutral' | 'cyan'
}) {
  const color =
    tone === 'pos'
      ? 'text-neon-green'
      : tone === 'neg'
        ? 'text-neon-red'
        : tone === 'cyan'
          ? 'text-neon-cyan'
          : 'text-slate-200'
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2.5 transition hover:border-neon-cyan/30">
      <p className={`font-mono text-xl font-bold leading-tight ${color}`}>{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      {sub && <p className="font-mono text-[10px] text-slate-500">{sub}</p>}
    </div>
  )
}

// ---------- IV smile (canvas) ----------

function IVSmileChart({ chain }: { chain: OptionChain }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const draw = useCallback(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    const W = wrap.clientWidth
    const H = 230
    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    const calls = chain.rows
      .filter((r) => r.type === 'call' && isNum(r.iv) && r.iv! > 0)
      .sort((a, b) => a.strike - b.strike)
    const puts = chain.rows
      .filter((r) => r.type === 'put' && isNum(r.iv) && r.iv! > 0)
      .sort((a, b) => a.strike - b.strike)
    const all = [...calls, ...puts]
    if (all.length < 2) {
      ctx.fillStyle = 'rgba(148,163,184,0.6)'
      ctx.font = '12px ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.fillText('IV 数据不足，无法绘制微笑曲线', W / 2, H / 2)
      return
    }

    const pad = { l: 44, r: 12, t: 12, b: 22 }
    const xs = all.map((r) => r.strike)
    const ys = all.map((r) => r.iv!)
    let xMin = Math.min(...xs, chain.spot)
    let xMax = Math.max(...xs, chain.spot)
    let yMin = Math.min(...ys)
    let yMax = Math.max(...ys)
    const xPad = (xMax - xMin) * 0.03 || 1
    const yPad = (yMax - yMin) * 0.1 || 1
    xMin -= xPad
    xMax += xPad
    yMin -= yPad
    yMax += yPad

    const X = (v: number) => pad.l + ((v - xMin) / (xMax - xMin)) * (W - pad.l - pad.r)
    const Y = (v: number) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b)

    // grid + y labels
    ctx.font = '10px ui-monospace, monospace'
    for (let i = 0; i <= 4; i++) {
      const v = yMin + ((yMax - yMin) * i) / 4
      const y = Y(v)
      ctx.strokeStyle = 'rgba(148,163,184,0.08)'
      ctx.beginPath()
      ctx.moveTo(pad.l, y)
      ctx.lineTo(W - pad.r, y)
      ctx.stroke()
      ctx.fillStyle = 'rgba(148,163,184,0.65)'
      ctx.textAlign = 'right'
      ctx.fillText(`${v.toFixed(1)}%`, pad.l - 6, y + 3)
    }
    // x labels
    for (let i = 0; i <= 5; i++) {
      const v = xMin + ((xMax - xMin) * i) / 5
      ctx.fillStyle = 'rgba(148,163,184,0.65)'
      ctx.textAlign = 'center'
      ctx.fillText(v.toFixed(0), X(v), H - 6)
    }

    // spot vertical dashed line
    const sx = X(chain.spot)
    ctx.save()
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = 'rgba(226,232,240,0.5)'
    ctx.beginPath()
    ctx.moveTo(sx, pad.t)
    ctx.lineTo(sx, H - pad.b)
    ctx.stroke()
    ctx.restore()
    ctx.fillStyle = 'rgba(226,232,240,0.7)'
    ctx.textAlign = 'center'
    ctx.fillText(`spot ${chain.spot.toFixed(2)}`, sx, pad.t - 2 + 10)

    const drawSeries = (rows: OptionRow[], color: string) => {
      if (rows.length === 0) return
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.shadowColor = color
      ctx.shadowBlur = 6
      ctx.beginPath()
      rows.forEach((r, i) => {
        const x = X(r.strike)
        const y = Y(r.iv!)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
      ctx.shadowBlur = 0
      ctx.fillStyle = color
      for (const r of rows) {
        ctx.beginPath()
        ctx.arc(X(r.strike), Y(r.iv!), 1.8, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    drawSeries(calls, CYAN)
    drawSeries(puts, PURPLE)
  }, [chain])

  useEffect(() => {
    draw()
    const wrap = wrapRef.current
    if (!wrap) return
    const obs = new ResizeObserver(() => draw())
    obs.observe(wrap)
    return () => obs.disconnect()
  }, [draw])

  return (
    <div className="glass-card p-4">
      <div className="mb-2 flex items-center gap-3">
        <h3 className="panel-title">IV Smile · 波动率微笑</h3>
        <span className="ml-auto flex items-center gap-3 font-mono text-[10px] text-slate-500">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-3 rounded-full" style={{ background: CYAN }} /> Call
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-3 rounded-full" style={{ background: PURPLE }} /> Put
          </span>
        </span>
      </div>
      <div ref={wrapRef} className="w-full">
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}

// ---------- OI distribution (diverging bars) ----------

function OIDistribution({ chain }: { chain: OptionChain }) {
  const strikeRows = useMemo(() => buildStrikeRows(chain.rows), [chain])
  const maxPain = chain.analysis?.max_pain ?? null

  const withOI = strikeRows.filter(
    (r) => (r.call?.open_interest ?? 0) > 0 || (r.put?.open_interest ?? 0) > 0,
  )
  const maxOI = Math.max(
    1,
    ...withOI.map((r) => Math.max(r.call?.open_interest ?? 0, r.put?.open_interest ?? 0)),
  )

  return (
    <div className="glass-card flex flex-col p-4">
      <div className="mb-2 flex items-center gap-3">
        <h3 className="panel-title">Open Interest · 持仓分布</h3>
        <span className="ml-auto flex items-center gap-3 font-mono text-[10px] text-slate-500">
          <span style={{ color: PURPLE }}>← Put OI</span>
          <span style={{ color: CYAN }}>Call OI →</span>
        </span>
      </div>
      {withOI.length === 0 ? (
        <p className="py-8 text-center text-xs text-slate-500">暂无持仓量数据</p>
      ) : (
        <div className="max-h-[260px] overflow-y-auto pr-1">
          {withOI.map((r) => {
            const isMaxPain = maxPain !== null && Math.abs(r.strike - maxPain) < 1e-9
            const callW = ((r.call?.open_interest ?? 0) / maxOI) * 100
            const putW = ((r.put?.open_interest ?? 0) / maxOI) * 100
            return (
              <div
                key={r.strike}
                className={`flex items-center gap-1 rounded px-1 py-[1px] font-mono text-[10px] ${
                  isMaxPain
                    ? 'border border-amber-400/50 bg-amber-400/10'
                    : 'border border-transparent'
                }`}
                title={`行权价 ${r.strike} · Call OI ${fmtInt(r.call?.open_interest)} · Put OI ${fmtInt(
                  r.put?.open_interest,
                )}${isMaxPain ? ' · 最大痛点' : ''}`}
              >
                {/* put side (left) */}
                <div className="flex h-3 flex-1 justify-end">
                  <div
                    className="h-full rounded-l-sm"
                    style={{
                      width: `${putW}%`,
                      background: 'linear-gradient(to left, #a78bfa, rgba(167,139,250,0.35))',
                      boxShadow: putW > 0 ? '0 0 6px rgba(167,139,250,0.35)' : undefined,
                    }}
                  />
                </div>
                <span
                  className={`w-16 shrink-0 text-center ${
                    isMaxPain ? 'font-bold text-amber-300' : 'text-slate-400'
                  }`}
                >
                  {r.strike}
                  {isMaxPain ? ' ⚡' : ''}
                </span>
                {/* call side (right) */}
                <div className="flex h-3 flex-1">
                  <div
                    className="h-full rounded-r-sm"
                    style={{
                      width: `${callW}%`,
                      background: 'linear-gradient(to right, #22d3ee, rgba(34,211,238,0.35))',
                      boxShadow: callW > 0 ? '0 0 6px rgba(34,211,238,0.35)' : undefined,
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
      {maxPain !== null && (
        <p className="mt-2 font-mono text-[10px] text-amber-300/80">
          ⚡ 最大痛点 {fmtNum(maxPain)} 行已高亮
        </p>
      )}
    </div>
  )
}

// ---------- T-quote table ----------

function TQuoteTable({ chain }: { chain: OptionChain }) {
  const strikeRows = useMemo(() => buildStrikeRows(chain.rows), [chain])
  const atmStrike = useMemo(() => {
    if (strikeRows.length === 0) return null
    return strikeRows.reduce((best, r) =>
      Math.abs(r.strike - chain.spot) < Math.abs(best.strike - chain.spot) ? r : best,
    ).strike
  }, [strikeRows, chain.spot])

  const atmRowRef = useRef<HTMLTableRowElement>(null)
  // 滚动到 ATM 附近，便于直接看平值区。
  useEffect(() => {
    atmRowRef.current?.scrollIntoView({ block: 'center' })
  }, [chain])

  const sideCls = (itm: boolean) => (itm ? 'bg-white/[0.05]' : 'bg-transparent')
  const cell = 'px-2 py-1 text-right font-mono text-[11px] whitespace-nowrap'

  return (
    <div className="glass-card flex flex-col p-4">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h3 className="panel-title">T-Quote · T 型报价</h3>
        <span className="ml-auto font-mono text-[10px] text-slate-500">
          实值 (ITM) 区背景更亮 · ATM 行高亮 · {strikeRows.length} 个行权价
        </span>
      </div>
      <div className="max-h-[420px] overflow-auto rounded-xl border border-white/5">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-[#101626]">
            <tr className="text-[10px] uppercase tracking-wider text-slate-500">
              <th colSpan={5} className="border-b border-white/10 px-2 py-1.5 text-neon-cyan">
                Call
              </th>
              <th className="border-b border-white/10 px-2 py-1.5 text-slate-300">Strike</th>
              <th colSpan={5} className="border-b border-white/10 px-2 py-1.5 text-neon-purple">
                Put
              </th>
            </tr>
            <tr className="font-mono text-[10px] text-slate-500">
              {['Last', 'IV', 'Δ', 'Vol', 'OI'].map((h) => (
                <th key={`c-${h}`} className="border-b border-white/10 px-2 py-1 text-right">
                  {h}
                </th>
              ))}
              <th className="border-b border-white/10 px-2 py-1 text-center">—</th>
              {['Last', 'IV', 'Δ', 'Vol', 'OI'].map((h) => (
                <th key={`p-${h}`} className="border-b border-white/10 px-2 py-1 text-right">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {strikeRows.map((r) => {
              const isAtm = r.strike === atmStrike
              const callItm = r.strike < chain.spot
              const putItm = r.strike > chain.spot
              return (
                <tr
                  key={r.strike}
                  ref={isAtm ? atmRowRef : undefined}
                  className={`border-b border-white/[0.03] transition hover:bg-white/[0.06] ${
                    isAtm ? 'bg-gradient-to-r from-cyan-500/15 via-white/10 to-violet-500/15' : ''
                  }`}
                >
                  <td className={`${cell} text-slate-200 ${sideCls(callItm)}`}>
                    {fmtNum(r.call?.last)}
                  </td>
                  <td className={`${cell} text-neon-cyan/90 ${sideCls(callItm)}`}>
                    {isNum(r.call?.iv) ? `${r.call!.iv!.toFixed(1)}%` : '—'}
                  </td>
                  <td className={`${cell} text-slate-400 ${sideCls(callItm)}`}>
                    {isNum(r.call?.delta) ? r.call!.delta!.toFixed(2) : '—'}
                  </td>
                  <td className={`${cell} text-slate-400 ${sideCls(callItm)}`}>
                    {fmtInt(r.call?.volume)}
                  </td>
                  <td className={`${cell} text-slate-400 ${sideCls(callItm)}`}>
                    {fmtInt(r.call?.open_interest)}
                  </td>
                  <td
                    className={`px-2 py-1 text-center font-mono text-[11px] font-bold ${
                      isAtm ? 'text-amber-300' : 'text-slate-200'
                    }`}
                  >
                    {r.strike}
                    {isAtm ? ' ◎' : ''}
                  </td>
                  <td className={`${cell} text-slate-200 ${sideCls(putItm)}`}>
                    {fmtNum(r.put?.last)}
                  </td>
                  <td className={`${cell} text-neon-purple/90 ${sideCls(putItm)}`}>
                    {isNum(r.put?.iv) ? `${r.put!.iv!.toFixed(1)}%` : '—'}
                  </td>
                  <td className={`${cell} text-slate-400 ${sideCls(putItm)}`}>
                    {isNum(r.put?.delta) ? r.put!.delta!.toFixed(2) : '—'}
                  </td>
                  <td className={`${cell} text-slate-400 ${sideCls(putItm)}`}>
                    {fmtInt(r.put?.volume)}
                  </td>
                  <td className={`${cell} text-slate-400 ${sideCls(putItm)}`}>
                    {fmtInt(r.put?.open_interest)}
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

// ---------- option trade plans ----------

const PLAN_FOOTNOTE =
  '计划由股票冠军信号推导：方向→Call/Put，持有期×1.5→到期日，|Δ|≈0.35→行权价。期权可归零，权利金即最大亏损。'

const ACTION_BADGE: Record<OptionPlan['action'], string> = {
  'BUY CALL':
    'border border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan drop-shadow-[0_0_8px_rgba(34,211,238,0.5)]',
  'BUY PUT':
    'border border-neon-red/50 bg-gradient-to-r from-rose-500/15 to-violet-500/15 text-neon-red drop-shadow-[0_0_8px_rgba(251,113,133,0.5)]',
}

/** Confidence badge: >=70 green / >=50 amber / <50 red. */
function confBadgeCls(confidence: number): string {
  if (confidence >= 70) return 'border border-emerald-400/50 bg-emerald-400/10 text-neon-green'
  if (confidence >= 50) return 'border border-amber-400/50 bg-amber-400/10 text-amber-300'
  return 'border border-neon-red/50 bg-neon-red/10 text-neon-red'
}

/** ①②③… enumeration marks for exit rules. */
function circledNum(i: number): string {
  return i < 20 ? String.fromCharCode(0x2460 + i) : `${i + 1}.`
}

function fmtUsd(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return '—'
  return `$${v.toLocaleString('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })}`
}

function fmtDateTime(ms: number): string {
  if (!isNum(ms) || ms <= 0) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function OptionPlanCard({ plan }: { plan: OptionPlan }) {
  const [showRationale, setShowRationale] = useState(false)
  const contractCost = plan.premium * 100
  const isPut = plan.action === 'BUY PUT'

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3 transition hover:border-neon-cyan/40 hover:bg-white/5">
      {/* 头部：标的 + 动作徽章 + 置信度 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xl font-extrabold tracking-wide text-slate-100">
          {plan.underlying}
        </span>
        <span className={`badge px-3 py-1 text-sm ${ACTION_BADGE[plan.action]}`}>
          {plan.action}
        </span>
        <span
          className={`badge ml-auto font-mono ${confBadgeCls(plan.stock_confidence)}`}
          title={`股票信号置信度 ${Math.round(plan.stock_confidence)} · 目标价 ${fmtNum(plan.stock_target)}`}
        >
          信心 {Math.round(plan.stock_confidence)}
        </span>
      </div>

      {/* 合约行 */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className={`font-mono text-2xl font-bold ${isPut ? 'text-neon-purple' : 'text-neon-cyan'}`}
        >
          {fmtNum(plan.strike, plan.strike % 1 === 0 ? 0 : 2)}
        </span>
        <span className="font-mono text-xs text-slate-400">{plan.expiry}</span>
        <span className="badge border border-white/15 bg-white/5 font-mono text-slate-300">
          {plan.dte} DTE
        </span>
        <span className="font-mono text-xs text-slate-300">
          权利金 <span className="font-bold text-slate-100">{fmtUsd(plan.premium)}</span>/股
          <span className="text-slate-500">（一张 {fmtUsd(contractCost, 0)}）</span>
        </span>
      </div>
      <div className="mt-1.5 font-mono text-xs">
        {plan.qty_suggested > 0 ? (
          <span className="text-slate-300">
            建议张数 <span className="font-bold text-neon-green">{plan.qty_suggested} 张</span>
          </span>
        ) : (
          <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-amber-300">
            单张超预算，仅作参考
          </span>
        )}
      </div>

      {/* 希腊字母小行 */}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-slate-400">
        <span>
          Δ <span className="text-slate-200">{isNum(plan.delta) ? plan.delta.toFixed(2) : '—'}</span>
        </span>
        <span>
          IV{' '}
          <span className="text-neon-cyan/90">{isNum(plan.iv) ? `${plan.iv.toFixed(1)}%` : '—'}</span>
        </span>
        <span>
          θ <span className="text-slate-200">{isNum(plan.theta) ? plan.theta.toFixed(3) : '—'}</span>
        </span>
        <span>
          OI <span className="text-slate-200">{fmtInt(plan.open_interest)}</span>
        </span>
        <span className="ml-auto text-slate-500">spot {fmtNum(plan.spot)}</span>
      </div>

      {/* 买入 / 卖出规则 */}
      <div className="mt-3 rounded-lg border border-white/5 bg-white/[0.03] p-2.5">
        <p className="text-[11px] leading-relaxed text-slate-300">
          <span className="mr-1.5 font-bold text-neon-green">买入</span>
          {plan.entry_rule}
        </p>
        <div className="mt-1.5 border-t border-white/5 pt-1.5">
          <p className="mb-0.5 text-[11px] font-bold text-neon-red">卖出</p>
          <ul className="space-y-0.5">
            {plan.exit_rules.map((rule, i) => (
              <li key={i} className="text-[11px] leading-relaxed text-slate-300">
                <span className="mr-1 text-neon-purple">{circledNum(i)}</span>
                {rule}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* 决策依据（折叠） */}
      {plan.rationale && (
        <div className="mt-2">
          <button
            onClick={() => setShowRationale((v) => !v)}
            className="font-mono text-[11px] text-slate-400 transition hover:text-neon-cyan"
          >
            决策依据 {showRationale ? '▴' : '▾'}
          </button>
          {showRationale && (
            <div className="mt-1 border-l-2 border-neon-cyan/70 bg-neon-cyan/5 py-1.5 pl-2.5 pr-2">
              <p className="font-mono text-[11px] leading-relaxed text-slate-300">
                {plan.rationale}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function OptionPlansSection() {
  const [data, setData] = useState<OptionPlansResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await fetchOptionPlans())
      setError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg.includes('failed:') ? msg : SERVICE_HINT)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(id)
  }, [load])

  const plans = data?.plans ?? []

  return (
    <section className="glass-card flex flex-col p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="panel-title">
          Option Plans <span className="text-slate-500">· 期权交易计划</span>
        </h2>
        <span className="badge border border-white/15 bg-white/5 font-mono text-slate-400">
          {plans.length} 计划
        </span>
        {data && (
          <span className="ml-auto font-mono text-[10px] text-slate-500">
            更新于 {fmtDateTime(data.as_of)}
          </span>
        )}
      </div>

      {loading && !data && (
        <div className="flex h-32 items-center justify-center gap-2 rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          <span className="h-2 w-2 animate-pulse rounded-full bg-neon-cyan" />
          首次生成需逐个拉取期权链，约 1~2 分钟（之后缓存 120s）…
        </div>
      )}

      {error && !loading && (
        <p className="rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {error}
        </p>
      )}

      {!loading && !error && plans.length === 0 && (
        <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          暂无期权计划——股票冠军信号就绪后将自动推导
        </div>
      )}

      {plans.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {plans.map((p) => (
            <OptionPlanCard key={p.code || `${p.underlying}-${p.action}`} plan={p} />
          ))}
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{PLAN_FOOTNOTE}</p>
    </section>
  )
}

// ---------- options paper trading ----------

const OPT_PAPER_INITIAL = 10_000

/**
 * Shorten an option code tail like "260702C749000" → "749C 26-07-02".
 * Falls back to the raw code when the pattern doesn't match.
 */
function fmtContractCode(code: string): string {
  const m = /(\d{2})(\d{2})(\d{2})([CP])(\d+)$/.exec(code)
  if (!m) return code
  const strike = Number(m[5]) / 1000
  const strikeStr = strike % 1 === 0 ? String(strike) : strike.toFixed(2)
  return `${strikeStr}${m[4]} ${m[1]}-${m[2]}-${m[3]}`
}

function OptionsPaperSection() {
  const [status, setStatus] = useState<OptionsPaperStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setStatus(await fetchOptionsPaper())
      setError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg.includes('failed:') ? msg : SERVICE_HINT)
    }
  }, [])

  // 挂载拉一次 + 60s 自动刷新。
  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(id)
  }, [load])

  const positions = useMemo(
    () => Object.entries(status?.positions ?? {}),
    [status],
  )
  const trades = useMemo(() => [...(status?.trades ?? [])].reverse().slice(0, 30), [status])

  const equity = status?.equity ?? OPT_PAPER_INITIAL
  const pnlPct = (equity / OPT_PAPER_INITIAL - 1) * 100
  const equityTone = pnlPct >= 0 ? 'text-neon-green' : 'text-neon-red'
  const idle = positions.length === 0 && trades.length === 0

  return (
    <section className="glass-card flex flex-col p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="panel-title">
          Options Paper <span className="text-slate-500">· 期权模拟盘</span>
        </h2>
        <span className="badge border border-white/15 bg-white/5 font-mono text-slate-400">
          初始 $10,000
        </span>
        {status && (
          <span className="ml-auto font-mono text-[10px] text-slate-500">
            更新于 {fmtDateTime(status.updated_ms)} · 60s 自动刷新
          </span>
        )}
      </div>

      {error && (
        <p className="mb-2 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {error}
        </p>
      )}

      {/* 顶部大数字 */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2.5">
          <p className={`font-mono text-xl font-bold leading-tight ${equityTone}`}>
            {fmtUsd(equity)}{' '}
            <span className="text-xs font-semibold">
              {pnlPct >= 0 ? '+' : ''}
              {pnlPct.toFixed(2)}%
            </span>
          </p>
          <p className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-500">账户净值</p>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2.5">
          <p className="font-mono text-xl font-bold leading-tight text-slate-200">
            {fmtUsd(status?.cash)}
          </p>
          <p className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-500">现金</p>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2.5">
          <p className="font-mono text-xl font-bold leading-tight text-neon-cyan">
            {positions.length}
          </p>
          <p className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-500">持仓数</p>
        </div>
      </div>

      {idle && !error && (
        <div className="mt-3 flex h-24 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          等待信号开仓（每5分钟自动检查）
        </div>
      )}

      {/* 持仓表 */}
      {positions.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-white/5">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-white/[0.03] text-[10px] uppercase tracking-wider text-slate-500">
                {['标的', '合约', '张数', '成本 → 现价', '到期'].map((h) => (
                  <th key={h} className="border-b border-white/10 px-2.5 py-1.5 text-left">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map(([underlying, pos]) => {
                const pnl =
                  pos.entry_premium > 0 ? (pos.mark / pos.entry_premium - 1) * 100 : null
                const pnlCls =
                  pnl === null ? 'text-slate-500' : pnl >= 0 ? 'text-neon-green' : 'text-neon-red'
                const cp = pos.action === 'BUY CALL' ? 'C' : 'P'
                return (
                  <tr
                    key={underlying}
                    className="border-b border-white/[0.03] font-mono text-xs transition hover:bg-white/[0.06]"
                    title={pos.rationale}
                  >
                    <td className="px-2.5 py-1.5 font-bold text-slate-100">{underlying}</td>
                    <td className="px-2.5 py-1.5 text-slate-300">
                      {fmtNum(pos.strike, pos.strike % 1 === 0 ? 0 : 2)}
                      <span className={cp === 'C' ? 'text-neon-cyan' : 'text-neon-purple'}>
                        {cp}
                      </span>{' '}
                      <span className="text-slate-500">{pos.expiry}</span>
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-300">{pos.qty}</td>
                    <td className="px-2.5 py-1.5">
                      <span className="text-slate-400">{fmtUsd(pos.entry_premium)}</span>
                      <span className="text-slate-600"> → </span>
                      <span className="text-slate-200">{fmtUsd(pos.mark)}</span>{' '}
                      <span className={`font-bold ${pnlCls}`}>
                        {pnl === null ? '—' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%`}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-400">{pos.expiry}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 交易记录 */}
      {trades.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-500">
            交易记录（最近 {trades.length} 条）
          </p>
          <div className="max-h-[260px] space-y-1 overflow-y-auto pr-1">
            {trades.map((t, i) => (
              <div
                key={`${t.time}-${t.code}-${i}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-1.5 font-mono text-[11px]"
              >
                <span className="text-slate-500">{fmtDateTime(t.time)}</span>
                <span
                  className={`badge px-1.5 py-0 font-bold ${
                    t.side === 'BUY'
                      ? 'border border-emerald-400/40 bg-emerald-400/10 text-neon-green'
                      : 'border border-neon-red/40 bg-neon-red/10 text-neon-red'
                  }`}
                >
                  {t.side}
                </span>
                <span className="text-slate-200" title={t.code}>
                  {fmtContractCode(t.code)}
                </span>
                <span className="text-slate-400">×{t.qty}</span>
                <span className="text-slate-300">@{fmtUsd(t.premium)}</span>
                {t.side === 'SELL' && t.pnl !== null && (
                  <span
                    className={`font-bold ${t.pnl >= 0 ? 'text-neon-green' : 'text-neon-red'}`}
                  >
                    {t.pnl >= 0 ? '+' : ''}
                    {fmtUsd(t.pnl)}
                  </span>
                )}
                <span className="ml-auto max-w-[50%] truncate text-slate-500" title={t.reason}>
                  {t.reason}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

// ---------- main panel ----------

export default function OptionsPanel() {
  const [symbol, setSymbol] = useState<string>('SPY')
  /** 已拉取到期日的标的 + 列表；与当前 symbol 不一致即视为加载中。 */
  const [expState, setExpState] = useState<{ symbol: string; expirations: string[] } | null>(null)
  const [expiry, setExpiry] = useState<string>('')
  const [chain, setChain] = useState<OptionChain | null>(null)
  const [loadingChain, setLoadingChain] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadingExp = expState?.symbol !== symbol
  const expirations = loadingExp ? [] : (expState?.expirations ?? [])

  // 选标的后自动拉到期日，默认选最近的一个。
  useEffect(() => {
    let cancelled = false
    fetchOptionExpirations(symbol)
      .then((res) => {
        if (cancelled) return
        const exps = [...res.expirations].sort()
        setExpState({ symbol, expirations: exps })
        setExpiry(exps[0] ?? '')
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        setExpState({ symbol, expirations: [] })
        setExpiry('')
        setError(SERVICE_HINT)
      })
    return () => {
      cancelled = true
    }
  }, [symbol])

  const loadChain = useCallback(async () => {
    if (!expiry) return
    setLoadingChain(true)
    setError(null)
    try {
      setChain(await fetchOptionChain(symbol, expiry))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 网络层失败（sidecar 没起）给友好提示，HTTP 错误保留原文。
      setError(msg.includes('failed:') ? msg : SERVICE_HINT)
      setChain(null)
    } finally {
      setLoadingChain(false)
    }
  }, [symbol, expiry])

  const a = chain?.analysis ?? null
  const atmIv =
    a && isNum(a.atm_iv_call) && isNum(a.atm_iv_put)
      ? (a.atm_iv_call + a.atm_iv_put) / 2
      : (a?.atm_iv_call ?? a?.atm_iv_put ?? null)
  const maxPainDist =
    a && isNum(a.max_pain) && chain ? (a.max_pain / chain.spot - 1) * 100 : null

  const pcrTone = (v: number | null | undefined): 'pos' | 'neg' | 'neutral' =>
    !isNum(v) ? 'neutral' : v > 1 ? 'neg' : 'pos'

  return (
    <div className="flex flex-col gap-4">
      {/* 期权交易计划 */}
      <OptionPlansSection />

      {/* 期权模拟盘 */}
      <OptionsPaperSection />

      {/* 控制行 */}
      <section className="glass-card flex flex-wrap items-end gap-3 p-4">
        <h2 className="panel-title mr-2 self-center">
          Options Chain <span className="text-slate-500">· 期权链分析</span>
        </h2>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">标的</span>
          <select
            className="select-dark font-mono"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
          >
            {OPTION_SYMBOLS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">到期日</span>
          <select
            className="select-dark min-w-[140px] font-mono"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            disabled={loadingExp || expirations.length === 0}
          >
            {loadingExp && <option value="">加载中…</option>}
            {!loadingExp && expirations.length === 0 && <option value="">—</option>}
            {expirations.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>

        <button className="btn-neon" onClick={() => void loadChain()} disabled={loadingChain || !expiry}>
          {loadingChain ? '加载中…' : '加载期权链'}
        </button>

        {loadingChain && (
          <span className="flex items-center gap-2 self-center text-xs text-slate-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-neon-cyan" />
            首次请求需向 OpenD 拉取全链，约 5~20 秒…
          </span>
        )}
      </section>

      {error && (
        <p className="rounded-lg border border-neon-red/40 bg-neon-red/10 px-4 py-3 text-sm text-neon-red">
          {error}
        </p>
      )}

      {!chain && !error && !loadingChain && (
        <div className="glass-card flex h-48 items-center justify-center text-sm text-slate-500">
          选择标的与到期日，点击「加载期权链」开始分析（后端缓存 120s，重复请求很快）。
        </div>
      )}

      {chain && (
        <>
          {/* 分析摘要卡片 */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            <StatCard
              label={`${chain.symbol} 现价`}
              value={fmtNum(chain.spot)}
              sub={chain.expiry}
              tone="cyan"
            />
            <StatCard
              label="P/C 比 · 成交量"
              value={fmtNum(a?.pcr_volume)}
              sub={isNum(a?.pcr_volume) ? (a!.pcr_volume! > 1 ? '偏空' : '偏多') : undefined}
              tone={pcrTone(a?.pcr_volume)}
            />
            <StatCard
              label="P/C 比 · 持仓量"
              value={fmtNum(a?.pcr_oi)}
              sub={isNum(a?.pcr_oi) ? (a!.pcr_oi! > 1 ? '偏空' : '偏多') : undefined}
              tone={pcrTone(a?.pcr_oi)}
            />
            <StatCard
              label="最大痛点"
              value={fmtNum(a?.max_pain)}
              sub={
                maxPainDist !== null
                  ? `距现价 ${maxPainDist >= 0 ? '+' : ''}${maxPainDist.toFixed(1)}%`
                  : undefined
              }
              tone="neutral"
            />
            <StatCard
              label="ATM IV"
              value={isNum(atmIv) ? `${atmIv.toFixed(1)}%` : '—'}
              sub={
                a && (isNum(a.atm_iv_call) || isNum(a.atm_iv_put))
                  ? `C ${isNum(a.atm_iv_call) ? a.atm_iv_call!.toFixed(1) : '—'} / P ${
                      isNum(a.atm_iv_put) ? a.atm_iv_put!.toFixed(1) : '—'
                    }`
                  : undefined
              }
              tone="neutral"
            />
            <StatCard
              label="25Δ 偏度"
              value={isNum(a?.skew_25d) ? `${a!.skew_25d! >= 0 ? '+' : ''}${a!.skew_25d!.toFixed(1)}` : '—'}
              sub={
                isNum(a?.skew_25d)
                  ? a!.skew_25d! >= 0
                    ? '下行保护偏贵'
                    : '下行保护偏便宜'
                  : undefined
              }
              tone={isNum(a?.skew_25d) ? (a!.skew_25d! >= 0 ? 'neg' : 'pos') : 'neutral'}
            />
          </div>

          {/* IV 微笑 + OI 分布 */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <IVSmileChart chain={chain} />
            <OIDistribution chain={chain} />
          </div>

          {/* T 型报价表 */}
          <TQuoteTable chain={chain} />

          <p className="text-center text-[11px] text-slate-600">
            数据源 moomoo OpenD · 延迟/快照数据 · 仅供分析参考
          </p>
        </>
      )}
    </div>
  )
}
