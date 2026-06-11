// ---------- Types ----------

export interface Kline {
  open_time: number // ms
  open: number
  high: number
  low: number
  close: number
  volume: number
  taker_buy_volume: number
  trades: number
}

export interface FactorSeries {
  times: number[]
  momentum: (number | null)[]
  rsi: (number | null)[]
  realized_vol: (number | null)[]
  bollinger_z: (number | null)[]
  macd_hist: (number | null)[]
  flow_imbalance: (number | null)[]
  volume_price_corr: (number | null)[]
}

export type StrategySpec =
  | { kind: 'tsmom'; lookback: number; deadband: number }
  | { kind: 'vol_managed_momentum'; lookback: number; vol_window: number; vol_target: number }
  | { kind: 'bollinger_reversion'; window: number; entry_z: number; exit_z: number }
  | {
      kind: 'multi_factor'
      mom_lookback: number
      flow_window: number
      vol_window: number
      w_mom: number
      w_flow: number
      w_vol: number
    }
  | { kind: 'rule_vote'; rule_mask: number; min_votes: number; hold_bars: number }
  | { kind: 'ensemble'; members: StrategySpec[] }

export type SpecKind = StrategySpec['kind']

export interface BacktestMetrics {
  total_return: number
  annual_return: number
  annual_vol: number
  sharpe: number
  sortino: number
  max_drawdown: number
  calmar: number
  win_rate: number
  num_trades: number
  deflated_sharpe_prob: number
  /** Bar-level directional hit rate, 0-1 (fraction of holding bars that made money). */
  hit_rate: number
  /** Gross profit / gross loss; >1 = profitable edge. */
  profit_factor: number
}

export interface EquityPoint {
  time: number
  equity: number
  position: number
  price: number
}

export interface BacktestResult {
  metrics: BacktestMetrics
  equity: EquityPoint[]
}

/** Optional transaction-cost model for backtests. Omit to use asset-class defaults. */
export interface CostModel {
  fee_rate: number
  slippage: number
  min_fee_usd: number
  capital_usd: number
}

export interface PopulationMember {
  spec: StrategySpec
  valid_metrics: BacktestMetrics
  generation: number
  parent: string | null
}

export interface EvolveReport {
  champion: {
    spec: StrategySpec
    valid_metrics: BacktestMetrics
    holdout_metrics: BacktestMetrics
    fold_sharpes?: number[]
  }
  promoted: boolean
  fitness_curve: number[]
  final_population: PopulationMember[]
  total_evaluations: number
}

export interface EvolveStatus {
  status: 'idle' | 'running' | 'done' | 'failed'
  report?: EvolveReport
}

export interface ChampionLineageEntry {
  spec: StrategySpec
  holdout_sharpe: number
  promoted_ms: number
}

export interface ChampionRecord {
  spec: StrategySpec | null
  symbol: string
  interval: string
  updated_ms: number
  lineage: ChampionLineageEntry[]
}

/** Slot key ("SPY|1d") → champion record. */
export type ChampionRegistryMap = Record<string, ChampionRecord>

export interface PaperTrade {
  time: number // ms
  price: number
  from_position: number
  to_position: number
  cost: number
}

export interface PaperSession {
  symbol: string
  interval: string
  spec: StrategySpec
  started_ms: number
  equity: number
  position: number
  last_price: number
  last_bar_open: number
  /** 当前方向的建仓时刻（ms）；0/缺失表示无仓位。 */
  entry_ms: number
  /** 槽位名义资金（USD，例如 10000）。 */
  alloc_usd: number
  /** 等效持股数（带符号）= 仓位比例 × 名义资金 × 净值 ÷ 现价。 */
  shares_equiv: number
  /** 当前持仓名义金额（USD）。 */
  notional_usd: number
  curve: EquityPoint[]
  trades: PaperTrade[]
}

export interface PaperStatus {
  active: boolean
  /** Session key ("SPY|1d") → paper session. */
  sessions: Record<string, PaperSession>
}

// ---------- Technical analysis (/api/ta) ----------

export interface TaSignal {
  time: number // ms
  side: 'buy' | 'sell'
  rules: string[]
  /** Number of rules hit on the same bar; >=2 = confluence (strong). */
  strength: number
  price: number
}

