import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchOptionsPaper,
  fetchPaperStatus,
  fetchTradePlans,
  fmtNum,
  type OptionPaperPosition,
  type PaperSession,
  type TradePlan,
} from '../api'

const OPT_SERVICE_HINT =
  '期权服务未运行：python3 bridge/options_service.py（需 OpenD 已登录）'

const OPTION_EXIT_RULES_TITLE =
  '自动平仓规则：① 股票信号反转（方向翻转即平仓） ② 剩余 DTE ≤ 7 强制平仓 ③ 权利金 -50% 止损 ④ 权利金 +100% 止盈'

const DAY_MS = 86_400_000

// ---------- small helpers ----------

function fmtUsd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `$${v.toLocaleString('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })}`
}

/** Countdown to next_decision_ms, e.g. "2h 31m 08s 后". */
function fmtCountdown(targetMs: number, nowMs: number): string {
  const remain = targetMs - nowMs
  if (!targetMs || remain <= 0) return '待数据刷新'
  const sec = Math.floor(remain / 1000)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h}h ${m}m ${String(s).padStart(2, '0')}s 后`
}

function fmtSignedPct(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
}

/** Parse "2026-07-02" as a local date; null on mismatch. */
function parseExpiry(expiry: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** "M/D" short date, e.g. "6/25". */
function fmtShortDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** "06-10 07:04" local entry time. */
function fmtEntryTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Relative time, e.g. "刚刚" / "35分钟前" / "2小时前" / "3天前". */
function fmtRelative(ms: number, nowMs: number): string {
  const diff = nowMs - ms
  if (diff < 0) return ''
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}小时前`
  return `${Math.floor(h / 24)}天前`
}

/** "06-10 07:04" + relative-time subline; em-dash when missing. */
function EntryTimeCell({ entryMs, nowMs }: { entryMs: number | undefined; nowMs: number }) {
  if (!entryMs || !Number.isFinite(entryMs)) return <span className="text-slate-600">—</span>
  return (
    <div className="whitespace-nowrap">
      <span className="text-slate-200">{fmtEntryTime(entryMs)}</span>
      <p className="mt-0.5 text-[10px] text-slate-600">{fmtRelative(entryMs, nowMs)}</p>
    </div>
  )
}

/** Signed equivalent shares (long green / short red) + notional subline. */
function SharesCell({ session }: { session: PaperSession }) {
  const sh = session.shares_equiv
  if (sh === undefined || !Number.isFinite(sh)) return <span className="text-slate-600">—</span>
  const cls = sh > 1e-9 ? 'text-neon-green' : sh < -1e-9 ? 'text-neon-red' : 'text-slate-400'
  return (
    <div className="whitespace-nowrap">
      <span className={`font-bold ${cls}`}>
        {sh > 0 ? '+' : ''}
        {sh.toFixed(1)} 股
      </span>
      <p className="mt-0.5 text-[10px] text-slate-600">
        ≈{fmtUsd(Math.abs(session.notional_usd ?? 0), 0)} 名义
      </p>
    </div>
  )
}

const SHARES_EQUIV_TITLE =
  '等效股数 = 仓位比例 × $10k 槽位名义资金 ÷ 现价；与 moomoo 模拟账户实际下单股数同口径'

function positionBadge(p: number): { text: string; cls: string } {
  if (p > 1e-9) {
    return {
      text: `多 LONG ${Math.round(p * 100)}%`,
      cls: 'border-neon-green/40 bg-neon-green/10 text-neon-green',
    }
  }
  if (p < -1e-9) {
    return {
      text: `空 SHORT ${Math.round(Math.abs(p) * 100)}%`,
      cls: 'border-neon-red/40 bg-neon-red/10 text-neon-red',
    }
  }
  return { text: '观望 FLAT', cls: 'border-white/15 bg-white/5 text-slate-400' }
}

// ---------- stock holdings ----------

interface StockRow {
  key: string
  session: PaperSession
  plan: TradePlan | null
}

