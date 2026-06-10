import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import {
  fetchChampions,
  runBacktest,
  toUnixSec,
  fmtNum,
  fmtPct,
  type BacktestResult,
  type ChampionRecord,
  type ChampionRegistryMap,
  type CostModel,
  type StrategySpec,
} from '../api'
import { isCrypto } from './TopBar'
import { useWsMessages } from '../ws'

// ---------- constants ----------

/** moomoo 美股成本口径（与 BacktestPanel 的预设保持一致）。 */
const MOOMOO_US_COST: CostModel = {
  fee_rate: 0.00002,
  slippage: 0.0003,
  min_fee_usd: 0,
  capital_usd: 10000,
}

const DAYS_OPTIONS: { value: number; label: string }[] = [
  { value: 365, label: '1 年' },
  { value: 730, label: '2 年' },
  { value: 3650, label: '10 年' },
]

const METHOD_NOTE =
  '命中率略高于50% × 盈亏比>1 是动量类策略的正常形态；DSR>0.95 才视为统计显著。回测为样本内参考，留出窗表现见血统。'

// ---------- small helpers ----------

/** Compact relative time, e.g. "3 小时前". */
function relTime(ms: number): string {
  if (!ms) return '—'
  const diff = Date.now() - ms
  if (diff < 0) return '刚刚'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  const mon = Math.floor(day / 30)
  if (mon < 12) return `${mon} 个月前`
  return `${Math.floor(mon / 12)} 年前`
}

function fmtDate(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Flat numeric/string params of a spec (excludes kind & nested members). */
function paramEntries(spec: StrategySpec): [string, string][] {
  return Object.entries(spec)
    .filter(([k]) => k !== 'kind' && k !== 'members')
    .map(([k, v]) => [
      k,
      typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')) : String(v),
    ])
}

// ---------- metric tiles ----------

type Tone = 'pos' | 'neg' | 'neutral'
const signTone = (v: number): Tone => (v >= 0 ? 'pos' : 'neg')
const toneCls: Record<Tone, string> = {
  pos: 'text-neon-green',
  neg: 'text-neon-red',
  neutral: 'text-slate-200',
}

function Metric({
  label,
  value,
  tone,
  sub,
  big,
}: {
  label: string
  value: string
  tone: Tone
  sub?: string
  big?: boolean
}) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 transition hover:border-neon-cyan/30">
      <p
        className={`font-mono font-bold leading-tight ${toneCls[tone]} ${big ? 'text-2xl' : 'text-lg'}`}
      >
        {value}
      </p>
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      {sub && <p className="mt-0.5 text-[10px] leading-snug text-slate-500">{sub}</p>}
    </div>
  )
}

/** 指标组标题：霓虹色 + 渐变细线。 */
function GroupTitle({ tone, title, sub }: { tone: 'cyan' | 'purple'; title: string; sub: string }) {
  const titleCls =
    tone === 'cyan'
      ? 'text-neon-cyan drop-shadow-[0_0_8px_rgba(34,211,238,0.5)]'
      : 'text-neon-purple drop-shadow-[0_0_8px_rgba(167,139,250,0.5)]'
  return (
    <p className={`mb-1.5 text-sm font-extrabold tracking-wide ${titleCls}`}>
      {title} <span className="font-mono text-[10px] font-medium text-slate-500">{sub}</span>
    </p>
  )
}

// ---------- lineage mini timeline ----------

function LineageTimeline({ record }: { record: ChampionRecord }) {
  if (record.lineage.length === 0) {
    return <p className="font-mono text-[10px] text-slate-600">暂无血统记录</p>
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {record.lineage.map((l, i) => (
        <span
          key={i}
          className={`h-2.5 w-2.5 cursor-default rounded-full transition hover:scale-125 ${
            l.holdout_sharpe >= 0
              ? 'bg-neon-green shadow-[0_0_6px_rgba(74,222,128,0.7)]'
              : 'bg-neon-red shadow-[0_0_6px_rgba(251,113,133,0.7)]'
          }`}
          title={`第 ${i + 1} 代 · ${fmtDate(l.promoted_ms)} · holdout sharpe ${l.holdout_sharpe.toFixed(2)} · ${l.spec.kind}`}
        />
      ))}
      <span className="ml-1 font-mono text-[10px] text-slate-500">
        最新 {record.lineage[record.lineage.length - 1].holdout_sharpe.toFixed(2)}
      </span>
    </div>
  )
}

// ---------- strategy profile card ----------

