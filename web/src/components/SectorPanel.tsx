import { useCallback, useEffect, useState } from 'react'
import {
  fetchSectors,
  fmtNum,
  type SectorLabel,
  type SectorReport,
  type SectorStat,
  type TickerStat,
} from '../api'
import { useI18n } from '../i18n'

interface Props {
  onSelectSymbol: (symbol: string) => void
}

/** Convert a log return to a simple return for display (e.g. 0.0953 → 10%). */
const logToSimple = (v: number | null | undefined): number | null =>
  v === null || v === undefined || Number.isNaN(v) ? null : Math.expm1(v)

function fmtSignedPct(v: number | null, digits = 1): string {
  if (v === null || Number.isNaN(v)) return '—'
  const pct = v * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`
}

const LABEL_STYLES: Record<SectorLabel, { textKey: string; cls: string }> = {
  leader: {
    textKey: 'sector.leader',
    cls: 'border border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan',
  },
  emerging: {
    // 潜在下一热点信号——脉冲发光、最醒目
    textKey: 'sector.emerging',
    cls: 'border border-neon-purple/60 bg-neon-purple/15 text-neon-purple animate-glow-purple',
  },
  neutral: {
    textKey: 'sector.neutral',
    cls: 'border border-white/15 bg-white/5 text-slate-400',
  },
  laggard: {
    textKey: 'sector.laggard',
    cls: 'border border-red-900/70 bg-red-950/40 text-red-400/90',
  },
}

/**
 * Chip background by 3m simple-return strength:
 * deep red (-50%) → gray (0%) → deep green (+100%).
 */
function momChipColor(r: number | null): string {
  const gray: [number, number, number] = [55, 65, 81] // slate-700
  if (r === null) return 'rgba(55,65,81,0.45)'
  const lerp = (a: [number, number, number], b: [number, number, number], t: number) =>
    `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * t)).join(',')})`
  if (r < 0) {
    const deepRed: [number, number, number] = [153, 27, 27] // red-800
    return lerp(gray, deepRed, Math.min(-r / 0.5, 1))
  }
  const deepGreen: [number, number, number] = [21, 128, 61] // green-700
  return lerp(gray, deepGreen, Math.min(r / 1.0, 1))
}

/** Horizontal diverging bar for hotspot_score (≈ -6..+6), zero at center. */
function HotspotBar({ score }: { score: number }) {
  const MAX = 6
  const frac = Math.min(Math.abs(score) / MAX, 1) * 50 // percent of half-width
  const positive = score >= 0
  return (
    <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-white/5">
      {/* center line */}
      <div className="absolute left-1/2 top-0 h-full w-px bg-white/20" />
      <div
        className="absolute top-0 h-full rounded-full"
        style={
          positive
            ? {
                left: '50%',
                width: `${frac}%`,
                background: 'linear-gradient(to right, rgba(34,211,238,0.35), #22d3ee)',
                boxShadow: '0 0 8px rgba(34,211,238,0.45)',
              }
            : {
                right: '50%',
                width: `${frac}%`,
                background: 'linear-gradient(to left, rgba(251,113,133,0.35), #fb7185)',
                boxShadow: '0 0 8px rgba(251,113,133,0.35)',
              }
        }
      />
    </div>
  )
}

function MiniStat({
  label,
  value,
  positive,
}: {
  label: string
  value: string
  positive: boolean | null
}) {
  return (
    <div className="min-w-[64px]">
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      <p
        className={`font-mono text-xs font-bold ${
          positive === null ? 'text-slate-500' : positive ? 'text-neon-green' : 'text-neon-red'
        }`}
      >
        {value}
      </p>
    </div>
  )
}

function TickerChip({
  stat,
  onSelect,
  t,
}: {
  stat: TickerStat
  onSelect: (symbol: string) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const r = logToSimple(stat.mom_3m)
  return (
    <button
      onClick={() => onSelect(stat.symbol)}
      title={`${stat.symbol} · ${t('sector.close')} ${fmtNum(stat.last_close)} · 1m ${fmtSignedPct(
        logToSimple(stat.mom_1m),
      )} · 6m ${fmtSignedPct(logToSimple(stat.mom_6m))} · ${t('sector.vol20d')} ${fmtNum(stat.vol_20d, 3)}`}
      className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition hover:scale-[1.04] hover:brightness-125 ${
        stat.above_ma50 ? 'border border-neon-green/50' : 'border border-transparent'
      }`}
      style={{ backgroundColor: momChipColor(r) }}
    >
      <span className="font-mono text-xs font-bold text-slate-100">{stat.symbol}</span>
      <span className="font-mono text-[11px] text-slate-200/90">{fmtSignedPct(r)}</span>
    </button>
  )
}

