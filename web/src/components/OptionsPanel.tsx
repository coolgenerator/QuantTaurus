import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchOptionChain,
  fetchOptionExpirations,
  fmtNum,
  type OptionChain,
  type OptionRow,
} from '../api'
import { isCrypto } from './TopBar'

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

// ---------- main panel ----------

export default function OptionsPanel({ symbol }: { symbol: string }) {
  /** 已拉取到期日的标的 + 列表。 */
  const [expState, setExpState] = useState<{ symbol: string; expirations: string[] } | null>(null)
  const [loadingExp, setLoadingExp] = useState(false)
  /** expirations 拉取失败的错误（可点「重试」）。 */
  const [expError, setExpError] = useState<string | null>(null)
  const [expiry, setExpiry] = useState<string>('')
  const [chain, setChain] = useState<OptionChain | null>(null)
  const [loadingChain, setLoadingChain] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cryptoSymbol = isCrypto(symbol)
  const expirations = expState?.symbol === symbol ? expState.expirations : []

  /** 丢弃过期的 expirations 响应（symbol 已切换或重试已发起）。 */
  const expSeqRef = useRef(0)

  /** 拉到期日并默认选最近的一个；返回列表供「加载期权链」串联使用。 */
  const loadExpirations = useCallback(async (sym: string): Promise<string[]> => {
    const seq = ++expSeqRef.current
    setLoadingExp(true)
    setExpError(null)
    try {
      const res = await fetchOptionExpirations(sym)
      if (expSeqRef.current !== seq) return []
      const exps = [...res.expirations].sort()
      setExpState({ symbol: sym, expirations: exps })
      setExpiry(exps[0] ?? '')
      return exps
    } catch {
      if (expSeqRef.current !== seq) return []
      setExpState({ symbol: sym, expirations: [] })
      setExpiry('')
      setExpError(SERVICE_HINT)
      return []
    } finally {
      if (expSeqRef.current === seq) setLoadingExp(false)
    }
  }, [])

  // 全局 symbol 变化：清掉旧标的的链/错误，自动重拉到期日（加密货币不发请求）。
  useEffect(() => {
    setChain(null)
    setError(null)
    setExpError(null)
    setExpiry('')
    if (isCrypto(symbol)) return
    void loadExpirations(symbol)
  }, [symbol, loadExpirations])

  const loadChain = useCallback(async (expiryArg?: string) => {
    // expirations 为空（如上次拉取失败）先重拉，再用最近到期日加载。
    let exp = expiryArg ?? expiry
    if (!exp) {
      const exps = await loadExpirations(symbol)
      exp = exps[0] ?? ''
      if (!exp) return
    }
    setLoadingChain(true)
    setError(null)
    try {
      setChain(await fetchOptionChain(symbol, exp))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 网络层失败（sidecar 没起）给友好提示，HTTP 错误保留原文。
      setError(msg.includes('failed:') ? msg : SERVICE_HINT)
      setChain(null)
    } finally {
      setLoadingChain(false)
    }
  }, [symbol, expiry, loadExpirations])

  const a = chain?.analysis ?? null
  const atmIv =
    a && isNum(a.atm_iv_call) && isNum(a.atm_iv_put)
      ? (a.atm_iv_call + a.atm_iv_put) / 2
      : (a?.atm_iv_call ?? a?.atm_iv_put ?? null)
  const maxPainDist =
    a && isNum(a.max_pain) && chain ? (a.max_pain / chain.spot - 1) * 100 : null

  const pcrTone = (v: number | null | undefined): 'pos' | 'neg' | 'neutral' =>
    !isNum(v) ? 'neutral' : v > 1 ? 'neg' : 'pos'

  // 加密货币无期权：占位卡，不发任何请求。
  if (cryptoSymbol) {
    return (
      <div className="glass-card flex h-56 flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="font-mono text-lg font-bold text-neon-cyan">{symbol}</p>
        <p className="text-sm text-slate-400">期权仅支持美股标的——请在顶栏选择/搜索美股</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 控制行 */}
      <section className="glass-card flex flex-wrap items-end gap-3 p-4">
        <h2 className="panel-title mr-2 self-center">
          Options Chain <span className="text-slate-500">· 期权链分析</span>
        </h2>

        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">标的（顶栏）</span>
          <span className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 font-mono text-sm font-bold text-neon-cyan">
            {symbol}
          </span>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">到期日</span>
          <select
            className="select-dark min-w-[140px] font-mono"
            value={expiry}
            onChange={(e) => {
              setExpiry(e.target.value)
              // 选中日期即自动加载该到期日的链，无需再点按钮
              if (e.target.value) void loadChain(e.target.value)
            }}
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

        <button
          className="btn-neon"
          onClick={() => void loadChain()}
          disabled={loadingChain || loadingExp}
        >
          {loadingChain ? '加载中…' : chain ? '刷新' : '加载期权链'}
        </button>

        {loadingChain && (
          <span className="flex items-center gap-2 self-center text-xs text-slate-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-neon-cyan" />
            拉取全链中，约 1~3 秒…
          </span>
        )}
      </section>

      {expError && (
        <div className="flex items-center gap-3 rounded-lg border border-neon-red/40 bg-neon-red/10 px-4 py-3 text-sm text-neon-red">
          <span className="flex-1">到期日加载失败：{expError}</span>
          <button
            className="shrink-0 rounded-lg border border-neon-red/50 px-3 py-1 text-xs font-semibold transition hover:bg-neon-red/20"
            onClick={() => void loadExpirations(symbol)}
            disabled={loadingExp}
          >
            {loadingExp ? '重试中…' : '重试'}
          </button>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-neon-red/40 bg-neon-red/10 px-4 py-3 text-sm text-neon-red">
          {error}
        </p>
      )}

      {!chain && !error && !expError && !loadingChain && (
        <div className="glass-card flex h-48 items-center justify-center text-sm text-slate-500">
          选择到期日，点击「加载期权链」开始分析（后端缓存 120s，重复请求很快）。
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
