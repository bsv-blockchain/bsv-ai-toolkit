import type { TipRow } from '../api'
import type { CollectInfo, CollectState } from '../collect'

/** The first and last characters of a txid or key. */
export const short = (hex: string) => (hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex)

/**
 * The relay's verdict in words: Arcade saw it with no competitor ("seen on network"), Arcade refused it
 * ("failed"), or not yet ("pending"). A verdict never means the creator has the money.
 */
export function verdictLabel(verdict: string): 'seen on network' | 'failed' | 'pending' {
  return verdict === 'seen-no-competitor' ? 'seen on network' : verdict === 'terminal' ? 'failed' : 'pending'
}

/** "received" only once the creator's wallet internalized the tip (here, or reported to the relay, signed). */
export function tipBadge(tip: TipRow, collect?: CollectState): string {
  if (collect === 'accepted' || tip.internalizedAt !== undefined) return 'received'
  if (collect === 'failed') return 'failed'
  return verdictLabel(tip.verdict)
}

/**
 * The amount: what this wallet received, else the output amount the relay validated for the candidates (they can
 * differ only when someone posted the transaction with a claim on another output).
 */
export function tipAmount(tip: TipRow, collect?: CollectInfo): string {
  if (collect?.satoshis !== undefined) return String(collect.satoshis)
  return [...new Set(tip.remittances.map(r => r.satoshis))].join(' / ')
}

function collectText(info: CollectInfo | undefined): string {
  switch (info?.state) {
    case 'collecting':
      return 'collecting…'
    case 'not-for-me':
      return 'not for this wallet'
    case 'gave-up':
      return `not collected yet${info.error ? `: ${info.error}` : ''}. It is tried again when the relay next sees it on the network, or reload the page.`
    case 'failed':
      return info.error ?? ''
    default:
      return ''
  }
}

export function TipList({ tips, collect = {} }: { tips: TipRow[]; collect?: Record<string, CollectInfo> }) {
  if (tips.length === 0) return <p>No tips yet.</p>
  return (
    <table className="tips">
      <thead>
        <tr>
          <th>Transaction</th>
          <th>Sats</th>
          <th>Arcade status</th>
          <th>Tip</th>
        </tr>
      </thead>
      <tbody>
        {tips.map(tip => {
          const info = collect[tip.txid]
          const badge = tipBadge(tip, info?.state)
          const text = collectText(info)
          return (
            <tr key={tip.txid}>
              <td>
                <code title={tip.txid}>{short(tip.txid)}</code>
              </td>
              <td>{tipAmount(tip, info)}</td>
              <td>{tip.txStatus}</td>
              <td>
                <span className={`badge badge-${badge.replaceAll(' ', '-')}`}>{badge}</span>
                {text && <small> {text}</small>}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
