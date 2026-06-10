import { useCallback, useState } from 'react'
import TopBar, { isCrypto } from './components/TopBar'
import PriceChart from './components/PriceChart'
import FactorPanel from './components/FactorPanel'
import BacktestPanel from './components/BacktestPanel'
import EvolvePanel from './components/EvolvePanel'
import ChampionRegistry from './components/ChampionRegistry'
import TradePlanPanel from './components/TradePlanPanel'
import SectorPanel from './components/SectorPanel'
import PaperPanel from './components/PaperPanel'
import TradeFeed from './components/TradeFeed'
import OptionsPanel from './components/OptionsPanel'

type View = 'stocks' | 'plans' | 'options'

const VIEW_TABS: { key: View; label: string; sub: string }[] = [
  { key: 'stocks', label: '股票分析', sub: 'Stocks' },
  { key: 'plans', label: '交易计划', sub: 'Plans' },
  { key: 'options', label: '期权分析', sub: 'Options' },
]

function ViewTabs({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <nav className="glass-card flex items-center gap-1 px-2 py-1.5">
      {VIEW_TABS.map((t) => {
        const active = view === t.key
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`relative rounded-lg px-4 py-1.5 text-sm font-bold transition ${
              active
                ? 'text-neon-cyan drop-shadow-[0_0_8px_rgba(34,211,238,0.6)]'
                : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            }`}
          >
            {t.label} <span className="text-xs font-medium opacity-70">{t.sub}</span>
            {/* 霓虹下划线 */}
            <span
              className={`absolute inset-x-3 -bottom-[3px] h-[2px] rounded-full bg-gradient-to-r from-neon-cyan to-neon-purple transition-opacity ${
                active ? 'opacity-100 shadow-[0_0_10px_rgba(34,211,238,0.8)]' : 'opacity-0'
              }`}
            />
          </button>
        )
      })}
    </nav>
  )
}

export default function App() {
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [interval, setInterval] = useState('1h')
  const [view, setView] = useState<View>('stocks')
  // 进过一次期权页后保持挂载，避免切回时丢失已加载的链数据。
  const [optionsMounted, setOptionsMounted] = useState(false)

  const changeView = useCallback((v: View) => {
    setView(v)
    if (v === 'options') setOptionsMounted(true)
  }, [])

  // 板块面板点选成分股 → 联动主K线图；股票数据源不支持 4h，需回退 1d。
  const handleSelectSymbol = useCallback(
    (s: string) => {
      setSymbol(s)
      if (!isCrypto(s) && interval === '4h') setInterval('1d')
    },
    [interval],
  )

  // 顶栏搜索选中：切换标的 + 自动跳回「股票分析」页。
  const handleSearchSelect = useCallback(
    (s: string) => {
      handleSelectSymbol(s)
      setView('stocks')
    },
    [handleSelectSymbol],
  )

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-4">
      <TopBar
        symbol={symbol}
        interval={interval}
        onSymbolChange={setSymbol}
        onIntervalChange={setInterval}
        onSearchSelect={handleSearchSelect}
      />

      <ViewTabs view={view} onChange={changeView} />

      {/* 股票分析页：隐藏而非卸载，保留图表与面板状态 */}
      <main
        className={`grid grid-cols-1 gap-4 xl:grid-cols-3 ${view === 'stocks' ? '' : 'hidden'}`}
      >
        <div className="xl:col-span-2">
          <PriceChart symbol={symbol} interval={interval} />
        </div>
        <FactorPanel symbol={symbol} interval={interval} />

        <div className="xl:col-span-2">
          <BacktestPanel symbol={symbol} interval={interval} />
        </div>
        <EvolvePanel symbol={symbol} interval={interval} />

        <div className="xl:col-span-3">
          {/* 板块轮动热点分析，点选成分股联动主图。 */}
          <SectorPanel onSelectSymbol={handleSelectSymbol} />
        </div>
      </main>

      <div className={view === 'stocks' ? '' : 'hidden'}>
        <TradeFeed symbol={symbol} />
      </div>

      {/* 交易计划页：全宽堆叠，同样隐藏而非卸载 */}
      <div className={`flex flex-col gap-4 ${view === 'plans' ? '' : 'hidden'}`}>
        {/* 今日交易计划：方向/仓位/反转价/倒计时，用户最关心的面板。 */}
        <TradePlanPanel />
        {/* All champion slots across symbol/interval pairs. */}
        <ChampionRegistry />
        {/* Paper trading follows the champion slots, not the selected symbol. */}
        <PaperPanel />
      </div>

      {/* 期权分析全屏页 */}
      {optionsMounted && (
        <div className={view === 'options' ? '' : 'hidden'}>
          <OptionsPanel />
        </div>
      )}

      <footer className="pb-2 text-center text-xs text-slate-600">
        QuantHaHa · for research only · not financial advice
      </footer>
    </div>
  )
}
