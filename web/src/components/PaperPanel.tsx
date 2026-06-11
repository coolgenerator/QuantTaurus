import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import {
  fetchPaperStatus,
  fmtNum,
  fmtPct,
  toUnixSec,
  type EquityPoint,
  type PaperSession,
  type PaperTrade,
} from '../api'
import { useWsMessages } from '../ws'

const MAX_TRADES = 50

const EQUITY_COLOR = '#22d3ee'

interface TradeRow extends PaperTrade {
  id: number
}

interface LiveStats {
  equity: number
  position: number
  price: number
}

let nextId = 0

/** ms-timestamped curve → deduped, ascending, second-resolution line points. */
function curveToLinePoints(curve: EquityPoint[]) {
  const byTime = new Map<number, number>()
  for (const p of curve) byTime.set(toUnixSec(p.time), p.equity)
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time: time as UTCTimestamp, value }))
}

function positionLabel(p: number): { text: string; cls: string } {
  if (p > 1e-9) {
    return { text: `LONG ${p.toFixed(2)}`, cls: 'border-neon-green/40 bg-neon-green/10 text-neon-green' }
  }
  if (p < -1e-9) {
    return { text: `SHORT ${Math.abs(p).toFixed(2)}`, cls: 'border-neon-red/40 bg-neon-red/10 text-neon-red' }
  }
  return { text: 'FLAT', cls: 'border-white/15 bg-white/5 text-slate-400' }
}

function PositionBadge({ position }: { position: number }) {
  const { text, cls } = positionLabel(position)
  return <span className={`badge border font-mono ${cls}`}>{text}</span>
}