export interface TaResponse {
  times: number[]
  ma20: (number | null)[]
  ma50: (number | null)[]
  ma200: (number | null)[]
  ema12: (number | null)[]
  ema26: (number | null)[]
  boll_up: (number | null)[]
  boll_mid: (number | null)[]
  boll_dn: (number | null)[]
  macd_dif: (number | null)[]
  macd_dea: (number | null)[]
  macd_hist: (number | null)[]
  rsi14: (number | null)[]
  kdj_k: (number | null)[]
  kdj_d: (number | null)[]
  kdj_j: (number | null)[]
  /** SuperTrend(10,3): bull-leg rail / bear-leg rail (mutually exclusive per bar). */
  st_up: (number | null)[]
  st_dn: (number | null)[]
  /** ADX(14) trend strength; >25 = strong trend. */
  adx: (number | null)[]
  /** Per-bar trend: 1 bull / -1 bear / 0 range (or MA200 warming up). */
  trend: number[]
  /** Textbook-rule signals — NOT validated by the backtest gate; reference only. */
  classic_signals: TaSignal[]
  /** Gate-validated champion strategy entry/exit points. */
  champion_signals: TaSignal[]
  /** Champion slot key (e.g. "SPY|1d"); null when the symbol has no champion. */
  champion: string | null
}

/** Defaults to 730 days so MA200 has enough warm-up bars. */
export function fetchTa(symbol: string, interval: string, days = 730): Promise<TaResponse> {
  return getJson(`/api/ta?symbol=${symbol}&interval=${interval}&days=${days}`)
}

/** Historical per-rule statistics over the 50+ stock universe (signed forward returns). */
export interface TaRuleStat {
  rule: string
  side: 'buy' | 'sell'
  n: number
  /** P(signed 10-day return > 0). */
  win10: number
  /** Mean / median signed 10-day return (fraction, 0.01 = 1%). */
  avg10: number
  med10: number
  /** Best holding day on the mean curve (1..=20). */
  best_day: number
  /** Mean of per-event peak-return day — expected take-profit timing. */
  exp_tp_day: number
  /** Mean signed return for day 1..=20. */
  curve: number[]
  /** Histogram counts of signed 10d returns (bins from bin_edges). */
  hist: number[]
}

/** Distribution summary of signed 10-day returns for one bucket of events. */
export interface DistStat {
  n: number
  win10: number
  avg10: number
  med10: number
  hist: number[]
}

/** Per (rule, symbol) stats — no mean curve, histogram only. */
export interface SymbolRuleStat {
  symbol: string
  rule: string
  side: 'buy' | 'sell'
  n: number
  win10: number
  avg10: number
  exp_tp_day: number
  hist: number[]
}

export interface SymbolTotal {
  symbol: string
  buy: DistStat
  sell: DistStat
}

export interface TaStatsResponse {
  computed_ms: number
  symbols: number
  events: number
  interval: string
  window_days: number
  horizon: number
  headline: number
  bin_edges: number[]
  /** Universe-wide distribution by signal direction. */
  total_buy: DistStat
  total_sell: DistStat
  rules: TaRuleStat[]
  symbol_totals: SymbolTotal[]
  /** Rule×symbol rows with n >= 8. */
  symbol_rules: SymbolRuleStat[]
}

/** Per-interval stats; first call per interval computes over the full universe (~10s), cached 6h. */
export function fetchTaStats(interval = '1d'): Promise<TaStatsResponse> {
  return getJson(`/api/ta/stats?interval=${interval}`)
}

/** Single-symbol rule stats (any symbol incl. crypto, any interval). */
export interface SymbolStatsResponse {
  symbol: string
  interval: string
  window_days: number
  n_bars: number
  bin_edges: number[]
  total_buy: DistStat
  total_sell: DistStat
  rules: TaRuleStat[]
}

export function fetchSymbolTaStats(symbol: string, interval: string): Promise<SymbolStatsResponse> {
  return getJson(`/api/ta/stats?interval=${interval}&symbol=${symbol}`)
}

/** 槽位键显示名："AAPL|1d" → "AAPL"；非默认周期保留紧凑后缀 "BTCUSDT|1h" → "BTCUSDT·1h"。 */
export function slotLabel(key: string): string {
  const [sym, iv] = key.split('|')
  return !iv || iv === '1d' ? sym : `${sym}·${iv}`
}

// ---------- Trade plans ----------

