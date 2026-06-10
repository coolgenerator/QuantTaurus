import { useCallback, useState } from 'react'
import TopBar, { isCrypto } from './components/TopBar'
import PriceChart from './components/PriceChart'
import FactorPanel from './components/FactorPanel'
import BacktestPanel from './components/BacktestPanel'
import EvolvePanel from './components/EvolvePanel'
import ChampionRegistry from './components/ChampionRegistry'
import TradePlanPanel from './components/TradePlanPanel'
import PortfolioPanel from './components/PortfolioPanel'
import SectorPanel from './components/SectorPanel'
import PaperPanel from './components/PaperPanel'
import TradeFeed from './components/TradeFeed'
import OptionsPanel from './components/OptionsPanel'
import OptionPlansPanel from './components/OptionPlansPanel'

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

/** 交易计划页大区标题：霓虹色标题 + 渐变横线分隔。 */
function PlanSectionHeader({
  tone,
  title,
  sub,
}: {
  tone: 'cyan' | 'purple'
  title: string
  sub: string
}) {
  const titleCls =
    tone === 'cyan'
      ? 'text-neon-cyan drop-shadow-[0_0_10px_rgba(34,211,238,0.55)]'
      : 'text-neon-purple drop-shadow-[0_0_10px_rgba(167,139,250,0.55)]'
  const lineCls =
    tone === 'cyan'
      ? 'bg-gradient-to-r from-neon-cyan/70 via-neon-cyan/25 to-transparent shadow-[0_0_8px_rgba(34,211,238,0.45)]'
      : 'bg-gradient-to-r from-neon-purple/70 via-neon-purple/25 to-transparent shadow-[0_0_8px_rgba(167,139,250,0.45)]'
  return (
    <div className="px-1">
      <div className="flex items-baseline gap-2">
        <h2 className={`text-lg font-extrabold tracking-wide ${titleCls}`}>{title}</h2>
        <span className="font-mono text-xs text-slate-500">{sub}</span>
      </div>
      <div className={`mt-1.5 h-[2px] rounded-full ${lineCls}`} />
    </div>
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

      {/* 交易计划页：股票 / 期权两大区，全宽堆叠，同样隐藏而非卸载 */}
      <div className={`flex flex-col gap-8 ${view === 'plans' ? '' : 'hidden'}`}>
        {/* 大区一：股票交易计划 */}
        <section className="flex flex-col gap-4">
          <PlanSectionHeader tone="cyan" title="📈 股票交易计划" sub="Stock Trade Plans" />
          {/* 组合层视角：当日仓位规划 + 组合风控，置于单策略计划之上。 */}
          <PortfolioPanel />
          {/* 今日交易计划：方向/仓位/反转价/倒计时，用户最关心的面板。 */}
          <TradePlanPanel />
          {/* All champion slots across symbol/interval pairs. */}
          <ChampionRegistry />
          {/* Paper trading follows the champion slots, not the selected symbol. */}
          <PaperPanel />
        </section>

        {/* 大区二：期权交易计划（计划卡 + 期权模拟盘） */}
        <section className="flex flex-col gap-4">
          <PlanSectionHeader tone="purple" title="🎯 期权交易计划" sub="Option Trade Plans" />
          <OptionPlansPanel />
        </section>
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