function StrategyCard({
  slotKey,
  record,
  active,
  running,
  onRun,
}: {
  slotKey: string
  record: ChampionRecord
  active: boolean
  running: boolean
  onRun: (days: number) => void
}) {
  const [days, setDays] = useState(3650)
  const [jsonOpen, setJsonOpen] = useState(false)
  const latest = record.lineage.length > 0 ? record.lineage[record.lineage.length - 1] : null
  const promotedMs = latest?.promoted_ms ?? record.updated_ms
  const spec = record.spec
  const params = spec ? paramEntries(spec) : []
  const isEnsemble = spec?.kind === 'ensemble'

  return (
    <div
      className={`rounded-xl border bg-black/20 p-3 transition hover:bg-white/5 ${
        active
          ? 'border-neon-cyan/60 shadow-[0_0_14px_rgba(34,211,238,0.25)]'
          : 'border-white/10 hover:border-neon-cyan/40'
      }`}
    >
      {/* 头部：key 大字 + kind 徽章 + 血统徽章 + 晋升时间 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-lg font-extrabold tracking-wide text-slate-100">
          {slotKey}
        </span>
        {spec ? (
          <span className="badge border border-neon-purple/40 bg-neon-purple/10 font-mono text-neon-purple">
            {spec.kind}
          </span>
        ) : (
          <span className="badge border border-white/15 bg-white/5 text-slate-500">空缺</span>
        )}
        <span className="badge border border-white/10 bg-white/5 font-mono text-slate-400">
          {record.lineage.length} 代血统
        </span>
        <span className="ml-auto font-mono text-[10px] text-slate-500">
          晋升 {relTime(promotedMs)}
        </span>
      </div>

      {/* 参数表 */}
      {spec && (
        <div className="mt-2.5 rounded-lg border border-white/5 bg-white/[0.02] p-2">
          {isEnsemble ? (
            <>
              <p className="font-mono text-[11px] text-slate-400">
                成员:{' '}
                <span className="text-slate-200">
                  {(spec as Extract<StrategySpec, { kind: 'ensemble' }>).members
                    .map((m) => m.kind)
                    .join(' + ')}
                </span>
              </p>
              <button
                className="mt-1 font-mono text-[10px] text-slate-500 transition hover:text-neon-cyan"
                onClick={() => setJsonOpen((v) => !v)}
              >
                {jsonOpen ? '▴ 收起完整 JSON' : '▾ 展开完整 JSON'}
              </button>
              {jsonOpen && (
                <pre className="mt-1.5 max-h-44 overflow-auto rounded-lg border border-neon-purple/20 bg-black/40 p-2 font-mono text-[10px] leading-relaxed text-neon-cyan">
                  {JSON.stringify(spec, null, 2)}
                </pre>
              )}
            </>
          ) : (
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
              {params.map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-2 font-mono text-[11px]">
                  <span className="text-slate-500">{k}</span>
                  <span className="font-bold text-slate-200">{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 血统迷你时间线 */}
      <div className="mt-2.5">
        <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
          血统 · holdout sharpe
        </p>
        <LineageTimeline record={record} />
      </div>

      {/* 回测验证 */}
      <div className="mt-3 flex items-center gap-2">
        <select
          className="select-dark py-1 text-xs"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          title="回测窗口"
        >
          {DAYS_OPTIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
        <button
          className="btn-neon ml-auto px-3 py-1 text-xs"
          onClick={() => onRun(days)}
          disabled={running || !spec}
        >
          {running ? '回测中…' : '跑回测验证'}
        </button>
      </div>
    </div>
  )
}

// ---------- backtest result section ----------

interface RunMeta {
  key: string
  symbol: string
  interval: string
  days: number
  crypto: boolean
}

function ResultSection({ meta, result }: { meta: RunMeta; result: BacktestResult }) {
  const chartDivRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const equityRef = useRef<ISeriesApi<'Area'> | null>(null)

  // Build/refresh the equity Area chart (same styling as BacktestPanel).
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
      equityRef.current = chart.addAreaSeries({
        lineColor: '#22d3ee',
        topColor: 'rgba(34,211,238,0.25)',
        bottomColor: 'rgba(34,211,238,0.0)',
        lineWidth: 2,
        priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      })
      chartRef.current = chart
    }
    equityRef.current?.setData(
      result.equity.map((p) => ({ time: toUnixSec(p.time) as UTCTimestamp, value: p.equity })),
    )
    chartRef.current.timeScale().fitContent()
  }, [result])

  // Destroy chart on unmount.
  useEffect(
    () => () => {
      chartRef.current?.remove()
      chartRef.current = null
      equityRef.current = null
    },
    [],
  )

  const m = result.metrics
  const first = result.equity[0]
  const last = result.equity[result.equity.length - 1]
  const rangeStr =
    first && last
      ? `${fmtDate(toUnixSec(first.time) * 1000)} ~ ${fmtDate(toUnixSec(last.time) * 1000)}`
      : `${meta.days}d`

  const pf = m.profit_factor
  const pfDisplay = Number.isFinite(pf) ? fmtNum(pf) : pf > 0 ? '∞' : '—'
  const pfTone: Tone = !Number.isFinite(pf) && !(pf > 0) ? 'neutral' : pf > 1 ? 'pos' : pf < 1 ? 'neg' : 'neutral'

  return (
    <div className="mt-4 rounded-xl border border-neon-cyan/25 bg-black/30 p-4 shadow-[0_0_18px_rgba(34,211,238,0.12)]">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-mono text-base font-extrabold tracking-wide text-slate-100">
          {meta.key} <span className="text-sm font-medium text-slate-500">回测验证</span>
        </h3>
        <span className="ml-auto font-mono text-[10px] text-slate-500">
          回测区间 {rangeStr} · {meta.days}d · 成本假设:{' '}
          {meta.crypto ? '自动（加密资产默认）' : 'moomoo 美股成本口径'}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 预测准确度组 */}
        <div>
          <GroupTitle tone="cyan" title="预测准确度" sub="Prediction Accuracy" />
          <div className="grid grid-cols-2 gap-2">
            <Metric
              label="方向命中率 Hit Rate"
              value={fmtPct(m.hit_rate, 1)}
              tone={m.hit_rate >= 0.5 ? 'pos' : 'neg'}
              sub="持仓bar中赚钱bar占比"
              big
            />
            <Metric
              label="盈亏比 Profit Factor"
              value={pfDisplay}
              tone={pfTone}
              sub="总盈利 ÷ 总亏损"
              big
            />
            <Metric
              label="笔级胜率 Win Rate"
              value={fmtPct(m.win_rate, 1)}
              tone={m.win_rate >= 0.5 ? 'pos' : 'neg'}
            />
            <Metric label="交易笔数 Trades" value={String(m.num_trades)} tone="neutral" />
          </div>
        </div>

        {/* 期望收益组 */}
        <div>
          <GroupTitle tone="purple" title="期望收益" sub="Expected Return" />
          <div className="grid grid-cols-3 gap-2">
            <Metric
              label="年化收益"
              value={fmtPct(m.annual_return)}
              tone={signTone(m.annual_return)}
            />
            <Metric label="Sharpe" value={fmtNum(m.sharpe)} tone={signTone(m.sharpe)} />
            <Metric label="Sortino" value={fmtNum(m.sortino)} tone={signTone(m.sortino)} />
            <Metric label="最大回撤" value={fmtPct(m.max_drawdown)} tone="neg" />
            <Metric label="Calmar" value={fmtNum(m.calmar)} tone={signTone(m.calmar)} />
            <Metric
              label="DSR"
              value={fmtPct(m.deflated_sharpe_prob, 1)}
              tone={m.deflated_sharpe_prob >= 0.95 ? 'pos' : 'neutral'}
            />
          </div>
        </div>
      </div>

      {/* 净值曲线 */}
      <div ref={chartDivRef} className="mt-3 h-56 w-full" />
    </div>
  )
}

// ---------- panel ----------

export default function StrategiesPanel() {
  const [champions, setChampions] = useState<ChampionRegistryMap>({})
  const [error, setError] = useState<string | null>(null)
  const [btError, setBtError] = useState<string | null>(null)
  const [runningKey, setRunningKey] = useState<string | null>(null)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [runMeta, setRunMeta] = useState<RunMeta | null>(null)

  const load = useCallback(async () => {
    try {
      setChampions(await fetchChampions())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 进化结束可能晋升新冠军——重新同步注册表。
  useWsMessages((msg) => {
    if (msg.channel === 'evolve_done') void load()
  })

  const runValidation = useCallback(
    async (key: string, record: ChampionRecord, days: number) => {
      if (!record.spec || runningKey) return
      setRunningKey(key)
      setBtError(null)
      try {
        const crypto = isCrypto(record.symbol)
        const res = await runBacktest(
          record.symbol,
          record.interval,
          days,
          record.spec,
          crypto ? undefined : MOOMOO_US_COST,
        )
        setResult(res)
        setRunMeta({ key, symbol: record.symbol, interval: record.interval, days, crypto })
      } catch (e) {
        setBtError(e instanceof Error ? e.message : String(e))
      } finally {
        setRunningKey(null)
      }
    },
    [runningKey],
  )

  const keys = Object.keys(champions).sort()

  return (
    <section className="glass-card flex flex-col p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="panel-title">
          Strategy Profiles <span className="text-slate-500">· 策略档案</span>
        </h2>
        <span className="badge border border-white/15 bg-white/5 font-mono text-slate-400">
          {keys.length} 策略
        </span>
      </div>

      {error && (
        <p className="mb-2 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {error}
        </p>
      )}

      {keys.length === 0 && !error && (
        <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          暂无策略档案——启动进化晋升冠军后将自动建档
        </div>
      )}

      {keys.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {keys.map((k) => (
            <StrategyCard
              key={k}
              slotKey={k}
              record={champions[k]}
              active={runMeta?.key === k}
              running={runningKey === k}
              onRun={(days) => void runValidation(k, champions[k], days)}
            />
          ))}
        </div>
      )}

      {btError && (
        <p className="mt-3 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {btError}
        </p>
      )}

      {result && runMeta && <ResultSection meta={runMeta} result={result} />}

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{METHOD_NOTE}</p>
    </section>
  )
}