export interface TradePlan {
  /** Slot key, e.g. "NVDA|1d". */
  key: string
  symbol: string
  interval: string
  strategy: string
  /** Target position in [-1, 1]; sign = direction, |value| = conviction. */
  target_position: number
  last_close: number
  /** Price at which the signal flips direction; null = no flip within ±40%. */
  flip_price: number | null
  /** Flip price distance from last close, in percent (e.g. -10.7). */
  flip_pct: number | null
  /** Timestamp (ms) of the next signal recomputation. */
  next_decision_ms: number
  holdout_sharpe: number | null
  /** Full decision-cadence text, e.g. "日线 · 每日收盘决策一次，盘中不动作". */
  decision_interval_label: string
  /** Signal confidence in [0, 100]. */
  confidence: number
  confidence_label: '高' | '中' | '低'
  /** Human-readable decision rationale. */
  rationale: string
  /** Statistical target zone (±1σ·√N days); null when unavailable. */
  target_zone_low: number | null
  target_zone_high: number | null
  /** Horizon used for the target zone, in days. */
  horizon_days: number
  /** Daily volatility (fraction, e.g. 0.0252 = 2.52%). */
  vol_daily: number
}

export function fetchTradePlans(): Promise<TradePlan[]> {
  return getJson('/api/plan')
}

// ---------- Portfolio (combined daily position planning) ----------

export interface PortfolioSlot {
  /** Slot key, e.g. "NVDA|1d". */
  key: string
  symbol: string
  /** Raw signal position within the slot's own 1/N capital sleeve, [-1, 1]. */
  raw_position: number
  /** Raw portfolio weight (raw_position / N). */
  raw_weight: number
  /** Final planned portfolio weight after risk scaling. */
  adjusted_weight: number
  /** Daily volatility of the slot's asset (fraction). */
  vol_daily: number
}

export interface PortfolioReport {
  slots: PortfolioSlot[]
  /** Gross leverage before/after risk scaling (sum of |weights|). */
  gross_raw: number
  gross_adjusted: number
  /** Net exposure after risk scaling (signed sum of weights). */
  net_adjusted: number
  /** Risk scaling factor applied to raw weights; 1 = no scaling triggered. */
  scale: number
  /** Estimated annualized portfolio vol before/after scaling (fraction). */
  est_vol_annual_raw: number
  est_vol_annual_adjusted: number
  /** Risk limits. */
  gross_cap: number
  vol_target_annual: number
  /** Pairwise correlation assumed when aggregating slot vols. */
  assumed_correlation: number
  note: string
}

export function fetchPortfolio(): Promise<PortfolioReport> {
  return getJson('/api/portfolio')
}

// ---------- Symbol search ----------

export interface SearchHit {
  symbol: string
  name: string
  exchange: string
  quote_type: 'EQUITY' | 'ETF' | 'INDEX'
}

/** Yahoo symbol search; backend returns [] when q is shorter than 2 chars. */
export function searchSymbols(q: string): Promise<SearchHit[]> {
  return getJson(`/api/search?q=${encodeURIComponent(q)}`)
}

// ---------- Sector rotation ----------

export interface TickerStat {
  symbol: string
  last_close: number
  mom_1m: number | null
  mom_3m: number | null
  mom_6m: number | null
  above_ma50: boolean | null
  vol_20d: number | null
}

export type SectorLabel = 'leader' | 'emerging' | 'neutral' | 'laggard'

export interface SectorStat {
  key: string
  name_zh: string
  rank: number
  label: SectorLabel
  /** z-score composite, roughly -6..+6. */
  hotspot_score: number
  avg_mom_1m: number
  avg_mom_3m: number
  avg_mom_6m: number
  /** Excess 3m momentum vs SPY. */
  rel_3m: number
  /** Fraction of constituents above their 50d MA, 0..1. */
  breadth: number
  /** Momentum acceleration (annualized). */
  accel: number
  tickers: TickerStat[]
}

export interface SectorReport {
  as_of: number // ms
  benchmark: TickerStat // SPY
  method_note: string
  sectors: SectorStat[]
}

// ---------- Options chain (moomoo OpenD sidecar, /opt-api) ----------

export interface OptionRow {
  code: string
  type: 'call' | 'put'
  strike: number
  last: number | null
  volume: number | null
  open_interest: number | null
  /** Implied vol, already in percent units (23.6 = 23.6%). */
  iv: number | null
  delta: number | null
  gamma: number | null
  theta: number | null
  vega: number | null
}

