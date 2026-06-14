import { useCallback, useEffect, useState } from 'react'
import { fetchTradePlans, fmtNum, type TradePlan, slotLabel} from '../api'
import { useI18n } from '../i18n'

type Direction = 'long' | 'short' | 'flat'

function directionOf(plan: TradePlan): Direction {
  if (Math.abs(plan.target_position) < 0.05) return 'flat'
  return plan.target_position > 0 ? 'long' : 'short'
}

const DIR_BADGE: Record<Direction, { labelKey: string; cls: string }> = {
  long: {
    labelKey: 'trade.long',
    cls: 'border border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan drop-shadow-[0_0_8px_rgba(34,211,238,0.5)]',
  },
  short: {
    labelKey: 'trade.short',
    cls: 'border border-neon-red/50 bg-gradient-to-r from-rose-500/15 to-violet-500/15 text-neon-red drop-shadow-[0_0_8px_rgba(251,113,133,0.5)]',
  },
  flat: { labelKey: 'trade.flat', cls: 'border border-white/15 bg-white/5 text-slate-400' },
}

/** Countdown to next_decision_ms, e.g. "2h 31m 08s 后（今日美股收盘）". */
function fmtCountdown(
  targetMs: number,
  nowMs: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const remain = targetMs - nowMs
  if (!targetMs || remain <= 0) return t('trade.waitRefresh')
  const sec = Math.floor(remain / 1000)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return t('trade.countdown', { time: `${h}h ${m}m ${String(s).padStart(2, '0')}s` })
}

/** Signed percent, e.g. "-10.7%". */
function fmtSignedPct(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
}

