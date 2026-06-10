import { useState } from 'react'
import TopBar from './components/TopBar'
import PriceChart from './components/PriceChart'
import FactorPanel from './components/FactorPanel'
import BacktestPanel from './components/BacktestPanel'
import EvolvePanel from './components/EvolvePanel'
import PaperPanel from './components/PaperPanel'
import TradeFeed from './components/TradeFeed'

export default function App() {
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [interval, setInterval] = useState('1h')

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-4">
      <TopBar
        symbol={symbol}
        interval={interval}
        onSymbolChange={setSymbol}
        onIntervalChange={setInterval}
      />

      <main className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <PriceChart symbol={symbol} interval={interval} />
        </div>
        <FactorPanel symbol={symbol} interval={interval} />

        <div className="xl:col-span-2">
          <BacktestPanel symbol={symbol} interval={interval} />
        </div>
        <EvolvePanel symbol={symbol} interval={interval} />

        <div className="xl:col-span-3">
          {/* Paper trading follows the champion strategy, not the selected symbol. */}
          <PaperPanel />
        </div>
      </main>

      <TradeFeed symbol={symbol} />

      <footer className="pb-2 text-center text-xs text-slate-600">
        QuantHaHa · for research only · not financial advice
      </footer>
    </div>
  )
}
