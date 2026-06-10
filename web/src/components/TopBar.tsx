import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { searchSymbols, type SearchHit } from '../api'
import { useWsStatus } from '../ws'

export const SYMBOL_GROUPS = {
  '指数/ETF': ['SPY', 'QQQ', 'SMH', 'SOXX', '^GSPC', '^IXIC', '^VIX'],
  大型科技: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA'],
  '半导体/芯片': ['NVDA', 'AMD', 'AVGO', 'TSM', 'INTC', 'QCOM', 'ARM', 'MRVL'],
  '内存/存储': ['MU', 'WDC', 'STX', 'SNDK'],
  'AI 基建/算力': ['SMCI', 'DELL', 'VRT', 'ANET', 'ORCL', 'PLTR', 'CRWV'],
  半导体设备: ['ASML', 'AMAT', 'LRCX', 'KLAC', 'TER'],
  'AI 电力': ['VST', 'CEG', 'GEV'],
  Crypto: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
} as const
export const INTERVALS = ['1m', '5m', '30m', '1h', '2h', '4h', '1d', '1w', '1mo'] as const

export const isCrypto = (s: string) => s.endsWith('USDT')
/** 股票数据源 (Yahoo) 不支持 2h/4h；盘中粒度历史有限（1m≈7天、5m/30m≈60天、1h≈2年） */
export const intervalsFor = (s: string) =>
  isCrypto(s) ? INTERVALS : (['1m', '5m', '30m', '1h', '1d', '1w', '1mo'] as const)

const QUOTE_TYPE_STYLE: Record<SearchHit['quote_type'], string> = {
  EQUITY: 'border-cyan-400/40 text-cyan-300',
  ETF: 'border-violet-400/40 text-violet-300',
  INDEX: 'border-amber-400/40 text-amber-300',
}

/**
 * 单一组合框：显示态展示当前 symbol（mono 青色粗体 + ▾）；
 * 聚焦进入编辑态（全选文本）——输入为空/未修改时浮层展示 SYMBOL_GROUPS 分组 chips，
 * 输入 ≥2 字符切换为 /api/search 远程结果（300ms 防抖 + 键盘导航 + 丢弃过期响应）。
 * 选中（点击/回车）调 onSelect；Esc/失焦恢复显示态不改值。
 */
