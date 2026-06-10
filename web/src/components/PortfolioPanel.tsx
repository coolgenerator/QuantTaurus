import { useCallback, useEffect, useState } from 'react'
import { fetchPortfolio, fmtNum, fmtPct, type PortfolioReport, type PortfolioSlot } from '../api'

/** Signed weight color: long green / short red / flat slate. */
function weightTone(w: number): string {
  if (w > 0.0005) return 'text-neon-green'
  if (w < -0.0005) return 'text-neon-red'
  return 'text-slate-500'
}

/** Big number stat card used in the header row. */
function StatCard({
  label,
  value,
  valueCls,
  sub,
  subCls = 'text-slate-500',
}: {
  label: string
  value: string
  valueCls: string
  sub: string
  subCls?: string
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-extrabold tracking-tight ${valueCls}`}>{value}</p>
      <p className={`mt-0.5 font-mono text-[11px] ${subCls}`}>{sub}</p>
    </div>
  )
}

/** Horizontal mini bar for the planned weight, scaled to the largest slot. */
function WeightBar({ weight, maxAbs }: { weight: number; maxAbs: number }) {
  const frac = maxAbs > 0 ? Math.min(Math.abs(weight) / maxAbs, 1) : 0
  const cls =
    weight > 0.0005
      ? 'bg-gradient-to-r from-neon-cyan to-neon-green'
      : weight < -0.0005
        ? 'bg-gradient-to-r from-neon-red to-neon-purple'
        : 'bg-slate-600'
  return (
    <div className="h-1.5 w-full min-w-[64px] overflow-hidden rounded-full bg-white/10">
      <div
        className={`h-full rounded-full transition-all duration-500 ${cls}`}
        style={{ width: `${Math.round(frac * 100)}%` }}
      />
    </div>
  )
}

function SlotRow({ slot, maxAbs }: { slot: PortfolioSlot; maxAbs: number }) {
  return (
    <tr className="border-t border-white/5 transition hover:bg-white/5">
      <td className="px-2 py-2 font-mono text-xs font-bold text-slate-200">{slot.key}</td>
      <td className={`px-2 py-2 text-right font-mono text-xs ${weightTone(slot.raw_position)}`}>
        {fmtPct(slot.raw_position, 1)}
      </td>
      <td className={`px-2 py-2 text-right font-mono text-xs ${weightTone(slot.raw_weight)}`}>
        {fmtPct(slot.raw_weight, 1)}
      </td>
      <td className={`px-2 py-2 text-right font-mono text-sm font-extrabold ${weightTone(slot.adjusted_weight)}`}>
        {fmtPct(slot.adjusted_weight, 1)}
      </td>
      <td className="w-24 px-2 py-2">
        <WeightBar weight={slot.adjusted_weight} maxAbs={maxAbs} />
      </td>
    </tr>
  )
}

export default function PortfolioPanel() {
  const [report, setReport] = useState<PortfolioReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    try {
      setReport(await fetchPortfolio())
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

  const scaleTriggered = report !== null && report.scale < 0.9995
  const maxAbs = report ? Math.max(...report.slots.map((s) => Math.abs(s.adjusted_weight)), 0) : 0

  return (
    <section className="glass-card flex flex-col p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="panel-title">
          Portfolio <span className="text-slate-500">· 当日仓位规划 · 组合风控</span>
        </h2>
        {report && (
          <span className="badge border border-white/15 bg-white/5 font-mono text-slate-400">
            {report.slots.length} 槽位
          </span>
        )}
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

      {!report && !error && (
        <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          组合数据加载中…
        </div>
      )}

      {report && (
        <>
          {/* 顶部 4 个大数字卡 */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="组合总杠杆 Gross"
              value={`${fmtNum(report.gross_adjusted, 2)}×`}
              valueCls={
                report.gross_adjusted > report.gross_cap ? 'text-neon-red' : 'text-slate-100'
              }
              sub={`上限 ${fmtNum(report.gross_cap, 2)}×`}
            />
            <StatCard
              label="净敞口 Net"
              value={fmtPct(report.net_adjusted, 1)}
              valueCls={weightTone(report.net_adjusted)}
              sub={report.net_adjusted >= 0 ? '净多头' : '净空头'}
            />
            <StatCard
              label="估计组合年化波动"
              value={fmtPct(report.est_vol_annual_adjusted, 1)}
              valueCls={
                report.est_vol_annual_adjusted > report.vol_target_annual
                  ? 'text-amber-400'
                  : 'text-neon-cyan'
              }
              sub={`目标 ${fmtPct(report.vol_target_annual, 1)} · 缩放前 ${fmtPct(report.est_vol_annual_raw, 1)}`}
            />
            <StatCard
              label="风控缩放系数 Scale"
              value={`×${fmtNum(report.scale, 2)}`}
              valueCls={scaleTriggered ? 'text-amber-400' : 'text-neon-green'}
              sub={
                scaleTriggered ? `已缩减至 ${(report.scale * 100).toFixed(0)}%` : '未触发'
              }
              subCls={scaleTriggered ? 'text-amber-400/80' : 'text-neon-green/80'}
            />
          </div>

          {/* 仓位规划表 */}
          <div className="mt-4 overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-white/5 text-[11px] text-slate-400">
                  <th className="px-2 py-2 text-left font-semibold">槽位</th>
                  <th className="px-2 py-2 text-right font-semibold">原始信号仓位（槽内）</th>
                  <th className="px-2 py-2 text-right font-semibold">组合权重</th>
                  <th className="px-2 py-2 text-right font-semibold text-slate-200">
                    当日规划权重
                  </th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {report.slots.map((s) => (
                  <SlotRow key={s.key} slot={s} maxAbs={maxAbs} />
                ))}
              </tbody>
            </table>
          </div>

          {/* 口径解释卡 */}
          <div className="mt-3 rounded-xl border border-white/5 bg-black/20 px-3 py-2">
            <p className="text-[11px] leading-relaxed text-slate-400">
              {report.note}
              {report.note && ' '}
              各策略槽位仓位是槽内独立口径（每槽分配 1/N
              资金），直接相加会超过100%是口径错觉；本面板的组合权重才是真实资金占比。假设槽位间相关系数{' '}
              {fmtNum(report.assumed_correlation, 2)}。
            </p>
          </div>
        </>
      )}
    </section>
  )
}
