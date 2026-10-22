import type { TipRow } from '../api'
import type { CollectState } from '../collect'

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
  return verdictLabel(tip.verdict)
}

const COLLECT_TEXT: Record<CollectState, string> = {
  collecting: 'collecting…',
  accepted: '',
  'not-for-me': 'not for this wallet',
  'gave-up': 'not collected yet: reload to try again',
  failed: '',
}

export function TipList({ tips, collect = {} }: { tips: TipRow[]; collect?: Record<string, CollectState> }) {
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
          const state = collect[tip.txid]
          const badge = tipBadge(tip, state)
          return (
            <tr key={tip.txid}>
              <td>
                <code title={tip.txid}>{short(tip.txid)}</code>
              </td>
              <td>{tip.remittances[0]?.satoshis ?? ''}</td>
              <td>{tip.txStatus}</td>
              <td>
                <span className={`badge badge-${badge.replaceAll(' ', '-')}`}>{badge}</span>
                {state && COLLECT_TEXT[state] && <small> {COLLECT_TEXT[state]}</small>}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
