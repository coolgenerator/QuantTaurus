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
  type SpecKind,
  type StrategySpec, slotLabel,} from '../api'
import { isCrypto } from './TopBar'
import { useI18n } from '../i18n'
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
  { value: 365, label: '1y' },
  { value: 730, label: '2y' },
  { value: 3650, label: '10y' },
]

const methodNote = (zh: boolean) =>
  zh
    ? '命中率略高于50% × 盈亏比>1 是动量类策略的正常形态；DSR>0.95 才视为统计显著。回测为样本内参考，留出窗表现见血统。'
    : 'A hit rate slightly above 50% with profit factor above 1 is normal for momentum strategies. DSR > 0.95 is the bar for statistical significance. Backtests here are in-sample references; holdout behavior is shown in lineage.'

// ---------- small helpers ----------

/** Compact relative time, e.g. "3 小时前". */
function relTime(ms: number, zh: boolean): string {
  if (!ms) return '—'
  const diff = Date.now() - ms
  if (diff < 0) return zh ? '刚刚' : 'just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return zh ? '刚刚' : 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return zh ? `${min} 分钟前` : `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return zh ? `${hr} 小时前` : `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return zh ? `${day} 天前` : `${day}d ago`
  const mon = Math.floor(day / 30)
  if (mon < 12) return zh ? `${mon} 个月前` : `${mon}mo ago`
  return zh ? `${Math.floor(mon / 12)} 年前` : `${Math.floor(mon / 12)}y ago`
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
  const { lang } = useI18n()
  const zh = lang === 'zh'
  if (record.lineage.length === 0) {
    return <p className="font-mono text-[10px] text-slate-600">{zh ? '暂无血统记录' : 'No lineage yet'}</p>
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
          title={zh ? `第 ${i + 1} 代 · ${fmtDate(l.promoted_ms)} · holdout sharpe ${l.holdout_sharpe.toFixed(2)} · ${l.spec.kind}` : `generation ${i + 1} · ${fmtDate(l.promoted_ms)} · holdout sharpe ${l.holdout_sharpe.toFixed(2)} · ${l.spec.kind}`}
        />
      ))}
      <span className="ml-1 font-mono text-[10px] text-slate-500">
        {zh ? '最新' : 'latest'} {record.lineage[record.lineage.length - 1].holdout_sharpe.toFixed(2)}
      </span>
    </div>
  )
}

// ---------- strategy families (algorithm-level view) ----------

interface FamilyInfo {
  kind: SpecKind
  /** English/code name, equals the spec kind. */
  name: string
  /** Chinese display name. */
  zh: string
  /** Factor composition. */
  factors: string
  /** Academic provenance. */
  source: string
}

const FAMILIES: FamilyInfo[] = [
  {
    kind: 'tsmom',
    name: 'tsmom',
    zh: '时序动量',
    factors: 'N日动量',
    source: 'Moskowitz, Ooi & Pedersen (2012) Time Series Momentum',
  },
  {
    kind: 'vol_managed_momentum',
    name: 'vol_managed_momentum',
    zh: '波动率管理动量',
    factors: '动量 + 已实现波动率',
    source: 'Moreira & Muir (2017)',
  },
  {
    kind: 'bollinger_reversion',
    name: 'bollinger_reversion',
    zh: '布林均值回归',
    factors: '价格z分',
    source: '经典统计套利',
  },
  {
    kind: 'multi_factor',
    name: 'multi_factor',
    zh: '多因子打分',
    factors: '动量+资金流不平衡+波动率',
    source: 'Cont et al. (2014) OFI 等',
  },
  {
    kind: 'ensemble',
    name: 'ensemble',
    zh: '组合策略',
    factors: '成员策略等权',
    source: '模型平均/方差降低',
  },
]

const familyFootnote = (zh: boolean) =>
  zh
    ? '算法（因子逻辑）通用于任何标的；下方档案卡是算法×参数×标的通过三道防过拟合闸门后的验证实例。'
    : 'Algorithms and factor logic are symbol-agnostic. Profile cards below are validated algorithm × parameter × symbol instances that passed the anti-overfit gates.'

interface FamilyInstance {
  /** Slot key, e.g. "SPY|1d". */
  key: string
  /** Latest holdout sharpe from lineage; null when lineage is empty. */
  holdoutSharpe: number | null
}

/** Aggregate champion registry instances per family kind. */
function familyInstances(champions: ChampionRegistryMap, kind: SpecKind): FamilyInstance[] {
  return Object.keys(champions)
    .sort()
    .filter((k) => champions[k].spec?.kind === kind)
    .map((k) => {
      const lineage = champions[k].lineage
      const latest = lineage.length > 0 ? lineage[lineage.length - 1] : null
      return { key: k, holdoutSharpe: latest ? latest.holdout_sharpe : null }
    })
}

