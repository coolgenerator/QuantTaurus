import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import {
  runBacktest,
  toUnixSec,
  fmtNum,
  fmtPct,
  type BacktestResult,
  type CostModel,
  type SpecKind,
  type StrategySpec,
} from '../api'

interface Props {
  symbol: string
  interval: string
}

interface FieldDef {
  name: string
  label: string
  step: number
}

/** Spec kinds with flat numeric params, editable in the manual backtest form.
 * 'ensemble' is evolution-only (nested members), so it is excluded here. */
type FormSpecKind = Exclude<SpecKind, 'ensemble'>

const SPEC_FORMS: Record<FormSpecKind, { label: string; fields: FieldDef[]; defaults: Record<string, number> }> = {
  tsmom: {
    label: 'TS Momentum',
    fields: [
      { name: 'lookback', label: 'Lookback', step: 1 },
      { name: 'deadband', label: 'Deadband', step: 0.0005 },
    ],
    defaults: { lookback: 24, deadband: 0.001 },
  },
  vol_managed_momentum: {
    label: 'Vol-Managed Momentum',
    fields: [
      { name: 'lookback', label: 'Lookback', step: 1 },
      { name: 'vol_window', label: 'Vol Window', step: 1 },
      { name: 'vol_target', label: 'Vol Target', step: 0.001 },
    ],
    defaults: { lookback: 24, vol_window: 48, vol_target: 0.005 },
  },
  bollinger_reversion: {
    label: 'Bollinger Reversion',
    fields: [
      { name: 'window', label: 'Window', step: 1 },
      { name: 'entry_z', label: 'Entry Z', step: 0.1 },
      { name: 'exit_z', label: 'Exit Z', step: 0.1 },
    ],
    defaults: { window: 20, entry_z: 1.0, exit_z: 0.2 },
  },
  multi_factor: {
    label: 'Multi Factor',
    fields: [
      { name: 'mom_lookback', label: 'Mom Lookback', step: 1 },
      { name: 'flow_window', label: 'Flow Window', step: 1 },
      { name: 'vol_window', label: 'Vol Window', step: 1 },
      { name: 'w_mom', label: 'W Mom', step: 0.1 },
      { name: 'w_flow', label: 'W Flow', step: 0.1 },
      { name: 'w_vol', label: 'W Vol', step: 0.1 },
    ],
    defaults: { mom_lookback: 24, flow_window: 12, vol_window: 48, w_mom: 1.0, w_flow: 0.5, w_vol: 0.5 },
  },
}

// ---------- 成本模型预设 ----------

type CostPresetKey = 'auto' | 'moomoo_us' | 'crypto_taker' | 'small_scalp' | 'custom'

const COST_PRESETS: Record<CostPresetKey, { label: string; cost: CostModel | null }> = {
  auto: { label: '自动（按资产类别）', cost: null },
  moomoo_us: {
    label: 'moomoo 美股',
    cost: { fee_rate: 0.00002, slippage: 0.0003, min_fee_usd: 0, capital_usd: 10000 },
  },
  crypto_taker: {
    label: '加密 taker',
    cost: { fee_rate: 0.001, slippage: 0.0005, min_fee_usd: 0, capital_usd: 10000 },
  },
  small_scalp: {
    label: '短线小资金',
    cost: { fee_rate: 0.00002, slippage: 0.0005, min_fee_usd: 1, capital_usd: 5000 },
  },
  custom: { label: '自定义', cost: null },
}

const COST_FIELDS: { name: keyof CostModel; label: string; step: number }[] = [
  { name: 'fee_rate', label: 'Fee Rate', step: 0.00001 },
  { name: 'slippage', label: 'Slippage', step: 0.0001 },
  { name: 'min_fee_usd', label: 'Min Fee $', step: 0.5 },
  { name: 'capital_usd', label: 'Capital $', step: 1000 },
]