/** Mini ±1σ target-zone bar with a dot at the current price. */
function MiniTargetZone({ plan }: { plan: TradePlan }) {
  if (plan.target_zone_low === null || plan.target_zone_high === null) {
    return <span className="text-slate-600">—</span>
  }
  const lo = plan.target_zone_low
  const hi = plan.target_zone_high
  const span = hi - lo
  const pos = span > 0 ? Math.min(Math.max((plan.last_close - lo) / span, 0), 1) : 0.5
  return (
    <div className="min-w-[140px]">
      <div className="flex items-center justify-between font-mono text-[10px]">
        <span className="text-neon-red">{fmtNum(lo)}</span>
        <span className="text-neon-green">{fmtNum(hi)}</span>
      </div>
      <div className="relative mt-0.5 h-1.5 rounded-full bg-gradient-to-r from-rose-500/40 via-white/10 to-emerald-500/40">
        <span
          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-ink bg-neon-cyan shadow-[0_0_6px_rgba(34,211,238,0.9)]"
          style={{ left: `${(pos * 100).toFixed(1)}%` }}
          title={`现价 ${fmtNum(plan.last_close)} 在区间内位置 ${(pos * 100).toFixed(0)}%`}
        />
      </div>
    </div>
  )
}

function FlipCell({ plan }: { plan: TradePlan }) {
  return (
    <div>
      {plan.flip_price === null ? (
        <span className="text-slate-500">±40% 内稳固</span>
      ) : (
        <span className={plan.target_position >= 0 ? 'text-neon-red' : 'text-neon-green'}>
          {fmtNum(plan.flip_price)}
          {plan.flip_pct !== null && (
            <span className="text-slate-500"> ({fmtSignedPct(plan.flip_pct)})</span>
          )}
        </span>
      )}
      <p className="mt-0.5 text-[10px] text-slate-600">每日收盘动态重算</p>
    </div>
  )
}

