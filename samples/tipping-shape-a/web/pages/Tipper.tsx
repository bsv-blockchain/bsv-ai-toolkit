import { useEffect, useState, type FormEvent } from 'react'
import { relayApi, type RelayApi } from '../api'
import { short, verdictLabel } from '../components/TipList'
import type { AppConfig, Network } from '../config'
import { MIN_TIP_SATS, postPending, sendTip, unsentTips, type TipOutcome } from '../tip'
import { login, networkMismatch, type Session } from '../wallet'

const EXPLORER: Record<Network, string> = { testnet: 'https://test.whatsonchain.com', mainnet: 'https://whatsonchain.com' }

/** A link for people to look at the transaction; the app itself reads status from Arcade only. */
export const explorerTxUrl = (network: Network, txid: string) => `${EXPLORER[network]}/tx/${txid}`

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function Outcome({ outcome, network }: { outcome: TipOutcome; network: Network }) {
  const link = <a href={explorerTxUrl(network, outcome.txid)} target="_blank" rel="noreferrer">view on WhatsOnChain</a>
  if (!outcome.posted) {
    return (
      <p role="alert">
        Your wallet sent tip <code>{outcome.txid}</code>, but the relay has not taken it yet ({outcome.error}). The tip
        details are kept in this browser; reopen this page to hand them to the relay again. ({link})
      </p>
    )
  }
  return (
    <p>
      Tip <code title={outcome.txid}>{short(outcome.txid)}</code>: <strong>{verdictLabel(outcome.row.verdict)}</strong>. The creator
      collects it automatically. ({link})
    </p>
  )
}

export interface TipperProps {
  config: AppConfig
  /** A session from an earlier login (tests render with one). */
  initialSession?: Session
  api?: RelayApi
  connect?: () => Promise<Session>
}

export function Tipper({ config, initialSession, api, connect = login }: TipperProps) {
  const [relay] = useState(() => api ?? relayApi())
  const [session, setSession] = useState(initialSession)
  const [error, setError] = useState<string>()
  const [amount, setAmount] = useState('1000')
  const [reviewing, setReviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<TipOutcome[]>([])

  const mismatch = session && networkMismatch(session.network, config.network)
  const creator = config.creatorIdentityKey
  const satoshis = Number(amount)
  const validAmount = /^\d+$/.test(amount) && Number.isSafeInteger(satoshis) && satoshis >= MIN_TIP_SATS
  const disabled = session === undefined || mismatch !== undefined || creator === undefined || busy

  // Tips the wallet broadcast that never reached the relay (a closed tab, a refused POST): hand them over now.
  useEffect(() => {
    if (session === undefined || mismatch !== undefined) return
    let live = true
    void (async () => {
      for (const pending of unsentTips(config.network)) {
        const out = await postPending(pending, relay)
        if (live) setOutcomes(o => [out, ...o.filter(x => x.txid !== out.txid)])
      }
    })()
    return () => {
      live = false
    }
  }, [session, mismatch, config.network, relay])

  async function onConnect() {
    setError(undefined)
    try {
      setSession(await connect())
    } catch (e) {
      setError(`Could not connect a wallet: ${message(e)}. Install and open a BRC-100 wallet (such as BSV Desktop), then try again.`)
    }
  }

  function onReview(e: FormEvent) {
    e.preventDefault()
    setError(undefined)
    if (!validAmount) {
      setError(`A tip is a whole number of sats, at least ${MIN_TIP_SATS}.`)
      return
    }
    setReviewing(true)
  }

  async function onSend() {
    if (session === undefined || creator === undefined) return
    setReviewing(false)
    setBusy(true)
    setError(undefined)
    try {
      const out = await sendTip(session.wallet, config, creator, satoshis, relay)
      setOutcomes(o => [out, ...o])
    } catch (e) {
      setError(`The tip was not sent: ${message(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="tipper">
      <h2>Send a tip</h2>
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
          {mismatch}. Switch your wallet to {config.network} to tip.
        </p>
      )}
      {creator === undefined && <p>No creator has claimed this page yet. Tips open once the creator connects on /creator.</p>}

      <form onSubmit={onReview}>
        <fieldset disabled={disabled}>
          <label>
            Amount (sats){' '}
            <input type="number" min={MIN_TIP_SATS} step={1} inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value)} />
          </label>{' '}
          <button type="submit">Tip</button>
        </fieldset>
      </form>

      {reviewing && !disabled && (
        <div role="dialog" aria-label="tip summary">
          <p>
            Tip <strong>{satoshis} sats</strong> on <strong>{config.network}</strong> to <code>{creator && short(creator)}</code>. Your
            wallet adds a small network fee and may ask you to approve the payment.
          </p>
          <button type="button" onClick={onSend}>
            Send tip
          </button>{' '}
          <button type="button" onClick={() => setReviewing(false)}>
            Cancel
          </button>
        </div>
      )}
      {busy && <p>Sending…</p>}
      {error && <p role="alert">{error}</p>}
      {outcomes.map(o => (
        <Outcome key={o.txid} outcome={o} network={config.network} />
      ))}
    </section>
  )
}
