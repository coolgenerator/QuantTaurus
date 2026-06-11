import { useCallback, useEffect, useState } from 'react'
import { fetchChampions, fmtNum, type ChampionRecord, type ChampionRegistryMap } from '../api'
import { useWsMessages } from '../ws'

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

function SlotCard({ record }: { record: ChampionRecord }) {
  const [expanded, setExpanded] = useState(false)
  const latest = record.lineage.length > 0 ? record.lineage[record.lineage.length - 1] : null
  const sharpe = latest?.holdout_sharpe
  const promotedMs = latest?.promoted_ms ?? record.updated_ms

  return (
    <div
      className="cursor-pointer rounded-xl border border-white/10 bg-black/20 p-3 transition hover:border-neon-cyan/40 hover:bg-white/5"
      onClick={() => setExpanded((v) => !v)}
      title={expanded ? '收起 spec' : '展开 spec'}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-bold text-slate-200">
          {record.symbol}
          {record.interval !== '1d' && (
            <>
              <span className="text-slate-600"> · </span>
              <span className="text-slate-400">{record.interval}</span>
            </>
          )}
        </span>
        {record.spec ? (
          <span className="badge border border-neon-purple/40 bg-neon-purple/10 font-mono text-neon-purple">
            {record.spec.kind}
          </span>
        ) : (
          <span className="badge border border-white/15 bg-white/5 text-slate-500">空缺</span>
        )}
        <span className="badge ml-auto border border-white/10 bg-white/5 font-mono text-slate-400">
          {record.lineage.length} 代
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-xs">
        <span className="text-slate-500">晋升 {relTime(promotedMs)}</span>
        <span className="ml-auto text-slate-500">
          holdout sharpe{' '}
          <span
            className={`font-bold ${
              sharpe === undefined ? 'text-slate-500' : sharpe >= 0 ? 'text-neon-green' : 'text-neon-red'
            }`}
          >
            {sharpe === undefined ? '—' : fmtNum(sharpe)}
          </span>
        </span>
      </div>

      {expanded && (
        <pre
          className="mt-2 max-h-48 overflow-auto rounded-lg border border-neon-purple/20 bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed text-neon-cyan"
          onClick={(e) => e.stopPropagation()}
        >
          {JSON.stringify(record.spec, null, 2)}
        </pre>
      )}
      <p className="mt-1.5 text-[10px] text-slate-600">
        {expanded ? '▲ 点击收起' : '▼ 点击展开 spec'}
      </p>
    </div>
  )
}

export default function ChampionRegistry() {
  const [champions, setChampions] = useState<ChampionRegistryMap>({})
  const [error, setError] = useState<string | null>(null)

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

  // A finished evolution run may have promoted a new champion — resync.
  useWsMessages((msg) => {
    if (msg.channel === 'evolve_done') void load()
  })

  const keys = Object.keys(champions).sort()

  return (
    <section className="glass-card flex flex-col p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="panel-title">Champion Registry</h2>
        <span className="badge border border-white/15 bg-white/5 font-mono text-slate-400">
          {keys.length} 槽位
        </span>
      </div>

      {error && (
        <p className="mb-2 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {error}
        </p>
      )}

      {keys.length === 0 && !error && (
        <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
          暂无冠军槽位——启动进化后将自动注册
        </div>
      )}

      {keys.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {keys.map((k) => (
            <SlotCard key={k} record={champions[k]} />
          ))}
        </div>
      )}
    </section>
  )
}