export interface OptionChainAnalysis {
  pcr_volume: number | null
  pcr_oi: number | null
  max_pain: number | null
  atm_iv_call: number | null
  atm_iv_put: number | null
  skew_25d: number | null
  total_oi_call: number | null
  total_oi_put: number | null
}

export interface OptionChain {
  symbol: string
  expiry: string
  spot: number
  rows: OptionRow[]
  analysis: OptionChainAnalysis | null
}

export interface ExpirationsResponse {
  symbol: string
  expirations: string[]
}

export function fetchOptionExpirations(symbol: string): Promise<ExpirationsResponse> {
  return getJson(`/opt-api/expirations?symbol=${encodeURIComponent(symbol)}`)
}

export function fetchOptionChain(symbol: string, expiry: string): Promise<OptionChain> {
  return getJson(
    `/opt-api/chain?symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(expiry)}`,
  )
}

// ---------- Option trade plans (derived from stock champion signals) ----------

export type OptionAction = 'BUY CALL' | 'BUY PUT'

export interface OptionPlan {
  underlying: string
  action: OptionAction
  code: string
  strike: number
  /** Expiry date, e.g. "2026-07-02". */
  expiry: string
  /** Days to expiration. */
  dte: number
  /** Premium per share; one contract = ×100. */
  premium: number
  /** Suggested contracts; 0 = a single contract exceeds the budget. */
  qty_suggested: number
  /** Implied vol, in percent units. */
  iv: number | null
  delta: number | null
  theta: number | null
  open_interest: number | null
  spot: number
  entry_rule: string
  exit_rules: string[]
  rationale: string
  /** Confidence of the underlying stock signal, [0, 100]. */
  stock_confidence: number
  stock_target: number
}

export interface OptionPlansResponse {
  as_of: number
  plans: OptionPlan[]
}

export function fetchOptionPlans(): Promise<OptionPlansResponse> {
  return getJson('/opt-api/plans')
}

// ---------- Options paper trading ----------

/** Backend-computed dynamic exit parameters for an open option position. */
export interface OptionExitDynamic {
  /** Take-profit premium (per share). */
  tp_premium: number
  /** Stop-loss premium (per share). */
  sl_premium: number
  /** Effective stop-loss percent, signed (e.g. -50). */
  sl_pct_effective: number
  /** True when the stop width was adapted to entry IV. */
  iv_adaptive: boolean
  /** Underlying price that flips the stock signal; null = no flip within ±40%. */
  underlying_flip_price: number | null
  underlying_last: number | null
  /** Planned exit timestamp (ms); min(signal holding window, hard close). */
  planned_exit_ms: number
  /** Forced-close timestamp (ms), e.g. DTE floor before expiry. */
  hard_close_ms: number
  /** Human-readable summary of the exit rules for this position. */
  rules_note: string
}

export interface OptionPaperPosition {
  code: string
  qty: number
  action: OptionAction
  entry_premium: number
  mark: number
  cost_basis: number
  entry_ms: number
  expiry: string
  strike: number
  rationale: string
  /** IV at entry (percent units); missing on legacy positions. */
  iv_at_entry?: number
  /** Delta at entry; missing on legacy positions. */
  delta_at_entry?: number
  /** Dynamic exit parameters; missing on legacy positions (fall back to frontend defaults). */
  exit_dynamic?: OptionExitDynamic
}

export interface OptionPaperTrade {
  time: number // ms
  side: 'BUY' | 'SELL'
  code: string
  qty: number
  premium: number
  reason: string
  /** Realized PnL; null on BUY. */
  pnl: number | null
}

export interface OptionsPaperStatus {
  cash: number
  equity: number
  updated_ms: number
  /** Underlying symbol → open position. */
  positions: Record<string, OptionPaperPosition>
  trades: OptionPaperTrade[]
}

export function fetchOptionsPaper(): Promise<OptionsPaperStatus> {
  return getJson('/opt-api/paper-options')
}

// ---------- moomoo simulate account (live data via OpenD) ----------

export interface MoomooFunds {
  total_assets: number | null
  cash: number | null
  market_val: number | null
  power: number | null
}

/** Parsed option contract fields; null for plain stock positions. */
export interface MoomooOptionInfo {
  underlying: string
  expiry: string
  opt_type: 'C' | 'P'
  strike: number
}

