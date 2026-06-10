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
  curve: EquityPoint[]
  trades: PaperTrade[]
}

export interface PaperStatus {
  active: boolean
  /** Session key ("SPY|1d") → paper session. */
  sessions: Record<string, PaperSession>
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
