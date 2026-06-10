import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
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
export const INTERVALS = ['1h', '4h', '1d'] as const

export const isCrypto = (s: string) => s.endsWith('USDT')
/** 股票数据源 (Yahoo) 不支持 4h */
export const intervalsFor = (s: string) => (isCrypto(s) ? INTERVALS : (['1h', '1d'] as const))

const QUOTE_TYPE_STYLE: Record<SearchHit['quote_type'], string> = {
  EQUITY: 'border-cyan-400/40 text-cyan-300',
  ETF: 'border-violet-400/40 text-violet-300',
  INDEX: 'border-amber-400/40 text-amber-300',
}

/** 防抖搜索框：调 /api/search，浮层下拉选代码（键盘上下+回车，Esc/点外关闭）。 */
function SymbolSearch({ onSelect }: { onSelect: (symbol: string) => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const seqRef = useRef(0)

  // 输入防抖 300ms 后请求；丢弃过期响应
  useEffect(() => {
    const query = q.trim()
    const seq = ++seqRef.current
    if (query.length < 2) {
      setHits([])
      setOpen(false)
      return
    }
    const timer = window.setTimeout(() => {
      searchSymbols(query)
        .then((res) => {
          if (seqRef.current !== seq) return
          setHits(res)
          setActive(0)
          setOpen(true)
        })
        .catch(() => {
          if (seqRef.current !== seq) return
          setHits([])
          setOpen(false)
        })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [q])

  // 点击外部关闭浮层
  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  const pick = (symbol: string) => {
    onSelect(symbol)
    // 选中后清空并收起
    seqRef.current++
    setQ('')
    setHits([])
    setOpen(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (!open || hits.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % hits.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + hits.length) % hits.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(hits[active].symbol)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (hits.length > 0) setOpen(true)
        }}
        placeholder="🔍 搜索代码/公司名…"
        className="input-dark w-[200px]"
        spellCheck={false}
        autoComplete="off"
      />
      {open && hits.length > 0 && (
        <ul className="absolute left-0 top-full z-[60] mt-2 max-h-80 w-[300px] overflow-y-auto rounded-xl border border-white/10 bg-panel/95 py-1 shadow-[0_12px_40px_rgba(0,0,0,0.6),0_0_24px_rgba(34,211,238,0.1)] backdrop-blur-md">
          {hits.map((h, i) => (
            <li key={h.symbol}>
              <button
                onMouseDown={(e) => e.preventDefault()}
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
  onSymbolChange: (s: string) => void
  onIntervalChange: (i: string) => void
  /** 搜索结果选中：App 层会切换 symbol/interval 并跳回「股票分析」tab。 */
  onSearchSelect: (s: string) => void
}

export default function TopBar({
  symbol,
  interval,
  onSymbolChange,
  onIntervalChange,
  onSearchSelect,
}: Props) {
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
        <SymbolSearch onSelect={onSearchSelect} />

        <select
          className="select-dark font-mono"
          value={symbol}
          onChange={(e) => {
            const next = e.target.value
            onSymbolChange(next)
            // 切到股票时 4h 不可用，回退 1d
            if (!isCrypto(next) && interval === '4h') onIntervalChange('1d')
          }}
        >
          {Object.entries(SYMBOL_GROUPS).map(([group, syms]) => (
            <optgroup key={group} label={group}>
              {syms.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

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