export interface MoomooPosition {
  code: string
  symbol: string
  name: string
  is_option: boolean
  opt: MoomooOptionInfo | null
  /** Signed quantity (negative = short). */
  qty: number
  can_sell_qty: number | null
  avg_cost: number | null
  last: number | null
  prev_close: number | null
  market_val: number
  pl_val: number | null
  /** P/L over cost basis, as a fraction (0.05 = +5%). */
  pl_pct: number | null
  /** Approximated locally — simulate env has no official today_pl_val. */
  today_pl: number | null
  /** |market_val| / Σ|market_val|, as a fraction. */
  pct_of_positions: number
}

export interface MoomooAccount {
  funds: MoomooFunds
  positions: MoomooPosition[]
  updated_ms: number
}

export interface MoomooOrder {
  order_id: string
  side: 'BUY' | 'SELL'
  status: string
  qty: number | null
  dealt_qty: number
  dealt_avg_price: number | null
  price: number | null
  create_time: string
  updated_time: string
}

export interface MoomooOrdersResponse {
  code: string
  orders: MoomooOrder[]
}

export function fetchMoomooAccount(): Promise<MoomooAccount> {
  return getJson('/opt-api/account')
}

export function fetchMoomooOrders(code: string): Promise<MoomooOrdersResponse> {
  return getJson(`/opt-api/account/orders?code=${encodeURIComponent(code)}`)
}

// ---------- Factor Lab (genetic factor mining) ----------

/** Mining run configuration; omit a field to use the backend default. */
export interface MineConfig {
  population?: number
  generations?: number
  max_depth?: number
  /** Forward-return horizon in days (5 / 10 / 21). */
  horizon?: number
  folds?: number
  holdout_frac?: number
  stability_lambda?: number
  complexity_lambda?: number
  redundancy_lambda?: number
  top_k?: number
  seed?: number
  holdout_ic_floor?: number
}

export interface MineStartResponse {
  started: boolean
  universe: unknown
  dates: unknown
}

/** A factor discovered in the current mining run (report view). */
export interface MineReportFactor {
  expression: string
  fitness: number
  fold_ics: number[]
  mean_ic: number
  icir: number
  holdout_ic: number
  passed_holdout: boolean
  complexity: number
}

export interface MineReport {
  factors: MineReportFactor[]
  /** Best fitness per generation (evolution curve). */
  generations_best: number[]
  total_evaluated: number
  /** [start_ms, end_ms] of the search window. */
  search_dates: [number, number]
  /** [start_ms, end_ms] of the holdout window. */
  holdout_dates: [number, number]
}

export interface MineStatus {
  status: 'idle' | 'running' | 'done' | 'failed'
  started_ms?: number
  error?: string
  report?: MineReport
}

/** A factor persisted in the library (passed holdout validation). */
export interface MinedFactor {
  expression: string
  ast: unknown
  mean_ic: number
  icir: number
  holdout_ic: number
  complexity: number
  horizon: number
  mined_ms: number
}

export interface FactorStrategyConfig {
  rebalance_days?: number
  top_frac?: number
  cost_per_side?: number
}

export interface FactorEquityPoint {
  time: number
  equity: number
}

export interface FactorStrategyResult {
  factors_used: string[]
  metrics_full: BacktestMetrics
  metrics_search: BacktestMetrics
  metrics_holdout: BacktestMetrics
  holdout_start_ms: number
  avg_turnover: number
  names_per_side: number
  equity: FactorEquityPoint[]
  note: string
}

export interface FactorForecast {
  as_of: number
  horizon_days: number
  rankings: { symbol: string; score: number }[]
  confidence: {
    avg_holdout_ic: number
    n_factors: number
    interpretation: string
  }
}

/** Kick off a mining run; backend returns 400 when one is already running. */
export function startMine(body: { days?: number; config?: MineConfig }): Promise<MineStartResponse> {
  return postJson('/api/mine', body)
}

export function fetchMineStatus(): Promise<MineStatus> {
  return getJson('/api/mine/status')
}

export function fetchMinedFactors(): Promise<MinedFactor[]> {
  return getJson('/api/factors_mined')
}

export function runFactorStrategy(body: {
  days?: number
  config?: FactorStrategyConfig
}): Promise<FactorStrategyResult> {
  return postJson('/api/factor_strategy', body)
}

export function fetchFactorForecast(): Promise<FactorForecast> {
  return getJson('/api/factor_forecast')
}

// ---------- Universe Top-K plan (cross-sectional factor-ranked sizing) ----------

