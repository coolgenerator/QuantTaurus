import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchUniversePlan, fmtNum, fmtPct, type UniversePlan, type UniversePlanLeg } from '../api'

interface Props {
  /** 点击 symbol 联动主图（App 层负责切回股票分析页）。 */
  onSelectSymbol: (symbol: string) => void
}

const K_CHOICES = [3, 5, 8] as const

/** 多/空两侧的霓虹配色方案。 */
const SIDE_THEME = {
  long: {
    header: 'text-neon-cyan drop-shadow-[0_0_8px_rgba(34,211,238,0.5)]',
    cardBorder: 'border-neon-cyan/25 hover:border-neon-cyan/50',
    symbol: 'text-neon-cyan',
    scoreBadge: 'border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan',
    bar: 'bg-gradient-to-r from-neon-cyan to-neon-green',
  },
  short: {
    header: 'text-neon-red drop-shadow-[0_0_8px_rgba(251,113,133,0.5)]',
    cardBorder: 'border-neon-red/25 hover:border-neon-red/50',
    symbol: 'text-neon-red',
    scoreBadge: 'border border-neon-purple/40 bg-neon-purple/10 text-neon-purple',
    bar: 'bg-gradient-to-r from-neon-red to-neon-purple',
  },
} as const

/** weight_in_side 横条（同侧内权重，0..1）。 */
function WeightBar({ frac, cls }: { frac: number; cls: string }) {
  const pct = Math.round(Math.min(Math.max(frac, 0), 1) * 100)
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className={`h-full rounded-full transition-all duration-500 ${cls}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

/** 单只标的的迷你计划卡。 */
function LegCard({
  leg,
  onSelectSymbol,
}: {
  leg: UniversePlanLeg
  onSelectSymbol: (symbol: string) => void
}) {
  const theme = SIDE_THEME[leg.side]
  return (
    <div
      className={`rounded-xl border bg-black/20 px-3 py-2.5 transition hover:bg-white/5 ${theme.cardBorder}`}
    >
      {/* symbol 大字（点击联动主图）+ 因子分徽章 */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onSelectSymbol(leg.symbol)}
          title={`查看 ${leg.symbol} 主图分析`}
          className={`font-mono text-lg font-extrabold tracking-wide transition hover:scale-105 hover:brightness-125 ${theme.symbol}`}
        >
          {leg.symbol}
        </button>
        <span className={`badge font-mono text-[11px] ${theme.scoreBadge}`}>
          因子分 {fmtNum(leg.score, 3)}
        </span>
      </div>

      {/* 配仓行：可执行数字 + 同侧权重条 */}
      <div className="mt-1.5 flex items-center gap-3">
        {leg.shares > 0 ? (
          <p className="shrink-0 font-mono text-sm font-extrabold text-slate-100">
            ${fmtNum(leg.dollars, 0)} = {leg.shares}股 @ ${fmtNum(leg.last_close)}
          </p>
        ) : (
          <p className="shrink-0 font-mono text-sm font-extrabold text-amber-400">
            单股超配额，需调高资金
            <span className="ml-1 text-[11px] font-semibold text-amber-400/70">
              (@ ${fmtNum(leg.last_close)})
            </span>
          </p>
        )}
        <WeightBar frac={leg.weight_in_side} cls={theme.bar} />
        <span className="shrink-0 font-mono text-[11px] text-slate-500">
          {fmtPct(leg.weight_in_side, 0)}
        </span>
      </div>

      {/* 小字行：年化波动 + 期权替代提示 */}
      <p className="mt-1 text-[11px] text-slate-500">
        年化波动 {fmtPct(leg.vol_annual, 0)} · {leg.option_hint}
      </p>
    </div>
  )
}

/** 多/空一列：标题 + 迷你卡堆叠。 */
function SideColumn({
  side,
  title,
  legs,
  onSelectSymbol,
}: {
  side: 'long' | 'short'
  title: string
  legs: UniversePlanLeg[]
  onSelectSymbol: (symbol: string) => void
}) {
  const theme = SIDE_THEME[side]
  return (
    <div className="flex flex-col gap-2">
      <h3 className={`text-sm font-extrabold tracking-wide ${theme.header}`}>{title}</h3>
      {legs.length === 0 && (
        <div className="flex h-20 items-center justify-center rounded-xl border border-dashed border-white/10 text-xs text-slate-500">
          暂无候选标的
        </div>
      )}
      {legs.map((leg) => (
        <LegCard key={leg.symbol} leg={leg} onSelectSymbol={onSelectSymbol} />
      ))}
    </div>
  )
}

export default function UniversePlanPanel({ onSelectSymbol }: Props) {
  const [k, setK] = useState<number>(5)
  const [capital, setCapital] = useState<number>(10_000)
  const [includeShorts, setIncludeShorts] = useState(true)
  const [plan, setPlan] = useState<UniversePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // 防止快速连点时旧请求结果覆盖新请求。
  const reqSeq = useRef(0)

  const generate = useCallback(
    async (body: { k: number; capital_usd: number; include_shorts: boolean }) => {
      const seq = ++reqSeq.current
      setLoading(true)
      try {
        const res = await fetchUniversePlan(body)
        if (seq !== reqSeq.current) return
        setPlan(res)
        setError(null)
      } catch (e) {
        if (seq !== reqSeq.current) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (seq === reqSeq.current) setLoading(false)
      }
    },
    [],
  )

  // 挂载时用默认参数自动跑一次。
  useEffect(() => {
    void generate({ k: 5, capital_usd: 10_000, include_shorts: true })
  }, [generate])

  const onGenerate = useCallback(() => {
    void generate({
      k,
      capital_usd: Number.isFinite(capital) && capital > 0 ? capital : 10_000,
      include_shorts: includeShorts,
    })
  }, [generate, k, capital, includeShorts])

  // 因子库为空（后端 400 文本提示）时引导去因子 Lab。
  const factorLibEmpty = error !== null && /因子|factor/i.test(error)
  const showShorts = includeShorts && plan !== null

  return (
    <section className="glass-card flex flex-col p-4">
      {/* 标题 + as_of / horizon 徽章 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="panel-title">
          UNIVERSE TOP-K <span className="text-slate-500">· 全池精选计划</span>
        </h2>
        {plan && (
          <>
            <span className="badge border border-white/15 bg-white/5 font-mono text-slate-400">
              {new Date(plan.as_of).toLocaleDateString('zh-CN')}
            </span>
            <span className="badge border border-neon-cyan/40 bg-neon-cyan/10 font-mono text-neon-cyan">
              未来{Math.round(plan.horizon_days)}日
            </span>
          </>
        )}
      </div>

      {/* 控制行：K / 资金 / 含空头 / 生成 */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="text-xs text-slate-500">K</span>
          {K_CHOICES.map((n) => (
            <button
              key={n}
              onClick={() => setK(n)}
              className={`rounded-lg px-2.5 py-1 font-mono text-xs font-bold transition ${
                k === n
                  ? 'border border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan'
                  : 'border border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'
              }`}
            >
              {n}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1 text-xs text-slate-500">
          资金
          <span className="font-mono text-slate-400">$</span>
          <input
            type="number"
            min={100}
            step={1000}
            value={capital}
            onChange={(e) => setCapital(Number(e.target.value))}
            className="w-24 rounded-lg border border-white/10 bg-black/30 px-2 py-1 font-mono text-xs text-slate-200 outline-none transition focus:border-neon-cyan/50"
          />
        </label>

        <button
          onClick={() => setIncludeShorts((v) => !v)}
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${
            includeShorts
              ? 'border-neon-purple/50 bg-neon-purple/10 text-neon-purple'
              : 'border-white/10 bg-white/5 text-slate-500 hover:text-slate-300'
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${includeShorts ? 'bg-neon-purple' : 'bg-slate-600'}`}
          />
          含空头
        </button>

        <button
          onClick={onGenerate}
          disabled={loading}
          className="ml-auto rounded-lg border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-1.5 text-xs font-bold text-neon-cyan transition hover:bg-neon-cyan/20 hover:drop-shadow-[0_0_8px_rgba(34,211,238,0.6)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? '生成中…' : '⚡ 生成计划'}
        </button>
      </div>

      {/* 错误 / 因子库为空引导 */}
      {error && (
        <div className="mb-2 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {error}
          {factorLibEmpty && (
            <span className="ml-1 font-bold text-amber-400">→ 先去因子 Lab 挖掘</span>
          )}
        </div>
      )}

      {!plan && !error && (
        <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          全池计划生成中…
        </div>
      )}

      {plan && (
        <>
          {/* 双列：做多 / 做空 */}
          <div className={`grid grid-cols-1 gap-4 ${showShorts ? 'lg:grid-cols-2' : ''}`}>
            <SideColumn
              side="long"
              title="📈 做多 Top-K"
              legs={plan.longs}
              onSelectSymbol={onSelectSymbol}
            />
            {showShorts && (
              <SideColumn
                side="short"
                title="📉 做空 Bottom-K"
                legs={plan.shorts}
                onSelectSymbol={onSelectSymbol}
              />
            )}
          </div>

          {/* 底部：sizing 规则 + 置信度提示 */}
          <p className="mt-3 text-[11px] leading-relaxed text-slate-400">{plan.sizing_rule}</p>
          <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2">
            <p className="text-[11px] leading-relaxed text-amber-400">
              {plan.confidence.note} · 基于 {plan.confidence.n_factors} 个因子，平均样本外 IC{' '}
              <span className="font-mono font-bold">
                {fmtNum(plan.confidence.avg_holdout_ic, 4)}
              </span>
            </p>
          </div>
        </>
      )}
    </section>
  )
}
