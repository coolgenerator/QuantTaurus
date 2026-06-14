import { Fragment, useCallback, useEffect, useState } from 'react'
import {
  fetchMoomooAccount,
  fetchMoomooOrders,
  fmtNum,
  fmtPct,
  type MoomooAccount,
  type MoomooOrder,
  type MoomooPosition,
} from '../api'
import { useI18n } from '../i18n'

const POLL_MS = 30_000

/** 已成交/部分成交状态（其余订单灰显展示）。 */
const FILLED_STATUSES = new Set(['FILLED_ALL', 'FILLED_PART'])

function pnlCls(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'text-slate-500'
  return v >= 0 ? 'text-neon-green' : 'text-neon-red'
}

function signed(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `${v >= 0 ? '+' : ''}${fmtNum(v, digits)}`
}

/** 期权合约的可读名：AAPL 06/20/25 $200 Call */
function positionTitle(p: MoomooPosition): string {
  if (!p.is_option || !p.opt) return p.symbol
  const [y, m, d] = p.opt.expiry.split('-')
  return `${p.opt.underlying} ${m}/${d}/${y.slice(2)} $${p.opt.strike} ${p.opt.opt_type === 'C' ? 'Call' : 'Put'}`
}

function FundCell({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-xl border border-white/5 bg-black/20 p-3">
      <p className="text-[10px] uppercase tracking-widest text-slate-500">{label}</p>
      <p className={`font-mono text-xl font-bold ${cls ?? 'text-slate-200'}`}>{value}</p>
    </div>
  )
}

