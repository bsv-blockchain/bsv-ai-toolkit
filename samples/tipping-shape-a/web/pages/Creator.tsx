import { useEffect, useState } from 'react'
import { relayApi, type RelayApi, type TipRow, type TipStatusView } from '../api'
import { claimCreator, Collector, type CollectInfo, type CreatorRole } from '../collect'
import { short, TipList } from '../components/TipList'
import type { AppConfig } from '../config'
import { login, networkMismatch, type Session } from '../wallet'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function upsert(tips: TipRow[], row: TipRow): TipRow[] {
  return tips.some(t => t.txid === row.txid) ? tips.map(t => (t.txid === row.txid ? row : t)) : [row, ...tips]
}

export interface CreatorProps {
  config: AppConfig
  initialSession?: Session
  api?: RelayApi
  connect?: () => Promise<Session>
}

/**
 * The creator's page: connect, claim (or check) the creator identity, then collect every tip automatically as
 * soon as the relay reads it seen-no-competitor, for as long as the page is open.
 */
export function Creator({ config, initialSession, api, connect = login }: CreatorProps) {
  const [relay] = useState(() => api ?? relayApi())
  const [session, setSession] = useState(initialSession)
  const [role, setRole] = useState<CreatorRole>()
  const [error, setError] = useState<string>()
  const [tips, setTips] = useState<TipRow[]>([])
  const [states, setStates] = useState<Record<string, CollectInfo>>({})
  const [claiming, setClaiming] = useState(false)

  const mismatch = session && networkMismatch(session.network, config.network)

  async function claim(s: Session) {
    if (networkMismatch(s.network, config.network) !== undefined) return
    setClaiming(true)
    setError(undefined)
    try {
      setRole(await claimCreator(s.wallet, s.identityKey, relay))
    } catch (e) {
      setError(`Could not claim or check the creator page: ${message(e)}`)
    } finally {
      setClaiming(false)
    }
  }

  async function onConnect() {
    setError(undefined)
    let s: Session
    try {
      s = await connect()
    } catch (e) {
      setError(`Could not connect a wallet: ${message(e)}`)
      return
    }
    setSession(s)
    await claim(s)
  }

  useEffect(() => {
    if (session === undefined || mismatch !== undefined || role?.role !== 'creator') return
    const collector = new Collector({
      wallet: session.wallet,
      identityKey: session.identityKey,
      api: relay,
      deps: { originator: config.originator, network: config.network },
      onChange: (txid, info) => setStates(s => ({ ...s, [txid]: info })),
    })
    let live = true
    const refresh = () =>
      relay.listTips().then(
        rows => {
          if (!live) return
          setTips(rows)
          rows.forEach(row => collector.onTip(row))
        },
        e => live && setError(`Could not list tips: ${message(e)}`),
      )
    // One stream; EventSource reconnects by itself, and every (re)open lists the tips in case events were missed.
    const events = new EventSource('/api/events')
    events.addEventListener('open', () => void refresh().then(() => collector.retryGaveUp()))
    events.addEventListener('tip', e => {
      const row = JSON.parse((e as MessageEvent<string>).data) as TipRow
      setTips(t => upsert(t, row))
      collector.onTip(row)
    })
    events.addEventListener('status', e => {
      const s = JSON.parse((e as MessageEvent<string>).data) as TipStatusView
      setTips(t => t.map(tip => (tip.txid === s.txid ? { ...tip, ...s } : tip)))
      collector.onStatus(s)
    })
    return () => {
      live = false
      events.close()
      collector.stop()
    }
  }, [session, mismatch, role, relay, config.originator, config.network])

  return (
    <section aria-label="creator">
      <h2>Creator</h2>
      {session === undefined ? (
        <button type="button" onClick={onConnect}>
          Connect wallet
        </button>
      ) : (
        <p>
          Wallet <code title={session.identityKey}>{short(session.identityKey)}</code>{' '}
          <span className={`badge badge-${session.network}`}>wallet: {session.network}</span>
        </p>
      )}
      {mismatch && (
        <p role="alert" className="banner">
          {mismatch}. Switch your wallet to {config.network} to collect tips.
        </p>
      )}
      {role?.role === 'not-creator' && (
        <p role="alert">
          This page belongs to creator <code title={role.creatorIdentityKey}>{short(role.creatorIdentityKey)}</code>; tips here are not
          for this wallet.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {session !== undefined && mismatch === undefined && role === undefined && !claiming && (
        <button type="button" onClick={() => void claim(session)}>
          Try again
        </button>
      )}
      {role?.role === 'creator' && (
        <>
          <p>Tips are collected into your wallet automatically while this page is open.</p>
          <TipList tips={tips} collect={states} />
        </>
      )}
    </section>
  )
}
