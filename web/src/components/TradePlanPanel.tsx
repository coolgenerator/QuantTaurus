import { useCallback, useEffect, useState } from 'react'
import { fetchTradePlans, fmtNum, type TradePlan } from '../api'

type Direction = 'long' | 'short' | 'flat'

function directionOf(plan: TradePlan): Direction {
  if (Math.abs(plan.target_position) < 0.05) return 'flat'
  return plan.target_position > 0 ? 'long' : 'short'
}

const DIR_BADGE: Record<Direction, { label: string; cls: string }> = {
  long: {
    label: '看涨 LONG',
    cls: 'border border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan drop-shadow-[0_0_8px_rgba(34,211,238,0.5)]',
  },
  short: {
    label: '看跌 SHORT',
    cls: 'border border-neon-red/50 bg-gradient-to-r from-rose-500/15 to-violet-500/15 text-neon-red drop-shadow-[0_0_8px_rgba(251,113,133,0.5)]',
  },
  flat: { label: '观望 FLAT', cls: 'border border-white/15 bg-white/5 text-slate-400' },
}

/** Countdown to next_decision_ms, e.g. "2h 31m 08s 后（今日美股收盘）". */
function fmtCountdown(targetMs: number, nowMs: number): string {
  const remain = targetMs - nowMs
  if (!targetMs || remain <= 0) return '待数据刷新'
  const sec = Math.floor(remain / 1000)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h}h ${m}m ${String(s).padStart(2, '0')}s 后（今日美股收盘）`
}

/** Signed percent, e.g. "-10.7%". */
function fmtSignedPct(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
}

function FlipLine({ plan, dir }: { plan: TradePlan; dir: Direction }) {
  if (plan.flip_price === null) {
    return <span className="text-slate-500">±40% 内信号稳固</span>
  }
  const pct = plan.flip_pct !== null ? ` (${fmtSignedPct(plan.flip_pct)})` : ''
  // 多头：跌破反转价 → 信号翻空（红）；空头：升破 → 翻多（绿）。
  if (dir === 'short') {
    return (
      <span className="text-neon-green">
        升破 {fmtNum(plan.flip_price)} 信号反转{pct}
      </span>
    )
  }
  return (
    <span className="text-neon-red">
      跌破 {fmtNum(plan.flip_price)} 信号反转{pct}
    </span>
  )
}

/** Confidence color tiers: >=70 green / >=50 amber / <50 red. */
function confidenceTone(confidence: number): { text: string; bar: string } {
  if (confidence >= 70)
    return { text: 'text-neon-green', bar: 'bg-gradient-to-r from-emerald-500 to-neon-green' }
  if (confidence >= 50)
    return { text: 'text-amber-400', bar: 'bg-gradient-to-r from-amber-500 to-amber-300' }
  return { text: 'text-neon-red', bar: 'bg-gradient-to-r from-rose-600 to-neon-red' }
}

/** ±1σ·√N target zone bar with a marker at the current price. */
function TargetZone({ plan }: { plan: TradePlan }) {
  if (plan.target_zone_low === null || plan.target_zone_high === null) return null
  const lo = plan.target_zone_low
  const hi = plan.target_zone_high
  const span = hi - lo
  // Marker position of last_close within [lo, hi], clamped to the bar.
  const pos = span > 0 ? Math.min(Math.max((plan.last_close - lo) / span, 0), 1) : 0.5
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between font-mono text-[11px]">
        <span className="text-neon-red">{fmtNum(lo)}</span>
        <span className="text-slate-500">统计目标区间</span>
        <span className="text-neon-green">{fmtNum(hi)}</span>
      </div>
      <div className="relative mt-1 h-2 rounded-full bg-gradient-to-r from-rose-500/40 via-white/10 to-emerald-500/40">
        {/* 现价标记点 */}
        <span
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink bg-neon-cyan shadow-[0_0_8px_rgba(34,211,238,0.9)]"
          style={{ left: `${(pos * 100).toFixed(1)}%` }}
          title={`现价 ${fmtNum(plan.last_close)}`}
        />
      </div>
      <p className="mt-1 text-right font-mono text-[10px] text-slate-500">
        ±1σ·√{Math.round(plan.horizon_days)}日 区间（每日收盘更新）
      </p>
    </div>
  )
}

function PlanCard({
  plan,
  nowMs,
  onNavigateStrategies,
}: {
  plan: TradePlan
  nowMs: number
  onNavigateStrategies?: () => void
}) {
  const dir = directionOf(plan)
  const badge = DIR_BADGE[dir]
  const conviction = Math.min(Math.abs(plan.target_position), 1)
  const sharpe = plan.holdout_sharpe
  const confidence = Math.min(Math.max(plan.confidence ?? 0, 0), 100)
  const confTone = confidenceTone(confidence)
  // 决策周期徽章只显示前半段（如「日线」），完整文案放 tooltip。
  const cadenceShort = (plan.decision_interval_label ?? '').split('·')[0]?.trim() || plan.interval

  const barCls =
    dir === 'short'
      ? 'bg-gradient-to-r from-neon-red to-neon-purple'
      : dir === 'long'
        ? 'bg-gradient-to-r from-neon-cyan to-neon-green'
        : 'bg-slate-600'

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3 transition hover:border-neon-cyan/40 hover:bg-white/5">
      {/* 头部：symbol + interval·strategy + 方向徽章 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xl font-extrabold tracking-wide text-slate-100">
          {plan.symbol}
        </span>
        {/* 策略徽章：点击跳转到「策略」Tab 查看该冠军的档案 */}
        <button
          onClick={onNavigateStrategies}
          className="badge border border-white/10 bg-white/5 font-mono font-medium text-slate-400 transition hover:border-neon-cyan/50 hover:text-neon-cyan"
          title={`信号策略: ${plan.strategy}（${plan.key} 冠军）· 点击查看策略档案`}
        >
          {plan.interval} · {plan.strategy}
        </button>
        {/* 判断周期徽章：hover 显示完整决策节奏说明 */}
        <span
          className="badge cursor-default border border-neon-purple/40 bg-neon-purple/10 font-mono font-medium text-neon-purple"
          title={plan.decision_interval_label}
        >
          {cadenceShort}
        </span>
        <span className={`badge ml-auto px-3 py-1 text-sm ${badge.cls}`}>{badge.label}</span>
      </div>

      {/* 信念强度条 */}
      <div className="mt-3 flex items-center gap-2">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
          <div
            className={`h-full rounded-full transition-all duration-500 ${barCls}`}
            style={{ width: `${Math.round(conviction * 100)}%` }}
          />
        </div>
        <span className="font-mono text-xs font-bold text-slate-300">
          {Math.round(conviction * 100)}% 仓位
        </span>
      </div>

      {/* 置信度：横条 + 数字 + 留出窗 sharpe 依据 */}
      <div className="mt-2 flex items-center gap-2">
        <span className="shrink-0 text-[11px] text-slate-500">置信度</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
          <div
            className={`h-full rounded-full transition-all duration-500 ${confTone.bar}`}
            style={{ width: `${Math.round(confidence)}%` }}
          />
        </div>
        <span className={`shrink-0 font-mono text-xs font-bold ${confTone.text}`}>
          {Math.round(confidence)} {plan.confidence_label}
        </span>
      </div>
      <p className="mt-1 font-mono text-[10px] text-slate-500">
        依据: 留出窗 Sharpe {sharpe === null ? '—' : sharpe.toFixed(2)}
      </p>

      {/* 决策依据：霓虹青竖线 + 等宽小字 */}
      {plan.rationale && (
        <div className="mt-3 border-l-2 border-neon-cyan/70 bg-neon-cyan/5 py-1.5 pl-2.5 pr-2">
          <p className="font-mono text-[11px] leading-relaxed text-slate-300">{plan.rationale}</p>
        </div>
      )}

      {/* 统计目标区间：±1σ·√N日 */}
      <TargetZone plan={plan} />

      {/* 关键价位 */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
        <span className="text-slate-400">
          现价 <span className="font-bold text-slate-200">{fmtNum(plan.last_close)}</span>
        </span>
        <span className="text-slate-700">·</span>
        <FlipLine plan={plan} dir={dir} />
      </div>

      {/* 下一决策倒计时 */}
      <div className="mt-2 font-mono text-xs text-slate-400">
        下一决策{' '}
        <span className="font-bold text-neon-purple">
          {fmtCountdown(plan.next_decision_ms, nowMs)}
        </span>
      </div>

      {/* 信号策略联动：跳转到「策略」Tab */}
      <button
        onClick={onNavigateStrategies}
        className="mt-2 block w-full text-left font-mono text-[11px] text-slate-500 transition hover:text-neon-cyan"
        title="点击查看策略档案"
      >
        信号策略: <span className="font-bold text-neon-purple">{plan.strategy}</span>
        <span className="text-slate-600">（{plan.key} 冠军）</span> ↗
      </button>
    </div>
  )
}

export default function TradePlanPanel({
  onNavigateStrategies,
}: {
  onNavigateStrategies?: () => void
}) {
  const [plans, setPlans] = useState<TradePlan[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      setPlans(await fetchTradePlans())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const refresh = useCallback(() => {
    setLoading(true)
    void load()
  }, [load])

  // 挂载拉一次 + 60s 自动刷新。
  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(id)
  }, [load])

  // 每秒一跳，驱动所有卡片的倒计时。
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <section className="glass-card flex flex-col p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="panel-title">
          Trade Plans <span className="text-slate-500">· 交易计划</span>
        </h2>
        <span className="badge border border-white/15 bg-white/5 font-mono text-slate-400">
          {plans.length} 计划
        </span>
        <button
          onClick={refresh}
          disabled={loading}
          className="ml-auto rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300 transition hover:border-neon-cyan/50 hover:text-neon-cyan disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? '刷新中…' : '↻ 刷新'}
        </button>
      </div>

      {error && (
        <p className="mb-2 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {error}
        </p>
      )}

      {plans.length === 0 && !error && (
        <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          暂无交易计划——冠军策略就绪后将自动生成
        </div>
      )}

      {plans.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {plans.map((p) => (
            <PlanCard
              key={p.key}
              plan={p}
              nowMs={nowMs}
              onNavigateStrategies={onNavigateStrategies}
            />
          ))}
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        动量类策略无固定目标价/止损价：仓位随波动率连续调整，方向持有至信号反转。反转价位 =
        若今日收盘到达该价，策略方向翻转的数学临界点，可作止损/反手参考。期权隐含目标区间见期权分析
        Tab 的 ATM IV。
      </p>
    </section>
  )
}