/** 点击持仓行展开的买卖明细：日期/方向/成交数量/成交价。 */
function OrderHistory({ code }: { code: string }) {
  const { t } = useI18n()
  const [orders, setOrders] = useState<MoomooOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetchMoomooOrders(code)
      .then((r) => alive && setOrders(r.orders))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [code])

  if (error) return <p className="px-3 py-2 text-xs text-neon-red">{error}</p>
  if (!orders) return <p className="px-3 py-2 text-xs text-slate-500">{t('common.loading')}</p>
  if (orders.length === 0)
    return <p className="px-3 py-2 text-xs text-slate-600">{t('moomoo.noOrders')}</p>

  return (
    <ul className="space-y-1 px-2 py-2 font-mono text-xs">
      {orders.map((o) => {
        const filled = FILLED_STATUSES.has(o.status)
        const buy = o.side === 'BUY'
        return (
          <li
            key={o.order_id}
            className={`flex flex-wrap items-center gap-3 rounded-lg border-l-2 px-3 py-1 ${
              !filled
                ? 'border-white/20 bg-white/[0.02] text-slate-600'
                : buy
                  ? 'border-neon-green/70 bg-neon-green/[0.04]'
                  : 'border-neon-red/70 bg-neon-red/[0.04]'
            }`}
          >
            <span className="w-36 text-slate-500">{o.create_time.slice(0, 16)}</span>
            <span
              className={`badge border font-bold ${
                buy
                  ? 'border-neon-green/40 bg-neon-green/10 text-neon-green'
                  : 'border-neon-red/40 bg-neon-red/10 text-neon-red'
              }`}
            >
              {o.side}
            </span>
            <span className="text-slate-300">
              {filled
                ? t('moomoo.sharesFilled', { value: fmtNum(o.dealt_qty, 0) })
                : t('moomoo.orderQty', { value: fmtNum(o.qty, 0) })}
            </span>
            <span className="text-slate-300">
              @ {fmtNum(filled ? o.dealt_avg_price : o.price, 2)}
            </span>
            <span className="ml-auto text-slate-600">{o.status}</span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * moomoo 模拟账户面板：余额条 + 持仓表（P/L、今日盈亏、仓位占比），
 * 点击行展开该标的历史买卖订单。数据来自 OpenD（/opt-api/account）。
 */
export default function MoomooAccountPanel() {
  const { t } = useI18n()
  const [account, setAccount] = useState<MoomooAccount | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setAccount(await fetchMoomooAccount())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(id)
  }, [load])

  const positions = account?.positions ?? []
  const todayTotal = positions.reduce<number | null>(
    (acc, p) => (p.today_pl === null ? acc : (acc ?? 0) + p.today_pl),
    null,
  )
  const plTotal = positions.reduce<number | null>(
    (acc, p) => (p.pl_val === null ? acc : (acc ?? 0) + p.pl_val),
    null,
  )

  return (
    <section className="glass-card flex flex-col p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="panel-title">{t('moomoo.title')}</h2>
        <span className="badge border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan">
          SIMULATE · OpenD
        </span>
        {account && (
          <span className="ml-auto text-[10px] text-slate-600">
            {t('common.updated', { time: new Date(account.updated_ms).toLocaleTimeString('en-GB') })}
          </span>
        )}
      </div>

      {error && (
        <p className="mb-2 rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
          {t('moomoo.connectError', { error })}
        </p>
      )}

      {account && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <FundCell label={t('moomoo.totalAssets')} value={`$${fmtNum(account.funds.total_assets, 0)}`} />
            <FundCell label={t('moomoo.cash')} value={`$${fmtNum(account.funds.cash, 0)}`} />
            <FundCell label={t('moomoo.marketValue')} value={`$${fmtNum(account.funds.market_val, 0)}`} />
            <FundCell label={t('moomoo.buyingPower')} value={`$${fmtNum(account.funds.power, 0)}`} />
            <FundCell label={t('moomoo.totalPL')} value={signed(plTotal, 0)} cls={pnlCls(plTotal)} />
            <FundCell label={t('moomoo.todayPL')} value={signed(todayTotal, 0)} cls={pnlCls(todayTotal)} />
          </div>

          {positions.length === 0 && (
            <p className="py-6 text-center text-xs text-slate-600">{t('moomoo.emptyPositions')}</p>
          )}

          {positions.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse font-mono text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="px-2 py-1.5 text-left">{t('moomoo.symbol')}</th>
                    <th className="px-2 py-1.5 text-right">{t('moomoo.qty')}</th>
                    <th className="px-2 py-1.5 text-right">{t('moomoo.price')}</th>
                    <th className="px-2 py-1.5 text-right">{t('moomoo.marketVal')}</th>
                    <th className="px-2 py-1.5 text-right">{t('moomoo.pl')}</th>
                    <th className="px-2 py-1.5 text-right">{t('moomoo.plPct')}</th>
                    <th className="px-2 py-1.5 text-right" title={t('moomoo.todayPLTitle')}>
                      {t('moomoo.todayPL')}
                    </th>
                    <th className="px-2 py-1.5 text-right">{t('moomoo.positionPct')}</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => {
                    const open = expanded === p.code
                    return (
                      <Fragment key={p.code}>
                        <tr
                          onClick={() => setExpanded(open ? null : p.code)}
                          className={`cursor-pointer border-t border-white/5 transition hover:bg-white/5 ${
                            open ? 'bg-white/5' : ''
                          }`}
                        >
                          <td className="px-2 py-2">
                            <span className="font-bold text-slate-200">{positionTitle(p)}</span>
                            {p.is_option && (
                              <span className="badge ml-1.5 border border-neon-purple/40 bg-neon-purple/10 text-neon-purple">
                                OPT
                              </span>
                            )}
                            {!p.is_option && p.name && (
                              <span className="ml-1.5 text-slate-600">{p.name}</span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right text-slate-300">{fmtNum(p.qty, 0)}</td>
                          <td className="px-2 py-2 text-right text-slate-300">{fmtNum(p.last, 2)}</td>
                          <td className="px-2 py-2 text-right text-slate-300">
                            {fmtNum(p.market_val, 0)}
                          </td>
                          <td className={`px-2 py-2 text-right ${pnlCls(p.pl_val)}`}>
                            {signed(p.pl_val, 0)}
                          </td>
                          <td className={`px-2 py-2 text-right ${pnlCls(p.pl_pct)}`}>
                            {p.pl_pct === null ? '—' : `${p.pl_pct >= 0 ? '+' : ''}${fmtPct(p.pl_pct)}`}
                          </td>
                          <td className={`px-2 py-2 text-right ${pnlCls(p.today_pl)}`}>
                            {signed(p.today_pl, 0)}
                          </td>
                          <td className="px-2 py-2 text-right text-slate-400">
                            {fmtPct(p.pct_of_positions, 1)}
                          </td>
                        </tr>
                        {open && (
                          <tr className="border-t border-white/5 bg-black/20">
                            <td colSpan={8}>
                              <OrderHistory code={p.code} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {!account && !error && (
        <p className="py-6 text-center text-xs text-slate-500">connecting to OpenD…</p>
      )}
    </section>
  )
}