function FlipLine({
  plan,
  dir,
  t,
}: {
  plan: TradePlan
  dir: Direction
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  if (plan.flip_price === null) {
    return <span className="text-slate-500">{t('trade.stable')}</span>
  }
  const pct = plan.flip_pct !== null ? ` (${fmtSignedPct(plan.flip_pct)})` : ''
  // 多头：跌破反转价 → 信号翻空（红）；空头：升破 → 翻多（绿）。
  if (dir === 'short') {
    return (
      <span className="text-neon-green">
        {t('trade.flipUp', { price: fmtNum(plan.flip_price), pct })}
      </span>
    )
  }
  return (
    <span className="text-neon-red">
      {t('trade.flipDown', { price: fmtNum(plan.flip_price), pct })}
    </span>
  )
}

/** 盘中再决策行：以最新价作临时收盘的正式试算，模拟盘每30分钟按此调仓。 */
function IntradayLine({
  plan,
  t,
}: {
  plan: TradePlan
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const intradayTarget = plan.intraday_target ?? 0
  const drift = Math.abs(intradayTarget - plan.target_position)
  const tone = intradayTarget > 0.05 ? 'text-neon-green' : intradayTarget < -0.05 ? 'text-neon-red' : 'text-slate-400'
  const asOf =
    plan.intraday_as_of !== null
      ? new Date(plan.intraday_as_of).toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—'
  return (
    <div
      className="mt-2 rounded-lg border border-neon-purple/30 bg-neon-purple/5 px-2.5 py-1.5 font-mono text-[11px] text-slate-300"
      title={t('trade.intradayTooltip')}
    >
      {t('trade.intradayTitle')} <span className="text-slate-500">{asOf}</span> · {t('trade.lastPrice')}{' '}
      <span className="font-bold text-slate-200">{fmtNum(plan.intraday_price)}</span> → {t('trade.target')}{' '}
      <span className={`font-bold ${tone}`}>{Math.round(intradayTarget * 100)}%</span>
      {drift >= 0.1 ? (
        <span className="ml-1 font-bold text-amber-400">{t('trade.diffClose')}</span>
      ) : (
        <span className="ml-1 text-slate-500">{t('trade.sameClose')}</span>
      )}
    </div>
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
function TargetZone({
  plan,
  t,
}: {
  plan: TradePlan
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
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
        <span className="text-slate-500">{t('trade.targetZone')}</span>
        <span className="text-neon-green">{fmtNum(hi)}</span>
      </div>
      <div className="relative mt-1 h-2 rounded-full bg-gradient-to-r from-rose-500/40 via-white/10 to-emerald-500/40">
        {/* 现价标记点 */}
        <span
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink bg-neon-cyan shadow-[0_0_8px_rgba(34,211,238,0.9)]"
          style={{ left: `${(pos * 100).toFixed(1)}%` }}
          title={t('trade.currentPrice', { price: fmtNum(plan.last_close) })}
        />
      </div>
      <p className="mt-1 text-right font-mono text-[10px] text-slate-500">
        {t('trade.zoneHint', { days: Math.round(plan.horizon_days) })}
      </p>
    </div>
  )
}

function PlanCard({
  plan,
  nowMs,
  onNavigateStrategies,
  t,
}: {
  plan: TradePlan
  nowMs: number
  onNavigateStrategies?: () => void
  t: (key: string, vars?: Record<string, string | number>) => string
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
          title={`${t('common.signalStrategy')}: ${plan.strategy} (${t('common.champion', { key: slotLabel(plan.key) })}) · ${t('common.viewStrategyProfile')}`}
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
        <span className={`badge ml-auto px-3 py-1 text-sm ${badge.cls}`}>{t(badge.labelKey)}</span>
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
          {t('trade.position', { value: Math.round(conviction * 100) })}
        </span>
      </div>

      {/* 置信度：横条 + 数字 + 留出窗 sharpe 依据 */}
      <div className="mt-2 flex items-center gap-2">
        <span className="shrink-0 text-[11px] text-slate-500">{t('common.confidence')}</span>
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
        {t('trade.basis', { value: sharpe === null ? '—' : sharpe.toFixed(2) })}
      </p>

      {/* 决策依据：霓虹青竖线 + 等宽小字 */}
      {plan.rationale && (
        <div className="mt-3 border-l-2 border-neon-cyan/70 bg-neon-cyan/5 py-1.5 pl-2.5 pr-2">
          <p className="font-mono text-[11px] leading-relaxed text-slate-300">{plan.rationale}</p>
        </div>
      )}

      {/* 统计目标区间：±1σ·√N日 */}
      <TargetZone plan={plan} t={t} />

      {/* 关键价位 */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
        <span className="text-slate-400">
          {t('trade.lastPrice')} <span className="font-bold text-slate-200">{fmtNum(plan.last_close)}</span>
        </span>
        <span className="text-slate-700">·</span>
        <FlipLine plan={plan} dir={dir} t={t} />
      </div>

      {/* 盘中再决策：每30分钟以最新价作临时收盘正式重算，模拟盘按此调仓 */}
      {plan.intraday_target !== null && plan.intraday_target !== undefined && (
        <IntradayLine plan={plan} t={t} />
      )}

      {/* 下一决策倒计时 */}
      <div className="mt-2 font-mono text-xs text-slate-400">
        {t('trade.nextDecision')}{' '}
        <span className="font-bold text-neon-purple">
          {fmtCountdown(plan.next_decision_ms, nowMs, t)}
        </span>
      </div>

      {/* 信号策略联动：跳转到「策略」Tab */}
      <button
        onClick={onNavigateStrategies}
        className="mt-2 block w-full text-left font-mono text-[11px] text-slate-500 transition hover:text-neon-cyan"
        title={t('common.viewStrategyProfile')}
      >
        {t('common.signalStrategy')}: <span className="font-bold text-neon-purple">{plan.strategy}</span>
        <span className="text-slate-600"> ({t('common.champion', { key: slotLabel(plan.key) })})</span> ↗
      </button>
    </div>
  )
}

export default function TradePlanPanel({
  onNavigateStrategies,
}: {
  onNavigateStrategies?: () => void
}) {
  const { t } = useI18n()
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
          {t('trade.title')} <span className="text-slate-500">· {t('trade.subtitle')}</span>
        </h2>
        <span className="badge border border-white/15 bg-white/5 font-mono text-slate-400">
          {t('common.planCount', { n: plans.length })}
        </span>
        <button
          onClick={refresh}
          disabled={loading}
          className="ml-auto rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300 transition hover:border-neon-cyan/50 hover:text-neon-cyan disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? t('common.refreshing') : `↻ ${t('common.refresh')}`}
        </button>
      </div>

      {error && (
        <p className="mb-2 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {error}
        </p>
      )}

      {plans.length === 0 && !error && (
        <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          {t('trade.empty')}
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
              t={t}
            />
          ))}
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        {t('trade.footnote')}
      </p>
    </section>
  )
}