function StockHoldingsTable({ rows, nowMs }: { rows: StockRow[]; nowMs: number }) {
  if (rows.length === 0) {
    return (
      <div className="flex h-20 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
        暂无股票持仓——冠军模拟盘开仓后自动显示
      </div>
    )
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-white/5">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-white/[0.03] text-[10px] uppercase tracking-wider text-slate-500">
            {(
              [
                { label: '标的' },
                { label: '方向 · 仓位' },
                { label: '持仓数量', title: SHARES_EQUIV_TITLE },
                { label: '建仓日期' },
                { label: '现价' },
                { label: '信号反转价' },
                { label: '统计目标区间' },
                { label: '下一决策' },
              ] as { label: string; title?: string }[]
            ).map((h) => (
              <th
                key={h.label}
                className="border-b border-white/10 px-2.5 py-1.5 text-left"
                title={h.title}
              >
                {h.label}
                {h.title && <span className="ml-0.5 cursor-help text-slate-600">ⓘ</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, session, plan }) => {
            const badge = positionBadge(session.position)
            return (
              <tr
                key={key}
                className="border-b border-white/[0.03] font-mono text-xs transition hover:bg-white/[0.06]"
              >
                <td className="px-2.5 py-2 font-bold text-slate-100">{key}</td>
                <td className="px-2.5 py-2">
                  <span className={`badge border ${badge.cls}`}>{badge.text}</span>
                </td>
                <td className="px-2.5 py-2" title={SHARES_EQUIV_TITLE}>
                  <SharesCell session={session} />
                </td>
                <td className="px-2.5 py-2">
                  <EntryTimeCell entryMs={session.entry_ms} nowMs={nowMs} />
                </td>
                <td className="px-2.5 py-2 text-slate-200">
                  {plan ? fmtNum(plan.last_close) : fmtNum(session.last_price)}
                </td>
                <td className="px-2.5 py-2">
                  {plan ? <FlipCell plan={plan} /> : <span className="text-slate-600">—</span>}
                </td>
                <td className="px-2.5 py-2">
                  {plan ? <MiniTargetZone plan={plan} /> : <span className="text-slate-600">—</span>}
                </td>
                <td className="px-2.5 py-2 text-neon-purple">
                  {plan ? fmtCountdown(plan.next_decision_ms, nowMs) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------- option holdings ----------

/** Stop-loss → take-profit bar: left = entry×0.5, right = entry×2.0, dot = mark. */
function StopTargetBar({ entry, mark }: { entry: number; mark: number }) {
  const lo = entry * 0.5
  const hi = entry * 2.0
  const span = hi - lo
  const pos = span > 0 ? Math.min(Math.max((mark - lo) / span, 0), 1) : 0.5
  // 靠近止损端（左端 15% 以内）→ 红色脉冲警示。
  const danger = pos <= 0.15
  return (
    <div className="min-w-[150px]">
      <div className="flex items-center justify-between font-mono text-[10px]">
        <span className="text-neon-red" title="止损价（权利金 -50%）">
          {fmtUsd(lo)}
        </span>
        <span className="text-neon-green" title="止盈价（权利金 +100%）">
          {fmtUsd(hi)}
        </span>
      </div>
      <div className="relative mt-0.5 h-1.5 rounded-full bg-gradient-to-r from-rose-500/50 via-white/10 to-emerald-500/50">
        <span
          className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-ink ${
            danger
              ? 'animate-pulse bg-neon-red shadow-[0_0_8px_rgba(251,113,133,1)]'
              : 'bg-neon-cyan shadow-[0_0_6px_rgba(34,211,238,0.9)]'
          }`}
          style={{ left: `${(pos * 100).toFixed(1)}%` }}
          title={`现价 ${fmtUsd(mark)}${danger ? ' · 接近止损线！' : ''}`}
        />
      </div>
    </div>
  )
}

/** "7/2 → 最迟 6/25 卖出 · 还剩 15 天"; ≤3 days amber, overdue red. */
function SellByCell({ expiry, nowMs }: { expiry: string; nowMs: number }) {
  const exp = parseExpiry(expiry)
  if (!exp) return <span className="text-slate-600">{expiry}</span>
  const sellBy = new Date(exp.getTime() - 7 * DAY_MS)
  const now = new Date(nowMs)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const daysLeft = Math.round((sellBy.getTime() - todayStart) / DAY_MS)
  const tone =
    daysLeft < 0 ? 'text-neon-red' : daysLeft <= 3 ? 'text-amber-300' : 'text-slate-200'
  return (
    <span className="whitespace-nowrap">
      <span className="text-slate-400">{fmtShortDate(exp)}</span>
      <span className="text-slate-600"> → </span>
      <span className={tone}>
        最迟 {fmtShortDate(sellBy)} 卖出 ·{' '}
        {daysLeft < 0 ? '已超期' : `还剩 ${daysLeft} 天`}
        {daysLeft >= 0 && daysLeft <= 3 && ' ⚠'}
      </span>
    </span>
  )
}

function OptionHoldingsTable({
  positions,
  nowMs,
}: {
  positions: [string, OptionPaperPosition][]
  nowMs: number
}) {
  if (positions.length === 0) {
    return (
      <div className="flex h-20 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
        暂无期权持仓——期权模拟盘开仓后自动显示
      </div>
    )
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-white/5">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-white/[0.03] text-[10px] uppercase tracking-wider text-slate-500">
            {['标的', '合约', '买入日期', '成本 → 现价', '止盈止损进度', '目标售出日期'].map((h) => (
              <th key={h} className="border-b border-white/10 px-2.5 py-1.5 text-left">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {positions.map(([underlying, pos]) => {
            const pnl = pos.entry_premium > 0 ? (pos.mark / pos.entry_premium - 1) * 100 : null
            const pnlCls =
              pnl === null ? 'text-slate-500' : pnl >= 0 ? 'text-neon-green' : 'text-neon-red'
            const cp = pos.action === 'BUY CALL' ? 'C' : 'P'
            return (
              <tr
                key={underlying}
                className="border-b border-white/[0.03] font-mono text-xs transition hover:bg-white/[0.06]"
                title={OPTION_EXIT_RULES_TITLE}
              >
                <td className="px-2.5 py-2 font-bold text-slate-100">{underlying}</td>
                <td className="px-2.5 py-2 text-slate-300">
                  {fmtNum(pos.strike, pos.strike % 1 === 0 ? 0 : 2)}
                  <span className={cp === 'C' ? 'text-neon-cyan' : 'text-neon-purple'}>{cp}</span>{' '}
                  <span className="text-slate-500">{pos.expiry}</span>
                </td>
                <td className="px-2.5 py-2">
                  <EntryTimeCell entryMs={pos.entry_ms} nowMs={nowMs} />
                </td>
                <td className="px-2.5 py-2 whitespace-nowrap">
                  <span className="text-slate-400">{fmtUsd(pos.entry_premium)}</span>
                  <span className="text-slate-600"> → </span>
                  <span className="text-slate-200">{fmtUsd(pos.mark)}</span>{' '}
                  <span className={`font-bold ${pnlCls}`}>
                    {pnl === null ? '—' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%`}
                  </span>
                </td>
                <td className="px-2.5 py-2">
                  <StopTargetBar entry={pos.entry_premium} mark={pos.mark} />
                </td>
                <td className="px-2.5 py-2">
                  <SellByCell expiry={pos.expiry} nowMs={nowMs} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------- combined guide ----------

/**
 * 持仓退出指引：合并股票模拟盘 × 交易计划（按 key join）与期权模拟盘持仓，
 * 集中展示所有持仓的动态退出参数；60s 自动刷新，倒计时每秒一跳。
 */
export default function HoldingsGuide() {
  const [sessions, setSessions] = useState<Record<string, PaperSession>>({})
  const [plans, setPlans] = useState<TradePlan[]>([])
  const [optPositions, setOptPositions] = useState<[string, OptionPaperPosition][]>([])
  const [stockError, setStockError] = useState<string | null>(null)
  const [optError, setOptError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const load = useCallback(async () => {
    // 股票侧（/api）与期权侧（/opt-api）独立失败，互不拖累。
    const stock = Promise.all([fetchPaperStatus(), fetchTradePlans()]).then(
      ([paper, planList]) => {
        setSessions(paper.sessions ?? {})
        setPlans(planList)
        setStockError(null)
      },
      (e: unknown) => setStockError(e instanceof Error ? e.message : String(e)),
    )
    const opt = fetchOptionsPaper().then(
      (s) => {
        setOptPositions(Object.entries(s.positions ?? {}))
        setOptError(null)
      },
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        setOptError(msg.includes('failed:') ? msg : OPT_SERVICE_HINT)
      },
    )
    await Promise.all([stock, opt])
  }, [])

  // 挂载拉一次 + 60s 自动刷新。
  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(id)
  }, [load])

  // 每秒一跳，驱动倒计时与售出日期。
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  // 仅展示有实际仓位的会话（FLAT 不算持仓），join 同 key 的交易计划。
  const stockRows = useMemo<StockRow[]>(() => {
    const planByKey = new Map(plans.map((p) => [p.key, p]))
    return Object.keys(sessions)
      .sort()
      .filter((k) => Math.abs(sessions[k].position) > 1e-9)
      .map((k) => ({ key: k, session: sessions[k], plan: planByKey.get(k) ?? null }))
  }, [sessions, plans])

  return (
    <section className="glass-card flex flex-col p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="panel-title">
          Holdings Exit Guide <span className="text-slate-500">· 持仓退出指引</span>
        </h2>
        <span className="badge border border-white/15 bg-white/5 font-mono text-slate-400">
          {stockRows.length} 股票 · {optPositions.length} 期权
        </span>
        <span className="ml-auto font-mono text-[10px] text-slate-500">60s 自动刷新</span>
      </div>

      {stockError && (
        <p className="mb-2 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {stockError}
        </p>
      )}

      {/* 股票持仓 */}
      <p className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-500">
        股票持仓 · Stock Holdings
      </p>
      <StockHoldingsTable rows={stockRows} nowMs={nowMs} />

      {optError && (
        <p className="mb-2 mt-4 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {optError}
        </p>
      )}

      {/* 期权持仓 */}
      <p className="mb-1.5 mt-4 text-[10px] uppercase tracking-wider text-slate-500">
        期权持仓 · Option Holdings
      </p>
      <OptionHoldingsTable positions={optPositions} nowMs={nowMs} />

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        所有退出参数均为动态量：反转价与目标区间随每日收盘数据重算，售出日期随到期日滚动，无需手工修改。
      </p>
    </section>
  )
}
