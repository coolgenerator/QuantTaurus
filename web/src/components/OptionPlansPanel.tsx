import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchChampions,
  fetchOptionPlans,
  fetchOptionsPaper,
  fmtNum,
  type OptionPlan,
  type OptionPlansResponse,
  type OptionsPaperStatus,
} from '../api'

const SERVICE_HINT =
  '期权服务未运行：python3 bridge/options_service.py（需 OpenD 已登录）'

// ---------- small helpers ----------

const isNum = (v: number | null | undefined): v is number =>
  v !== null && v !== undefined && Number.isFinite(v)

function fmtInt(v: number | null | undefined): string {
  if (!isNum(v)) return '—'
  return Math.round(v).toLocaleString('en-US')
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

/** Source champion info for an option plan's underlying signal. */
interface SignalChampion {
  kind: string
  key: string
}

function OptionPlanCard({
  plan,
  champion,
  onNavigateStrategies,
}: {
  plan: OptionPlan
  champion?: SignalChampion
  onNavigateStrategies?: () => void
}) {
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

      {/* 信号策略联动：跳转到「策略」Tab 查看冠军档案 */}
      {champion && (
        <button
          onClick={onNavigateStrategies}
          className="mt-2 block w-full text-left font-mono text-[11px] text-slate-500 transition hover:text-neon-cyan"
          title="点击查看策略档案"
        >
          信号策略: <span className="font-bold text-neon-purple">{champion.kind}</span>
          <span className="text-slate-600">（{champion.key} 冠军）</span> ↗
        </button>
      )}

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

export function OptionPlansSection({
  onNavigateStrategies,
}: {
  onNavigateStrategies?: () => void
}) {
  const [data, setData] = useState<OptionPlansResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 标的 → 注册表冠军（kind + slot key），用于计划卡的「信号策略」联动行。
  const [champions, setChampions] = useState<Record<string, SignalChampion>>({})

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

  // 拉一次冠军注册表；同一标的多周期时优先 1d（期权计划由日线信号推导）。
  useEffect(() => {
    fetchChampions()
      .then((map) => {
        const bySymbol: Record<string, SignalChampion> = {}
        for (const [key, rec] of Object.entries(map)) {
          if (!rec.spec) continue
          if (!(rec.symbol in bySymbol) || rec.interval === '1d') {
            bySymbol[rec.symbol] = { kind: rec.spec.kind, key }
          }
        }
        setChampions(bySymbol)
      })
      .catch(() => {
        /* 注册表不可用时仅隐藏联动行 */
      })
  }, [])

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
            <OptionPlanCard
              key={p.code || `${p.underlying}-${p.action}`}
              plan={p}
              champion={champions[p.underlying]}
              onNavigateStrategies={onNavigateStrategies}
            />
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

export function OptionsPaperSection() {
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

// ---------- combined panel ----------

/** 期权交易计划区：仅计划卡（期权模拟盘已移至「持仓」页）。 */
export default function OptionPlansPanel({
  onNavigateStrategies,
}: {
  onNavigateStrategies?: () => void
}) {
  return <OptionPlansSection onNavigateStrategies={onNavigateStrategies} />
}
