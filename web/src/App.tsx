import { useCallback, useState } from 'react'
import TopBar, { isCrypto } from './components/TopBar'
import PriceChart from './components/PriceChart'
import FactorPanel from './components/FactorPanel'
import BacktestPanel from './components/BacktestPanel'
import EvolvePanel from './components/EvolvePanel'
import TradePlanPanel from './components/TradePlanPanel'
import PortfolioPanel from './components/PortfolioPanel'
import SectorPanel from './components/SectorPanel'
import PaperPanel from './components/PaperPanel'
import TradeFeed from './components/TradeFeed'
import OptionsPanel from './components/OptionsPanel'
import { OptionPlansSection, OptionsPaperSection } from './components/OptionPlansPanel'
import HoldingsGuide from './components/HoldingsGuide'
import StrategiesPanel from './components/StrategiesPanel'
import UniversePlanPanel from './components/UniversePlanPanel'
import FactorLabPanel from './components/FactorLabPanel'

type View = 'stocks' | 'plans' | 'positions' | 'strategies' | 'factorlab' | 'options'

const VIEW_TABS: { key: View; label: string; sub: string }[] = [
  { key: 'stocks', label: '股票分析', sub: 'Stocks' },
  { key: 'plans', label: '交易计划', sub: 'Plans' },
  { key: 'positions', label: '持仓', sub: 'Positions' },
  { key: 'strategies', label: '策略', sub: 'Strategies' },
  { key: 'factorlab', label: '因子 Lab', sub: 'Factor Lab' },
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

/** 交易计划页二级子视图。 */
type PlanView = 'champion' | 'universe' | 'options'

const PLAN_TABS: { key: PlanView; label: string; sub: string }[] = [
  { key: 'champion', label: '🏆 冠军计划', sub: 'Champion' },
  { key: 'universe', label: '🌐 全池精选', sub: 'Universe' },
  { key: 'options', label: '🎯 期权计划', sub: 'Options' },
]

/** 计划页二级胶囊导航：sticky 在顶栏下方，选中霓虹青底发光，未选中灰描边。 */
function PlanSubNav({ planView, onChange }: { planView: PlanView; onChange: (v: PlanView) => void }) {
  return (
    <nav className="sticky top-[76px] z-40 flex items-center gap-2 rounded-full border border-white/10 bg-panel/85 px-2 py-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.35)] backdrop-blur-md">
      {PLAN_TABS.map((t) => {
        const active = planView === t.key
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`rounded-full px-4 py-1.5 text-sm font-bold transition ${
              active
                ? 'border border-neon-cyan/60 bg-neon-cyan/15 text-neon-cyan shadow-[0_0_14px_rgba(34,211,238,0.45)] drop-shadow-[0_0_8px_rgba(34,211,238,0.5)]'
                : 'border border-white/10 text-slate-400 hover:border-white/25 hover:bg-white/5 hover:text-slate-200'
            }`}
          >
            {t.label} <span className="text-xs font-medium opacity-70">{t.sub}</span>
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
  // 计划页二级子视图：冠军计划（默认）/ 全池精选 / 期权计划。
  const [planView, setPlanView] = useState<PlanView>('champion')
  // 进过一次期权页后保持挂载，避免切回时丢失已加载的链数据。
  const [optionsMounted, setOptionsMounted] = useState(false)
  // 因子 Lab 同理懒挂载：进入后保持挂载，切走时挖掘轮询/报告状态不丢失。
  const [factorLabMounted, setFactorLabMounted] = useState(false)

  const changeView = useCallback((v: View) => {
    setView(v)
    if (v === 'options') setOptionsMounted(true)
    if (v === 'factorlab') setFactorLabMounted(true)
  }, [])

  // 计划卡「信号策略」联动：跳转到策略 Tab。
  const gotoStrategies = useCallback(() => changeView('strategies'), [changeView])

  // 全局选定标的：顶栏 SymbolPicker / 板块面板点选共用；股票数据源不支持 4h，需回退 1d。
  const handleSelectSymbol = useCallback(
    (s: string) => {
      setSymbol(s)
      if (!isCrypto(s) && interval === '4h') setInterval('1d')
    },
    [interval],
  )

  // 计划页点选标的：联动主图并切回股票分析页。
  const selectSymbolFromPlans = useCallback(
    (s: string) => {
      handleSelectSymbol(s)
      changeView('stocks')
    },
    [handleSelectSymbol, changeView],
  )

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-4">
      <TopBar
        symbol={symbol}
        interval={interval}
        onSymbolChange={handleSelectSymbol}
        onIntervalChange={setInterval}
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

      {/* 交易计划页：二级胶囊导航切换三个子视图，子视图隐藏而非卸载 */}
      <div className={`flex flex-col gap-4 ${view === 'plans' ? '' : 'hidden'}`}>
        <PlanSubNav planView={planView} onChange={setPlanView} />

        {/* 子视图一：冠军计划（组合层仓位规划 + 今日交易计划） */}
        <section className={`flex flex-col gap-4 ${planView === 'champion' ? '' : 'hidden'}`}>
          {/* 组合层视角：当日仓位规划 + 组合风控，置于单策略计划之上。 */}
          <PortfolioPanel />
          {/* 今日交易计划：方向/仓位/反转价/倒计时，用户最关心的面板。 */}
          <TradePlanPanel onNavigateStrategies={gotoStrategies} />
        </section>

        {/* 子视图二：全池精选（因子排名 Top-K 精选计划） */}
        <section className={`flex flex-col gap-4 ${planView === 'universe' ? '' : 'hidden'}`}>
          <UniversePlanPanel onSelectSymbol={selectSymbolFromPlans} />
        </section>

        {/* 子视图三：期权计划（计划卡；模拟盘见「持仓」页） */}
        <section className={`flex flex-col gap-4 ${planView === 'options' ? '' : 'hidden'}`}>
          <OptionPlansSection onNavigateStrategies={gotoStrategies} />
        </section>
      </div>

      {/* 持仓页：退出指引 + 股票模拟盘 + 期权模拟盘，隐藏而非卸载 */}
      <div className={`flex flex-col gap-4 ${view === 'positions' ? '' : 'hidden'}`}>
        {/* 所有持仓的动态退出参数总览，置顶全宽。 */}
        <HoldingsGuide />
        {/* Paper trading follows the champion slots, not the selected symbol. */}
        <PaperPanel />
        {/* 期权模拟盘（从交易计划页迁入）。 */}
        <OptionsPaperSection />
      </div>

      {/* 策略页：冠军策略档案 + 回测验证，隐藏而非卸载 */}
      <div className={view === 'strategies' ? '' : 'hidden'}>
        <StrategiesPanel />
      </div>

      {/* 因子 Lab：遗传规划因子挖掘实验室，懒挂载 + 隐藏不卸载 */}
      {factorLabMounted && (
        <div className={view === 'factorlab' ? '' : 'hidden'}>
          <FactorLabPanel />
        </div>
      )}

      {/* 期权分析全屏页：跟随全局 symbol */}
      {optionsMounted && (
        <div className={view === 'options' ? '' : 'hidden'}>
          <OptionsPanel symbol={symbol} />
        </div>
      )}

      <footer className="pb-2 text-center text-xs text-slate-600">
        QuantHaHa · for research only · not financial advice
      </footer>
    </div>
  )
}
