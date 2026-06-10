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