export default function PaperPanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null)
  const lastTimeRef = useRef<number>(0)
  const loadingRef = useRef(false)

  const [sessions, setSessions] = useState<Record<string, PaperSession>>({})
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [statsByKey, setStatsByKey] = useState<Record<string, LiveStats>>({})
  const [tradesByKey, setTradesByKey] = useState<Record<string, TradeRow[]>>({})
  const [error, setError] = useState<string | null>(null)

  // Refs mirroring state so the (long-lived) WS handler never reads stale
  // closure values.
  const selectedKeyRef = useRef<string | null>(null)
  selectedKeyRef.current = selectedKey
  const sessionKeysRef = useRef<string[]>([])

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const s = await fetchPaperStatus()
      const map = s.sessions ?? {}
      const keys = Object.keys(map).sort()
      sessionKeysRef.current = keys
      setSessions(map)
      setStatsByKey(
        Object.fromEntries(
          keys.map((k) => [
            k,
            { equity: map[k].equity, position: map[k].position, price: map[k].last_price },
          ]),
        ),
      )
      setTradesByKey(
        Object.fromEntries(
          keys.map((k) => [
            k,
            [...map[k].trades]
              .sort((a, b) => b.time - a.time)
              .slice(0, MAX_TRADES)
              .map((t) => ({ ...t, id: nextId++ })),
          ]),
        ),
      )
      // Keep the current tab if it still exists; otherwise pick the first.
      setSelectedKey((prev) => (prev && keys.includes(prev) ? prev : keys[0] ?? null))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const sortedKeys = useMemo(() => Object.keys(sessions).sort(), [sessions])
  // 选中会话的全量数据（完整曲线+交易）：列表是轻量摘要，全量单独拉
  const [detail, setDetail] = useState<PaperSession | null>(null)
  useEffect(() => {
    if (!selectedKey) {
      setDetail(null)
      return
    }
    let cancelled = false
    const loadDetail = async () => {
      try {
        const s = await fetchPaperStatus(selectedKey)
        if (!cancelled) setDetail(s.sessions?.[selectedKey] ?? null)
      } catch {
        /* 摘要仍可用，静默 */
      }
    }
    void loadDetail()
    const t = window.setInterval(loadDetail, 15_000)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [selectedKey])
  const session = detail && selectedKey && detail.symbol === sessions[selectedKey]?.symbol
    ? detail
    : selectedKey
      ? sessions[selectedKey] ?? null
      : null

  // (Re)create the equity chart whenever the selected session changes
  // (tab switch or data reload) — rebuilt from that session's curve.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !session) return
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
        secondsVisible: true,
      },
      autoSize: true,
    })
    const series = chart.addAreaSeries({
      lineColor: EQUITY_COLOR,
      topColor: 'rgba(34,211,238,0.30)',
      bottomColor: 'rgba(34,211,238,0)',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
    })
    const points = curveToLinePoints(session.curve)
    series.setData(points)
    lastTimeRef.current = points.length > 0 ? (points[points.length - 1].time as number) : 0
    chart.timeScale().fitContent()

    chartRef.current = chart
    seriesRef.current = series
    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      lastTimeRef.current = 0
    }
  }, [session])

  // Live updates, fanned out per session key. Only messages for the selected
  // tab feed the chart; other keys just refresh their tab's mini equity.
  useWsMessages((msg) => {
    if (msg.channel === 'paper') {
      setStatsByKey((prev) => ({
        ...prev,
        [msg.key]: { equity: msg.equity, position: msg.position, price: msg.price },
      }))
      if (msg.key === selectedKeyRef.current) {
        const t = toUnixSec(msg.time)
        // Never feed an older point to the series (the chart would throw).
        if (t >= lastTimeRef.current) {
          lastTimeRef.current = t
          seriesRef.current?.update({ time: t as UTCTimestamp, value: msg.equity })
        }
      }
      // A session we don't know about yet (fresh promotion) — resync.
      if (!sessionKeysRef.current.includes(msg.key)) void load()
    } else if (msg.channel === 'paper_trade') {
      const row: TradeRow = { ...msg.trade, id: nextId++ }
      setTradesByKey((prev) => ({
        ...prev,
        [msg.key]: [row, ...(prev[msg.key] ?? [])].slice(0, MAX_TRADES),
      }))
    } else if (msg.channel === 'evolve_done' && msg.promoted) {
      // A newly promoted champion (re)starts its paper session — resync.
      void load()
    }
  })

  const active = sortedKeys.length > 0
  const stats = selectedKey ? statsByKey[selectedKey] ?? null : null
  const detailTrades = useMemo<TradeRow[]>(
    () =>
      (detail?.trades ?? [])
        .slice()
        .sort((a, b) => b.time - a.time)
        .slice(0, MAX_TRADES)
        .map((t, i) => ({ ...t, id: i })),
    [detail],
  )
  const trades = detailTrades.length > 0 ? detailTrades : selectedKey ? tradesByKey[selectedKey] ?? [] : []
  const equity = stats?.equity ?? 1
  const pnl = equity - 1
  const equityCls = pnl >= 0 ? 'text-neon-green' : 'text-neon-red'

  return (
    <section className="glass-card flex flex-col p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="panel-title">Live Paper Trading</h2>
        {active && (
          <span className="badge border border-neon-green/40 bg-neon-green/10 text-neon-green">
            <span className="inline-block h-2 w-2 animate-pulse-dot rounded-full bg-neon-green" />
            LIVE · {sortedKeys.length}
          </span>
        )}
        {session && (
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className="badge border border-neon-purple/40 bg-neon-purple/10 font-mono text-neon-purple">
              {session.spec.kind}
            </span>
          </span>
        )}
      </div>

      {error && (
        <p className="mb-2 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {error}
        </p>
      )}

      {!active && (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          <span className="text-2xl">♟</span>
          <p>冠军席位空缺——进化晋升后自动开盘</p>
        </div>
      )}

      {active && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {sortedKeys.map((key) => {
            const s = sessions[key]
            const live = statsByKey[key]
            const eq = live?.equity ?? s.equity
            const tabPnl = eq - 1
            const isActive = key === selectedKey
            return (
              <button
                key={key}
                onClick={() => setSelectedKey(key)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 font-mono text-xs transition ${
                  isActive
                    ? 'border-neon-cyan/60 bg-neon-cyan/10 text-neon-cyan shadow-[0_0_12px_rgba(34,211,238,0.35)]'
                    : 'border-white/10 bg-white/5 text-slate-400 hover:border-white/25 hover:text-slate-200'
                }`}
              >
                <span>
                  {s.symbol}
                  {s.interval !== '1d' && (
                    <>
                      <span className={isActive ? 'text-neon-cyan/60' : 'text-slate-600'}> · </span>
                      {s.interval}
                    </>
                  )}
                </span>
                <span
                  className={`font-bold ${tabPnl >= 0 ? 'text-neon-green' : 'text-neon-red'}`}
                  title="live equity"
                >
                  {fmtNum(eq, 4)}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {active && session && stats && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-white/5 bg-black/20 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">equity</p>
              <p className={`font-mono text-2xl font-bold ${equityCls}`}>
                {fmtNum(stats.equity, 4)}
              </p>
              <p className={`font-mono text-xs ${equityCls}`}>
                {pnl >= 0 ? '+' : ''}
                {fmtPct(pnl)}
              </p>
            </div>
            <div className="rounded-xl border border-white/5 bg-black/20 p-3">
              <p className="mb-1 text-[10px] uppercase tracking-widest text-slate-500">position</p>
              <PositionBadge position={stats.position} />
            </div>
            <div className="rounded-xl border border-white/5 bg-black/20 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">mark price</p>
              <p className="font-mono text-2xl font-bold text-slate-200">
                {fmtNum(stats.price, stats.price >= 1000 ? 1 : 3)}
              </p>
            </div>
            <div
              className="rounded-xl border border-white/5 bg-black/20 p-3"
              title="等效股数 = 仓位比例 × $10k 槽位名义资金 ÷ 现价；与 moomoo 模拟账户实际下单股数同口径"
            >
              <p className="text-[10px] uppercase tracking-widest text-slate-500">
                等效持仓 · shares
              </p>
              {Number.isFinite(session.shares_equiv) ? (
                <>
                  <p
                    className={`font-mono text-2xl font-bold ${
                      session.shares_equiv > 1e-9
                        ? 'text-neon-green'
                        : session.shares_equiv < -1e-9
                          ? 'text-neon-red'
                          : 'text-slate-400'
                    }`}
                  >
                    {session.shares_equiv > 0 ? '+' : ''}
                    {session.shares_equiv.toFixed(1)} 股
                  </p>
                  <p className="font-mono text-xs text-slate-500">
                    ≈$
                    {Math.abs(session.notional_usd ?? 0).toLocaleString('en-US', {
                      maximumFractionDigits: 0,
                    })}{' '}
                    名义
                  </p>
                </>
              ) : (
                <p className="font-mono text-2xl font-bold text-slate-600">—</p>
              )}
            </div>
          </div>

          <div ref={containerRef} className="h-44 min-h-0" />

          <div className="mt-3">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
              rebalances · {trades.length}
            </p>
            <div className="max-h-36 overflow-y-auto pr-1">
              {trades.length === 0 && (
                <p className="py-6 text-center text-xs text-slate-600">
                  no rebalances yet — the champion is patient
                </p>
              )}
              <ul className="space-y-1 font-mono text-xs">
                {trades.map((t) => {
                  const increased = t.to_position > t.from_position
                  return (
                    <li
                      key={t.id}
                      className={`flex flex-wrap items-center gap-3 rounded-lg border-l-2 px-3 py-1 transition ${
                        increased
                          ? 'border-neon-green/70 bg-neon-green/[0.04]'
                          : 'border-neon-red/70 bg-neon-red/[0.04]'
                      }`}
                    >
                      <span className="w-32 text-slate-500">
                        {new Date(t.time).toLocaleString('en-GB')}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <PositionBadge position={t.from_position} />
                        <span className="text-slate-500">→</span>
                        <PositionBadge position={t.to_position} />
                      </span>
                      <span className="ml-auto text-right text-slate-300">
                        @ {fmtNum(t.price, t.price >= 1000 ? 1 : 3)}
                      </span>
                      <span className="w-24 text-right text-slate-500" title="transaction cost">
                        cost {fmtPct(t.cost, 3)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