/** 指标网格旁的成本假设说明文字。 */
function costNote(preset: CostPresetKey, cost: CostModel | undefined): string {
  if (preset === 'auto' || !cost) return '成本假设: 自动（按资产类别默认）'
  return `成本假设: ${COST_PRESETS[preset].label} · fee ${(cost.fee_rate * 100).toFixed(4)}% · slip ${(
    cost.slippage * 100
  ).toFixed(3)}% · min $${cost.min_fee_usd} · 本金 $${cost.capital_usd.toLocaleString('en-US')}`
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'pos' | 'neg' | 'neutral'
}) {
  const color =
    tone === 'pos' ? 'text-neon-green' : tone === 'neg' ? 'text-neon-red' : 'text-slate-200'
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 transition hover:border-neon-cyan/30">
      <p className={`font-mono text-lg font-bold leading-tight ${color}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
    </div>
  )
}

const signTone = (v: number): 'pos' | 'neg' => (v >= 0 ? 'pos' : 'neg')

export default function BacktestPanel({ symbol, interval }: Props) {
  const [kind, setKind] = useState<FormSpecKind>('tsmom')
  const [params, setParams] = useState<Record<string, number>>(SPEC_FORMS.tsmom.defaults)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [costOpen, setCostOpen] = useState(false)
  const [costPreset, setCostPreset] = useState<CostPresetKey>('auto')
  const [customCost, setCustomCost] = useState<CostModel>({
    fee_rate: 0.00002,
    slippage: 0.0003,
    min_fee_usd: 0,
    capital_usd: 10000,
  })
  // 上次回测实际使用的成本（用于指标旁注明）。
  const [usedCost, setUsedCost] = useState<{ preset: CostPresetKey; cost?: CostModel } | null>(null)

  const effectiveCost: CostModel | undefined =
    costPreset === 'auto'
      ? undefined
      : costPreset === 'custom'
        ? customCost
        : (COST_PRESETS[costPreset].cost ?? undefined)

  const chartDivRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const equityRef = useRef<ISeriesApi<'Area'> | null>(null)

  const changeKind = (k: FormSpecKind) => {
    setKind(k)
    setParams(SPEC_FORMS[k].defaults)
  }

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const spec = { kind, ...params } as unknown as StrategySpec
      const res = await runBacktest(symbol, interval, 365, spec, effectiveCost)
      setResult(res)
      setUsedCost({ preset: costPreset, cost: effectiveCost })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  // Build the equity chart lazily, once a result exists.
  useEffect(() => {
    if (!result || !chartDivRef.current) return
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

  const form = SPEC_FORMS[kind]
  const m = result?.metrics

  return (
    <section className="glass-card flex flex-col p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="panel-title">Backtest Lab</h2>
        <span className="ml-auto font-mono text-xs text-slate-500">
          {symbol} · {interval} · 365d
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Strategy</span>
          <select
            className="select-dark"
            value={kind}
            onChange={(e) => changeKind(e.target.value as FormSpecKind)}
          >
            {(Object.keys(SPEC_FORMS) as FormSpecKind[]).map((k) => (
              <option key={k} value={k}>
                {SPEC_FORMS[k].label}
              </option>
            ))}
          </select>
        </label>

        {form.fields.map((f) => (
          <label key={f.name} className="flex w-28 flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-slate-500">{f.label}</span>
            <input
              type="number"
              step={f.step}
              className="input-dark font-mono"
              value={params[f.name] ?? 0}
              onChange={(e) =>
                setParams((prev) => ({ ...prev, [f.name]: Number(e.target.value) }))
              }
            />
          </label>
        ))}

        <button className="btn-neon" onClick={run} disabled={running}>
          {running ? 'Running…' : '运行回测'}
        </button>
      </div>

      {/* 成本模型折叠区 */}
      <div className="mb-3 rounded-xl border border-white/5 bg-white/[0.02]">
        <button
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-slate-400 transition hover:text-neon-cyan"
          onClick={() => setCostOpen((o) => !o)}
        >
          <span className="font-mono text-[10px]">{costOpen ? '▼' : '▶'}</span>
          成本模型
          <span className="ml-auto font-mono text-[10px] font-normal text-slate-500">
            {COST_PRESETS[costPreset].label}
          </span>
        </button>

        {costOpen && (
          <div className="flex flex-wrap items-end gap-3 border-t border-white/5 px-3 py-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">预设</span>
              <select
                className="select-dark"
                value={costPreset}
                onChange={(e) => setCostPreset(e.target.value as CostPresetKey)}
              >
                {(Object.keys(COST_PRESETS) as CostPresetKey[]).map((k) => (
                  <option key={k} value={k}>
                    {COST_PRESETS[k].label}
                  </option>
                ))}
              </select>
            </label>

            {costPreset === 'custom' &&
              COST_FIELDS.map((f) => (
                <label key={f.name} className="flex w-28 flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">
                    {f.label}
                  </span>
                  <input
                    type="number"
                    step={f.step}
                    min={0}
                    className="input-dark font-mono"
                    value={customCost[f.name]}
                    onChange={(e) =>
                      setCustomCost((prev) => ({ ...prev, [f.name]: Number(e.target.value) }))
                    }
                  />
                </label>
              ))}

            {costPreset !== 'custom' && (
              <p className="self-center font-mono text-[11px] text-slate-500">
                {effectiveCost
                  ? `fee ${(effectiveCost.fee_rate * 100).toFixed(4)}% · slip ${(
                      effectiveCost.slippage * 100
                    ).toFixed(3)}% · min $${effectiveCost.min_fee_usd} · 本金 $${effectiveCost.capital_usd.toLocaleString('en-US')}`
                  : '不传 cost，由后端按资产类别选择默认成本。'}
              </p>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="mb-2 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {error}
        </p>
      )}

      {result && m && (
        <>
          {usedCost && (
            <p className="mb-2 font-mono text-[10px] text-slate-500">
              {costNote(usedCost.preset, usedCost.cost)}
            </p>
          )}
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Metric label="Sharpe" value={fmtNum(m.sharpe)} tone={signTone(m.sharpe)} />
            <Metric label="Annual Return" value={fmtPct(m.annual_return)} tone={signTone(m.annual_return)} />
            <Metric label="Max Drawdown" value={fmtPct(m.max_drawdown)} tone="neg" />
            <Metric label="Calmar" value={fmtNum(m.calmar)} tone={signTone(m.calmar)} />
            <Metric label="Win Rate" value={fmtPct(m.win_rate, 1)} tone={m.win_rate >= 0.5 ? 'pos' : 'neg'} />
            <Metric label="Total Return" value={fmtPct(m.total_return)} tone={signTone(m.total_return)} />
            <Metric label="Annual Vol" value={fmtPct(m.annual_vol)} tone="neutral" />
            <Metric label="Sortino" value={fmtNum(m.sortino)} tone={signTone(m.sortino)} />
            <Metric label="Trades" value={String(m.num_trades)} tone="neutral" />
            <Metric
              label="DSR Prob"
              value={fmtPct(m.deflated_sharpe_prob, 1)}
              tone={m.deflated_sharpe_prob >= 0.5 ? 'pos' : 'neg'}
            />
          </div>
          <div ref={chartDivRef} className="h-56 w-full" />
        </>
      )}

      {!result && !error && (
        <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          Configure a strategy and hit 运行回测 to see the equity curve.
        </div>
      )}
    </section>
  )
}
