import { useEffect, useState, type FormEvent } from 'react'
import { relayApi, type RelayApi } from '../api'
import { short, verdictLabel } from '../components/TipList'
import type { AppConfig, Network } from '../config'
import { forgetWithConsent, MIN_TIP_SATS, postPending, refusedForGood, resumableTips, sendTip, stuckTips, tipDetails, type PendingTip, type TipOutcome } from '../tip'
import { login, networkMismatch, type Session } from '../wallet'

const EXPLORER: Record<Network, string> = { testnet: 'https://test.whatsonchain.com', mainnet: 'https://whatsonchain.com' }

/** A link for people to look at the transaction; the app itself reads status from Arcade only. */
export const explorerTxUrl = (network: Network, txid: string) => `${EXPLORER[network]}/tx/${txid}`

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Puts a saved record's details on the clipboard (true); where the page may not write it (no secure context,
 * permission refused) the details are shown in a prompt to copy by hand (false).
 */
async function copyDetails(record: PendingTip): Promise<boolean> {
  const details = tipDetails(record)
  if (details === undefined) return false
  try {
    await navigator.clipboard.writeText(details)
    return true
  } catch {
    window.prompt('Copy these tip details and keep them', details)
    return false
  }
}

/** Saved tip records that cannot be re-posted; [] when this browser has no localStorage. */
function readStuck(network: Network): PendingTip[] {
  try {
    return stuckTips(network)
  } catch {
    return []
  }
}

export interface UnfinishedProps {
  records: PendingTip[]
  network: Network
  /** Asks, then deletes the record. */
  onForget: (record: PendingTip) => void
  /** Puts the record's details (tipDetails) on the clipboard. */
  onCopy: (record: PendingTip) => void
  /** The key of the record whose details were just copied. */
  copiedKey?: string
}

/** Tips the wallet may have sent that never reached the relay: shown with what is known, never hidden. */
export function Unfinished({ records, network, onForget, onCopy, copiedKey }: UnfinishedProps) {
  if (records.length === 0) return null
  return (
    <section aria-label="unfinished tips">
      <h3>Unfinished tips</h3>
      <p>
        These tips did not reach the relay, so the creator cannot collect them from here. If your wallet shows one of
        them as sent, keep this record, or copy its details first: it holds what the creator needs to collect it.
      </p>
      <ul>
        {records.map(r => (
          <li key={r.key}>
            {r.satoshis} sats, started {new Date(r.createdAt).toLocaleString()}
            {r.txid && (
              <>
                , transaction <a href={explorerTxUrl(network, r.txid)} target="_blank" rel="noreferrer"><code>{r.txid}</code></a>
              </>
            )}
            :{' '}
            {refusedForGood(r)
              ? 'the relay cannot take this tip: its transaction is larger than the relay accepts, and trying again will not change that. Use Copy details and send them to the creator, who can collect it with their wallet.'
              : (r.lastError ?? 'the page closed before the wallet answered')}{' '}
            {tipDetails(r) !== undefined && (
              <>
                <button type="button" onClick={() => onCopy(r)}>
                  Copy details
                </button>{' '}
              </>
            )}
            <button type="button" onClick={() => onForget(r)}>
              Forget
            </button>
            {copiedKey === r.key && ' copied'}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Outcome({ outcome, network }: { outcome: TipOutcome; network: Network }) {
  const link = <a href={explorerTxUrl(network, outcome.txid)} target="_blank" rel="noreferrer">view on WhatsOnChain</a>
  if (!outcome.posted && outcome.permanent) {
    return (
      <p role="alert">
        Your wallet sent tip <code>{outcome.txid}</code>, but the relay cannot take it ({outcome.error}). Its details are
        listed under Unfinished tips below. ({link})
      </p>
    )
  }
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
      {outcome.walletError && <> Your wallet reported a problem sending it ({outcome.walletError}); the relay took it to Arcade itself.</>}
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
  const [stuck, setStuck] = useState(() => readStuck(config.network))
  const [copiedKey, setCopiedKey] = useState<string>()

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
      for (const pending of resumableTips(config.network)) {
        const out = await postPending(pending, relay)
        if (live) setOutcomes(o => [out, ...o.filter(x => x.txid !== out.txid)])
      }
      if (live) setStuck(readStuck(config.network))
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
      setStuck(readStuck(config.network))
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
      <Unfinished
        records={stuck}
        network={config.network}
        copiedKey={copiedKey}
        onCopy={record => void copyDetails(record).then(ok => setCopiedKey(ok ? record.key : undefined))}
        onForget={record => {
          if (forgetWithConsent(record, question => window.confirm(question))) setStuck(readStuck(config.network))
        }}
      />
    </section>
  )
}