/** One sized leg of the universe plan (a long or short candidate). */
export interface UniversePlanLeg {
  symbol: string
  side: 'long' | 'short'
  /** Cross-sectional composite factor score. */
  score: number
  /** Annualized volatility (fraction, e.g. 0.32 = 32%). */
  vol_annual: number
  /** Weight within its own side (longs sum to 1, shorts sum to 1). */
  weight_in_side: number
  /** Planned dollar allocation. */
  dollars: number
  /** Whole shares at last_close; 0 = a single share exceeds the allocation. */
  shares: number
  last_close: number
  /** Suggested option substitute, e.g. "可用 30-45DTE delta≈0.6 CALL 替代". */
  option_hint: string
}

export interface UniversePlan {
  as_of: number // ms
  horizon_days: number
  capital_usd: number
  longs: UniversePlanLeg[]
  shorts: UniversePlanLeg[]
  /** Human-readable sizing methodology, e.g. inverse-vol within side. */
  sizing_rule: string
  confidence: {
    n_factors: number
    avg_holdout_ic: number
    note: string
  }
}

export interface UniversePlanRequest {
  k?: number // default 5
  capital_usd?: number // default 10000
  include_shorts?: boolean // default true
}

/**
 * Build a universe-wide Top-K trade plan from the mined-factor library.
 * Backend returns 400 with a plain-text hint when the factor library is empty,
 * so read the body text for a usable error message instead of statusText.
 */
export async function fetchUniversePlan(body: UniversePlanRequest = {}): Promise<UniversePlan> {
  const res = await fetch('/api/universe_plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = (await res.text()).trim()
    throw new Error(text || `POST /api/universe_plan failed: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<UniversePlan>
}

// ---------- WS message types ----------

export interface WsKlineMsg {
  channel: 'market'
  type: 'kline'
  symbol: string
  interval: string
  kline: Kline
  closed: boolean
}

export interface WsTradeMsg {
  channel: 'market'
  type: 'trade'
  symbol: string
  time: number
  price: number
  qty: number
  is_buyer_maker: boolean
}

export interface WsEvolveDoneMsg {
  channel: 'evolve_done'
  promoted: boolean
  champion_name: string
}

export interface WsPaperMsg {
  channel: 'paper'
  key: string // session key, e.g. "SPY|1d"
  symbol: string
  interval: string
  time: number // ms
  equity: number
  position: number
  price: number
}

export interface WsPaperTradeMsg {
  channel: 'paper_trade'
  key: string // session key, e.g. "SPY|1d"
  symbol: string
  trade: PaperTrade
}

export type WsMessage = WsKlineMsg | WsTradeMsg | WsEvolveDoneMsg | WsPaperMsg | WsPaperTradeMsg

// ---------- Fetch helpers ----------

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${url} failed: ${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export function fetchKlines(symbol: string, interval: string, days = 365): Promise<Kline[]> {
  return getJson(`/api/klines?symbol=${symbol}&interval=${interval}&days=${days}`)
}

export function fetchFactors(
  symbol: string,
  interval: string,
  days = 365,
  period = 14,
): Promise<FactorSeries> {
  return getJson(`/api/factors?symbol=${symbol}&interval=${interval}&days=${days}&period=${period}`)
}

export function runBacktest(
  symbol: string,
  interval: string,
  days: number,
  spec: StrategySpec,
  cost?: CostModel,
): Promise<BacktestResult> {
  return postJson('/api/backtest', { symbol, interval, days, spec, ...(cost ? { cost } : {}) })
}

export function startEvolve(
  symbol: string,
  interval: string,
  days: number,
): Promise<{ started: boolean }> {
  return postJson('/api/evolve', { symbol, interval, days })
}

export function fetchEvolveStatus(): Promise<EvolveStatus> {
  return getJson('/api/evolve/status')
}

export function fetchChampions(): Promise<ChampionRegistryMap> {
  return getJson('/api/champion')
}

export function fetchPaperStatus(): Promise<PaperStatus> {
  return getJson('/api/paper')
}

export function fetchSectors(): Promise<SectorReport> {
  return getJson('/api/sectors')
}

// ---------- Misc utils ----------

/** Normalize a timestamp that may be in ms or seconds to UNIX seconds. */
export function toUnixSec(t: number): number {
  return t > 1e12 ? Math.floor(t / 1000) : Math.floor(t)
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `${(v * 100).toFixed(digits)}%`
}