function SymbolPicker({ value, onSelect }: { value: string; onSelect: (symbol: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [q, setQ] = useState('')
  /** 聚焦后用户是否真正修改过输入（聚焦时预填当前 symbol，不算查询） */
  const [dirty, setDirty] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const seqRef = useRef(0)

  const query = q.trim()
  const searchMode = editing && dirty && query.length >= 2

  // 输入防抖 300ms 后请求；丢弃过期响应
  useEffect(() => {
    const seq = ++seqRef.current
    if (!searchMode) {
      setHits([])
      return
    }
    const timer = window.setTimeout(() => {
      searchSymbols(query)
        .then((res) => {
          if (seqRef.current !== seq) return
          setHits(res)
          setActive(0)
        })
        .catch(() => {
          if (seqRef.current !== seq) return
          setHits([])
        })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query, searchMode])

  /** 退出编辑态：恢复显示当前 symbol，不改值。 */
  const close = () => {
    seqRef.current++
    setEditing(false)
    setQ('')
    setDirty(false)
    setHits([])
    inputRef.current?.blur()
  }

  const pick = (symbol: string) => {
    onSelect(symbol)
    close()
  }

  const onFocus = () => {
    setEditing(true)
    setQ(value)
    setDirty(false)
    // 等受控 value 切到编辑态后再全选，便于直接输入覆盖
    window.setTimeout(() => inputRef.current?.select(), 0)
  }

  const onBlur = (e: FocusEvent<HTMLInputElement>) => {
    // 焦点仍在组件内（如点浮层）不收起；浮层 onMouseDown preventDefault 已保住焦点
    if (rootRef.current?.contains(e.relatedTarget as Node)) return
    close()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (searchMode && hits.length > 0) pick(hits[active].symbol)
      // 远程无结果时允许直接回车提交手输代码
      else if (dirty && query.length > 0) pick(query.toUpperCase())
      return
    }
    if (!searchMode || hits.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % hits.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + hits.length) % hits.length)
    }
  }

  const overlayCls =
    'absolute left-0 top-full z-[60] mt-2 rounded-xl border border-white/10 bg-panel/95 shadow-[0_12px_40px_rgba(0,0,0,0.6),0_0_24px_rgba(34,211,238,0.1)] backdrop-blur-md'

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={editing ? q : value}
        onChange={(e) => {
          setQ(e.target.value)
          setDirty(true)
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        placeholder="搜索代码/公司名…"
        className={`input-dark w-[220px] pr-8 font-mono font-bold ${
          editing ? 'text-slate-100' : 'text-neon-cyan'
        }`}
        spellCheck={false}
        autoComplete="off"
      />
      <span
        className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-500 transition-transform ${
          editing ? 'rotate-180' : ''
        }`}
      >
        ▾
      </span>

      {/* 编辑态 + 无有效查询：分组 chips 浮层 */}
      {editing && !searchMode && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          className={`${overlayCls} max-h-96 w-[340px] overflow-y-auto p-3`}
        >
          {Object.entries(SYMBOL_GROUPS).map(([group, syms]) => (
            <div key={group} className="mb-2.5 last:mb-0">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {group}
              </p>
              <div className="flex flex-wrap gap-1">
                {syms.map((s) => (
                  <button
                    key={s}
                    onClick={() => pick(s)}
                    className={`rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold transition ${
                      s === value
                        ? 'border-cyan-400/60 bg-cyan-400/10 text-neon-cyan shadow-[0_0_8px_rgba(34,211,238,0.25)]'
                        : 'border-white/10 text-slate-300 hover:border-cyan-400/40 hover:bg-white/5 hover:text-neon-cyan'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 编辑态 + 输入 ≥2 字符：远程搜索结果浮层 */}
      {searchMode && hits.length > 0 && (
        <ul
          onMouseDown={(e) => e.preventDefault()}
          className={`${overlayCls} max-h-80 w-[300px] overflow-y-auto py-1`}
        >
          {hits.map((h, i) => (
            <li key={h.symbol}>
              <button
                onClick={() => pick(h.symbol)}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left transition ${
                  i === active ? 'bg-cyan-400/10' : ''
                }`}
              >
                <span className="font-mono text-sm font-bold text-neon-cyan">{h.symbol}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-slate-400">{h.name}</span>
                <span className="rounded border border-white/15 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400">
                  {h.exchange}
                </span>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${QUOTE_TYPE_STYLE[h.quote_type] ?? 'border-white/15 text-slate-400'}`}
                >
                  {h.quote_type}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface Props {
  symbol: string
  interval: string
  /** 选中标的（App 层负责 isCrypto 时 4h → 1d 回退）。 */
  onSymbolChange: (s: string) => void
  onIntervalChange: (i: string) => void
}

export default function TopBar({ symbol, interval, onSymbolChange, onIntervalChange }: Props) {
  const status = useWsStatus()
  const intervals = intervalsFor(symbol)

  return (
    <header className="glass-card sticky top-3 z-50 mx-auto flex items-center gap-4 px-5 py-3">
      <h1 className="neon-title text-2xl tracking-tight">
        Quant<span className="opacity-90">HaHa</span>
      </h1>
      <span className="hidden text-xs uppercase tracking-[0.3em] text-slate-500 sm:inline">
        alpha lab
      </span>

      <div className="ml-auto flex items-center gap-3">
        <SymbolPicker value={symbol} onSelect={onSymbolChange} />

        <div className="flex overflow-hidden rounded-lg border border-white/10">
          {intervals.map((iv) => (
            <button
              key={iv}
              onClick={() => onIntervalChange(iv)}
              className={`px-3 py-1.5 text-sm font-semibold transition ${
                interval === iv
                  ? 'bg-gradient-to-r from-cyan-500/30 to-violet-500/30 text-neon-cyan'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
              }`}
            >
              {iv}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              status === 'open'
                ? 'animate-pulse-dot bg-neon-green'
                : status === 'connecting'
                  ? 'animate-pulse bg-amber-400'
                  : 'bg-neon-red'
            }`}
          />
          <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
            {status === 'open' ? 'live' : status}
          </span>
        </div>
      </div>
    </header>
  )
}
