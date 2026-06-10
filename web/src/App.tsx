import { useCallback, useState } from 'react'
import TopBar, { isCrypto } from './components/TopBar'
import PriceChart from './components/PriceChart'
import FactorPanel from './components/FactorPanel'
import BacktestPanel from './components/BacktestPanel'
import EvolvePanel from './components/EvolvePanel'
import ChampionRegistry from './components/ChampionRegistry'
import SectorPanel from './components/SectorPanel'
import PaperPanel from './components/PaperPanel'
import TradeFeed from './components/TradeFeed'

export default function App() {
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [interval, setInterval] = useState('1h')

  // 板块面板点选成分股 → 联动主K线图；股票数据源不支持 4h，需回退 1d。
  const handleSelectSymbol = useCallback(
    (s: string) => {
      setSymbol(s)
      if (!isCrypto(s) && interval === '4h') setInterval('1d')
    },
    [interval],
  )

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
          {/* All champion slots across symbol/interval pairs. */}
          <ChampionRegistry />
        </div>

        <div className="xl:col-span-3">
          {/* 板块轮动热点分析，点选成分股联动主图。 */}
          <SectorPanel onSelectSymbol={handleSelectSymbol} />
        </div>

        <div className="xl:col-span-3">
          {/* Paper trading follows the champion slots, not the selected symbol. */}
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
