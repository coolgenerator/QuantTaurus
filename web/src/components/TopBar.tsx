import { useWsStatus } from '../ws'

export const SYMBOL_GROUPS = {
  Crypto: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  'US Stocks': ['SPY', 'QQQ', '^GSPC', '^IXIC', 'AAPL', 'NVDA'],
} as const
export const INTERVALS = ['1h', '4h', '1d'] as const

export const isCrypto = (s: string) => s.endsWith('USDT')
/** 股票数据源 (Yahoo) 不支持 4h */
export const intervalsFor = (s: string) => (isCrypto(s) ? INTERVALS : (['1h', '1d'] as const))

interface Props {
  symbol: string
  interval: string
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
