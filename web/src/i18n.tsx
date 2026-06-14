/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type Lang = 'en' | 'zh'

type Dict = Record<string, string>

const dictionaries: Record<Lang, Dict> = {
  en: {
    'app.tabs.stocks': 'Stocks',
    'app.tabs.tech': 'Technical Analysis',
    'app.tabs.plans': 'Trade Plans',
    'app.tabs.positions': 'Positions',
    'app.tabs.strategies': 'Strategies',
    'app.tabs.factorlab': 'Factor Lab',
    'app.tabs.options': 'Options',
    'app.planTabs.champion': 'Champion Plan',
    'app.planTabs.universe': 'Universe Picks',
    'app.planTabs.options': 'Options Plan',
    'app.footer': 'QuantTaurus · for research only · not financial advice',
    'topbar.tagline': 'alpha lab',
    'topbar.searchPlaceholder': 'Search ticker or company...',
    'topbar.groups.index': 'Indexes / ETFs',
    'topbar.groups.megacap': 'Mega-cap Tech',
    'topbar.groups.semiconductors': 'Semiconductors / Chips',
    'topbar.groups.memory': 'Memory / Storage',
    'topbar.groups.aiInfra': 'AI Infrastructure',
    'topbar.groups.semiEquipment': 'Semiconductor Equipment',
    'topbar.groups.aiPower': 'AI Power',
    'topbar.langLabel': 'Language',
    'chart.market': 'Market',
    'chart.lastPrice': 'Last Price',
    'chart.loading': 'loading candles...',
    'factors.title': 'Alpha Factors',
    'factors.loading': 'loading factors...',
    'evolve.title': 'Strategy Evolution',
    'evolve.start': 'Start Evolution',
    'evolve.running': 'Evolving...',
    'evolve.empty': 'Launch an evolution run to breed a champion strategy.',
    'evolve.progress': 'evolving strategies · natural selection in progress',
    'evolve.fitness': 'fitness curve · {evals} evals',
    'evolve.promoted': 'PROMOTED',
    'evolve.notPromoted': 'not promoted',
    'feed.title': 'Market Feed',
    'feed.subtitle': 'Exchange market stream, not QuantTaurus trades. Rebalances appear in Paper Trading.',
    'feed.waiting': 'waiting for trades on the wire...',
    'backtest.title': 'Backtest Lab',
    'backtest.strategy': 'Strategy',
    'backtest.window': 'Lookback Window',
    'backtest.run': 'Run Backtest',
    'backtest.running': 'Backtesting {seconds}s...',
    'backtest.loading': 'Fetching {days} of klines and simulating. First history download can take 10-30 seconds...',
    'backtest.costModel': 'Cost Model',
    'backtest.preset': 'Preset',
    'backtest.autoCostNote': 'Cost assumption: automatic by asset class',
    'backtest.costNote': 'Cost assumption: {label} · fee {fee}% · slip {slip}% · min ${min} · capital ${capital}',
    'backtest.costSummary': 'fee {fee}% · slip {slip}% · min ${min} · capital ${capital}',
    'backtest.backendDefaultCost': 'No explicit cost is sent; backend uses asset-class defaults.',
    'backtest.empty': 'Configure a strategy and run a backtest to see the equity curve.',
    'cost.auto': 'Auto by asset class',
    'cost.moomoo_us': 'moomoo US Stocks',
    'cost.crypto_taker': 'Crypto Taker',
    'cost.small_scalp': 'Small Scalping Account',
    'cost.custom': 'Custom',
    'time.years': '{n}y',
    'time.days': '{n}d',
  },
  zh: {
    'app.tabs.stocks': '股票分析',
    'app.tabs.tech': '技术分析',
    'app.tabs.plans': '交易计划',
    'app.tabs.positions': '持仓',
    'app.tabs.strategies': '策略',
    'app.tabs.factorlab': '因子实验室',
    'app.tabs.options': '期权分析',
    'app.planTabs.champion': '冠军计划',
    'app.planTabs.universe': '全池精选',
    'app.planTabs.options': '期权计划',
    'app.footer': 'QuantTaurus · 仅供研究使用 · 不构成投资建议',
    'topbar.tagline': 'Alpha 实验室',
    'topbar.searchPlaceholder': '搜索代码或公司名...',
    'topbar.groups.index': '指数 / ETF',
    'topbar.groups.megacap': '大型科技',
    'topbar.groups.semiconductors': '半导体 / 芯片',
    'topbar.groups.memory': '内存 / 存储',
    'topbar.groups.aiInfra': 'AI 基建 / 算力',
    'topbar.groups.semiEquipment': '半导体设备',
    'topbar.groups.aiPower': 'AI 电力',
    'topbar.langLabel': '语言',
    'chart.market': '市场',
    'chart.lastPrice': '最新价格',
    'chart.loading': 'K 线加载中...',
    'factors.title': 'Alpha 因子',
    'factors.loading': '因子加载中...',
    'evolve.title': '策略进化',
    'evolve.start': '启动进化',
    'evolve.running': '进化中...',
    'evolve.empty': '启动一次进化任务，生成冠军策略。',
    'evolve.progress': '策略进化中 · 正在进行自然选择',
    'evolve.fitness': '适应度曲线 · {evals} 次评估',
    'evolve.promoted': '已晋升',
    'evolve.notPromoted': '未晋升',
    'feed.title': '市场成交流',
    'feed.subtitle': '交易所行情直播，不是 QuantTaurus 交易；系统调仓见模拟盘。',
    'feed.waiting': '等待实时成交...',
    'backtest.title': '回测实验室',
    'backtest.strategy': '策略',
    'backtest.window': '回看窗口',
    'backtest.run': '运行回测',
    'backtest.running': '回测中 {seconds}s...',
    'backtest.loading': '正在拉取 {days} K 线并仿真；首次下载历史数据可能需要 10-30 秒...',
    'backtest.costModel': '成本模型',
    'backtest.preset': '预设',
    'backtest.autoCostNote': '成本假设：按资产类别自动选择',
    'backtest.costNote': '成本假设：{label} · 费率 {fee}% · 滑点 {slip}% · 最低 ${min} · 本金 ${capital}',
    'backtest.costSummary': '费率 {fee}% · 滑点 {slip}% · 最低 ${min} · 本金 ${capital}',
    'backtest.backendDefaultCost': '不传入成本参数，由后端按资产类别选择默认成本。',
    'backtest.empty': '配置策略并运行回测后，将显示净值曲线。',
    'cost.auto': '自动（按资产类别）',
    'cost.moomoo_us': 'moomoo 美股',
    'cost.crypto_taker': '加密 taker',
    'cost.small_scalp': '短线小资金',
    'cost.custom': '自定义',
    'time.years': '{n} 年',
    'time.days': '{n} 天',
  },
}

interface I18nContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

function detectInitialLang(): Lang {
  const stored = window.localStorage.getItem('qt.lang')
  if (stored === 'en' || stored === 'zh') return stored
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang)

  const setLang = (next: Lang) => {
    setLangState(next)
    window.localStorage.setItem('qt.lang', next)
  }

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const value = useMemo<I18nContextValue>(() => {
    const t = (key: string, vars?: Record<string, string | number>) => {
      let text = dictionaries[lang][key] ?? dictionaries.en[key] ?? key
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.replaceAll(`{${name}}`, String(value))
        }
      }
      return text
    }
    return { lang, setLang, t }
  }, [lang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider')
  return ctx
}