function SectorRow({
  sector,
  expanded,
  onToggle,
  onSelectSymbol,
  t,
}: {
  sector: SectorStat
  expanded: boolean
  onToggle: () => void
  onSelectSymbol: (symbol: string) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const label = LABEL_STYLES[sector.label] ?? LABEL_STYLES.neutral
  return (
    <div
      className={`rounded-xl border bg-black/20 transition hover:bg-white/5 ${
        sector.label === 'emerging'
          ? 'border-neon-purple/40'
          : sector.label === 'leader'
            ? 'border-neon-cyan/30'
            : 'border-white/10 hover:border-white/20'
      }`}
    >
      <div
        className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5"
        onClick={onToggle}
        title={expanded ? t('sector.collapse') : t('sector.expand')}
      >
        {/* 排名 + 名称 + 标签 */}
        <div className="flex w-44 shrink-0 items-center gap-3">
          <span className="w-8 text-right font-mono text-2xl font-extrabold leading-none text-slate-300">
            {sector.rank}
          </span>
          <div>
            <p className="text-sm font-bold text-slate-200">{sector.name_zh}</p>
            <span className={`badge mt-0.5 ${label.cls}`}>{t(label.textKey)}</span>
          </div>
        </div>

        {/* hotspot 条形 */}
        <div className="min-w-[140px] flex-1">
          <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] text-slate-500">
            <span>HOTSPOT</span>
            <span
              className={`text-xs font-bold ${
                sector.hotspot_score >= 0 ? 'text-neon-cyan' : 'text-neon-red'
              }`}
            >
              {sector.hotspot_score >= 0 ? '+' : ''}
              {fmtNum(sector.hotspot_score)}
            </span>
          </div>
          <HotspotBar score={sector.hotspot_score} />
        </div>

        {/* 三个小指标 */}
        <div className="flex items-center gap-4">
          <MiniStat
            label="rel 3m"
            value={fmtSignedPct(logToSimple(sector.rel_3m))}
            positive={sector.rel_3m >= 0}
          />
          <MiniStat
            label="accel"
            value={fmtSignedPct(sector.accel)}
            positive={sector.accel >= 0}
          />
          <div className="min-w-[64px]">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">breadth</p>
            <p
              className={`font-mono text-xs font-bold ${
                sector.breadth >= 0.5 ? 'text-neon-green' : 'text-neon-red'
              }`}
            >
              {(sector.breadth * 100).toFixed(0)}%
            </p>
            <div className="mt-0.5 h-1 w-16 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(Math.max(sector.breadth, 0), 1) * 100}%`,
                  background:
                    sector.breadth >= 0.5
                      ? 'linear-gradient(to right, rgba(52,211,153,0.5), #34d399)'
                      : 'linear-gradient(to right, rgba(251,113,133,0.5), #fb7185)',
                }}
              />
            </div>
          </div>
        </div>

        <span className="ml-auto font-mono text-[10px] text-slate-600">
          {expanded ? '▲' : '▼'} {t('sector.tickers', { n: sector.tickers.length })}
        </span>
      </div>

      {/* 成分股热力格 */}
      {expanded && (
        <div className="grid grid-cols-2 gap-1.5 border-t border-white/5 p-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {sector.tickers.map((ticker) => (
            <TickerChip key={ticker.symbol} stat={ticker} onSelect={onSelectSymbol} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function SectorPanel({ onSelectSymbol }: Props) {
  const { lang, t } = useI18n()
  const [report, setReport] = useState<SectorReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setReport(await fetchSectors())
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

  // 服务端有 10 分钟缓存：挂载拉一次 + 手动刷新即可。
  useEffect(() => {
    void load()
  }, [load])

  const sectors = report ? [...report.sectors].sort((a, b) => a.rank - b.rank) : []
  const leader = sectors.find((s) => s.label === 'leader') ?? sectors[0]
  const emerging = sectors.find((s) => s.label === 'emerging')
  const spy3m = report ? logToSimple(report.benchmark.mom_3m) : null

  return (
    <section className="glass-card flex flex-col p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="panel-title">
          {t('sector.title')} <span className="text-slate-500">· {t('sector.subtitle')}</span>
        </h2>
        {report && (
          <span className="badge border border-white/10 bg-white/5 font-mono text-slate-500">
            as of {new Date(report.as_of).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })}
          </span>
        )}
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

      {!report && !error && <p className="text-xs text-slate-500">loading sectors…</p>}

      {report && (
        <>
          {/* 顶部摘要条 */}
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-white/10 bg-gradient-to-r from-cyan-500/10 via-transparent to-violet-500/10 px-4 py-2.5 text-sm">
            <span className="text-slate-400">
              {t('sector.currentLeader')}{' '}
              <span className="font-bold text-neon-cyan">{leader ? leader.name_zh : '—'}</span>
            </span>
            <span className="hidden text-slate-700 sm:inline">·</span>
            {emerging ? (
              <span className="text-slate-400">
                {t('sector.nextHotspot')}{' '}
                <span className="font-bold text-neon-purple drop-shadow-[0_0_8px_rgba(167,139,250,0.7)]">
                  {emerging.name_zh}
                </span>
              </span>
            ) : (
              <span className="text-slate-500">{t('sector.noRotation')}</span>
            )}
            <span className="hidden text-slate-700 sm:inline">·</span>
            <span className="text-slate-400">
              {t('sector.benchmark')}{' '}
              <span
                className={`font-mono font-bold ${
                  (spy3m ?? 0) >= 0 ? 'text-neon-green' : 'text-neon-red'
                }`}
              >
                {fmtSignedPct(spy3m)}
              </span>
            </span>
          </div>

          {/* 热点排行榜 */}
          <div className="flex flex-col gap-2">
            {sectors.map((s) => (
              <SectorRow
                key={s.key}
                sector={s}
                expanded={expandedKey === s.key}
                onToggle={() => setExpandedKey((k) => (k === s.key ? null : s.key))}
                onSelectSymbol={onSelectSymbol}
                t={t}
              />
            ))}
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            {report.method_note} — {t('sector.methodSuffix')}
          </p>
        </>
      )}
    </section>
  )
}
