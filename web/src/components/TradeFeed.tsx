import { useState } from 'react'
import { fmtNum, type WsTradeMsg } from '../api'
import { useI18n } from '../i18n'
import { useWsMessages } from '../ws'

const MAX_TRADES = 50

interface TradeRow extends WsTradeMsg {
  id: number
}

let nextId = 0

export default function TradeFeed({ symbol }: { symbol: string }) {
  const { t } = useI18n()
  const [trades, setTrades] = useState<TradeRow[]>([])

  useWsMessages((msg) => {
    if (msg.channel !== 'market' || msg.type !== 'trade') return
    const row: TradeRow = { ...msg, id: nextId++ }
    // Functional update + slice keeps the list capped without re-render races.
    setTrades((prev) => [row, ...prev].slice(0, MAX_TRADES))
  })

  return (
    <section className="glass-card p-4">
      <div className="mb-2 flex items-center gap-3">
        <h2 className="panel-title">{t('feed.title')}</h2>
        <span className="font-mono text-xs text-slate-500">{trades.length} / {MAX_TRADES}</span>
        <span className="text-[10px] text-slate-600">{t('feed.subtitle')}</span>
        <span className="ml-auto flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-500">
          <span className="inline-block h-2 w-2 rounded-full bg-neon-green" /> buy
          <span className="ml-2 inline-block h-2 w-2 rounded-full bg-neon-red" /> sell
        </span>
      </div>
      <div className="h-48 overflow-y-auto pr-1">
        {trades.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-600">
            {t('feed.waiting')}
          </p>
        )}
        <ul className="space-y-1 font-mono text-xs">
          {trades.map((t) => {
            // is_buyer_maker = true means the aggressor sold into the bid.
            const isSell = t.is_buyer_maker
            const dim = t.symbol !== symbol
            return (
              <li
                key={t.id}
                className={`flex items-center gap-3 rounded-lg border-l-2 px-3 py-1 transition ${
                  isSell
                    ? 'border-neon-red/70 bg-neon-red/[0.04]'
                    : 'border-neon-green/70 bg-neon-green/[0.04]'
                } ${dim ? 'opacity-40' : ''}`}
              >
                <span className="w-20 text-slate-500">
                  {new Date(t.time).toLocaleTimeString('en-GB')}
                </span>
                <span className="w-20 text-slate-400">{t.symbol}</span>
                <span className={`w-8 font-bold ${isSell ? 'text-neon-red' : 'text-neon-green'}`}>
                  {isSell ? 'SELL' : 'BUY'}
                </span>
                <span className={`w-28 text-right font-semibold ${isSell ? 'text-neon-red' : 'text-neon-green'}`}>
                  {fmtNum(t.price, t.price >= 1000 ? 2 : 4)}
                </span>
                <span className="flex-1 text-right text-slate-400">{fmtNum(t.qty, 4)}</span>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