function FamilyCard({
  family,
  instances,
  onJump,
}: {
  family: FamilyInfo
  instances: FamilyInstance[]
  onJump: (key: string) => void
}) {
  const { lang } = useI18n()
  const zh = lang === 'zh'
  return (
    <div className="flex flex-col rounded-xl border border-white/10 bg-black/20 p-3 transition hover:border-neon-purple/40 hover:bg-white/5">
      {/* 家族名 + 中文名 */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-sm font-extrabold tracking-wide text-neon-purple drop-shadow-[0_0_8px_rgba(167,139,250,0.45)]">
          {family.name}
        </span>
        <span className="text-sm font-bold text-slate-100">{zh ? family.zh : family.name}</span>
      </div>

      {/* 因子构成 */}
      <p className="mt-1.5 text-[11px] leading-snug text-slate-400">
        <span className="text-slate-500">{zh ? '因子' : 'Factors'}: </span>
        <span className="font-mono text-slate-300">{family.factors}</span>
      </p>

      {/* 学术出处 */}
      <p className="mt-0.5 text-[10px] italic leading-snug text-slate-500">{family.source}</p>

      {/* 实例战绩汇总 */}
      <div className="mt-2 border-t border-white/5 pt-2">
        {instances.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-slate-500">{zh ? '通过闸门' : 'Passed gates'}:</span>
            {instances.map((inst) => (
              <button
                key={inst.key}
                onClick={() => onJump(inst.key)}
                title={zh ? `点击定位到 ${slotLabel(inst.key)} 的冠军档案卡` : `Jump to ${slotLabel(inst.key)} champion profile`}
                className="rounded-full border border-neon-green/40 bg-neon-green/10 px-2 py-0.5 font-mono text-[10px] font-bold text-neon-green transition hover:border-neon-green/80 hover:bg-neon-green/20 hover:shadow-[0_0_8px_rgba(74,222,128,0.4)]"
              >
                {slotLabel(inst.key)}
                {inst.holdoutSharpe !== null && (
                  <span className="font-medium"> ({inst.holdoutSharpe.toFixed(2)})</span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <span className="inline-block rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-slate-500">
            {zh ? '暂无通过闸门的实例' : 'No passing instances yet'}
          </span>
        )}
      </div>
    </div>
  )
}

function FamilySection({
  champions,
  onJump,
}: {
  champions: ChampionRegistryMap
  onJump: (key: string) => void
}) {
  const { lang } = useI18n()
  const zh = lang === 'zh'
  return (
    <div className="mb-4 rounded-xl border border-neon-purple/20 bg-white/[0.02] p-3">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-extrabold tracking-wide text-neon-purple drop-shadow-[0_0_8px_rgba(167,139,250,0.5)]">
          {zh ? '策略家族' : 'Strategy Families'} <span className="font-mono text-[10px] font-medium text-slate-500">· {zh ? '算法视角' : 'algorithm view'}</span>
        </h3>
        <span className="badge border border-white/10 bg-white/5 font-mono text-slate-400">
          {FAMILIES.length} {zh ? '家族' : 'families'}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {FAMILIES.map((f) => (
          <FamilyCard
            key={f.kind}
            family={f}
            instances={familyInstances(champions, f.kind)}
            onJump={onJump}
          />
        ))}
      </div>

      <p className="mt-2.5 text-[10px] leading-relaxed text-slate-500">{familyFootnote(zh)}</p>
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
  const { lang } = useI18n()
  const zh = lang === 'zh'
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
          <span className="badge border border-white/15 bg-white/5 text-slate-500">{zh ? '空缺' : 'empty'}</span>
        )}
        <span className="badge border border-white/10 bg-white/5 font-mono text-slate-400">
          {record.lineage.length} {zh ? '代血统' : 'lineage'}
        </span>
        <span className="ml-auto font-mono text-[10px] text-slate-500">
          {zh ? '晋升' : 'promoted'} {relTime(promotedMs, zh)}
        </span>
      </div>

      {/* 参数表 */}
      {spec && (
        <div className="mt-2.5 rounded-lg border border-white/5 bg-white/[0.02] p-2">
          {isEnsemble ? (
            <>
              <p className="font-mono text-[11px] text-slate-400">
                {zh ? '成员' : 'Members'}:{' '}
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
                {jsonOpen ? (zh ? '▴ 收起完整 JSON' : '▴ Collapse JSON') : (zh ? '▾ 展开完整 JSON' : '▾ Expand JSON')}
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
          {zh ? '血统' : 'Lineage'} · holdout sharpe
        </p>
        <LineageTimeline record={record} />
      </div>

      {/* 回测验证 */}
      <div className="mt-3 flex items-center gap-2">
        <select
          className="select-dark py-1 text-xs"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          title={zh ? '回测窗口' : 'Backtest window'}
        >
          {DAYS_OPTIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {zh ? d.label.replace('y', ' 年') : d.label}
            </option>
          ))}
        </select>
        <button
          className="btn-neon ml-auto px-3 py-1 text-xs"
          onClick={() => onRun(days)}
          disabled={running || !spec}
        >
          {running ? (zh ? '回测中...' : 'Backtesting...') : (zh ? '跑回测验证' : 'Run validation')}
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
  const { lang } = useI18n()
  const zh = lang === 'zh'
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
          {slotLabel(meta.key)} <span className="text-sm font-medium text-slate-500">{zh ? '回测验证' : 'validation backtest'}</span>
        </h3>
        <span className="ml-auto font-mono text-[10px] text-slate-500">
          {zh ? '回测区间' : 'range'} {rangeStr} · {meta.days}d · {zh ? '成本假设' : 'cost'}:{' '}
          {meta.crypto ? (zh ? '自动（加密资产默认）' : 'auto crypto default') : (zh ? 'moomoo 美股成本口径' : 'moomoo US stock model')}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 预测准确度组 */}
        <div>
          <GroupTitle tone="cyan" title={zh ? '预测准确度' : 'Prediction Accuracy'} sub={zh ? 'Prediction Accuracy' : ''} />
          <div className="grid grid-cols-2 gap-2">
            <Metric
              label={zh ? '方向命中率 Hit Rate' : 'Hit Rate'}
              value={fmtPct(m.hit_rate, 1)}
              tone={m.hit_rate >= 0.5 ? 'pos' : 'neg'}
              sub={zh ? '持仓bar中赚钱bar占比' : 'share of profitable held bars'}
              big
            />
            <Metric
              label={zh ? '盈亏比 Profit Factor' : 'Profit Factor'}
              value={pfDisplay}
              tone={pfTone}
              sub={zh ? '总盈利 ÷ 总亏损' : 'gross profit / gross loss'}
              big
            />
            <Metric
              label={zh ? '笔级胜率 Win Rate' : 'Win Rate'}
              value={fmtPct(m.win_rate, 1)}
              tone={m.win_rate >= 0.5 ? 'pos' : 'neg'}
            />
            <Metric label={zh ? '交易笔数 Trades' : 'Trades'} value={String(m.num_trades)} tone="neutral" />
          </div>
        </div>

        {/* 期望收益组 */}
        <div>
          <GroupTitle tone="purple" title={zh ? '期望收益' : 'Expected Return'} sub={zh ? 'Expected Return' : ''} />
          <div className="grid grid-cols-3 gap-2">
            <Metric
              label={zh ? '年化收益' : 'Annual Return'}
              value={fmtPct(m.annual_return)}
              tone={signTone(m.annual_return)}
            />
            <Metric label="Sharpe" value={fmtNum(m.sharpe)} tone={signTone(m.sharpe)} />
            <Metric label="Sortino" value={fmtNum(m.sortino)} tone={signTone(m.sortino)} />
            <Metric label={zh ? '最大回撤' : 'Max Drawdown'} value={fmtPct(m.max_drawdown)} tone="neg" />
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
  const { lang } = useI18n()
  const zh = lang === 'zh'
  const [champions, setChampions] = useState<ChampionRegistryMap>({})
  const [error, setError] = useState<string | null>(null)
  const [btError, setBtError] = useState<string | null>(null)
  const [runningKey, setRunningKey] = useState<string | null>(null)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [runMeta, setRunMeta] = useState<RunMeta | null>(null)

  // 家族 chip → 冠军档案卡定位高亮
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [flashKey, setFlashKey] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const jumpToCard = useCallback((key: string) => {
    cardRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlashKey(key)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setFlashKey(null), 1600)
  }, [])

  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    },
    [],
  )

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
          Strategy Profiles <span className="text-slate-500">· {zh ? '策略档案' : 'strategy profiles'}</span>
        </h2>
        <span className="badge border border-white/15 bg-white/5 font-mono text-slate-400">
          {keys.length} {zh ? '策略' : 'strategies'}
        </span>
      </div>

      {error && (
        <p className="mb-2 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {error}
        </p>
      )}

      {/* 策略家族 · 算法层视图 */}
      <FamilySection champions={champions} onJump={jumpToCard} />

      {keys.length === 0 && !error && (
        <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          {zh ? '暂无策略档案——启动进化晋升冠军后将自动建档' : 'No strategy profiles yet. They appear after an evolution run promotes a champion.'}
        </div>
      )}

      {keys.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {keys.map((k) => (
            <div
              key={k}
              ref={(el) => {
                cardRefs.current[k] = el
              }}
              className={`rounded-xl transition-shadow duration-300 ${
                flashKey === k
                  ? 'ring-2 ring-neon-green/70 shadow-[0_0_24px_rgba(74,222,128,0.45)]'
                  : ''
              }`}
            >
              <StrategyCard
                slotKey={k}
                record={champions[k]}
                active={runMeta?.key === k}
                running={runningKey === k}
                onRun={(days) => void runValidation(k, champions[k], days)}
              />
            </div>
          ))}
        </div>
      )}

      {btError && (
        <p className="mt-3 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {btError}
        </p>
      )}

      {result && runMeta && <ResultSection meta={runMeta} result={result} />}

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{methodNote(zh)}</p>
    </section>
  )
}
