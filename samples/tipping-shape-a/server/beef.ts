import { Transaction, Utils } from '@bsv/sdk'

// The tipper posts the AtomicBEEF its wallet returned from createAction. Arcade takes EF hex, never BEEF, so the
// relay converts; the creator's wallet internalizes the AtomicBEEF itself.

const HEX = /^(?:[0-9a-f]{2})+$/i

/** Parses an AtomicBEEF hex whose subject tx is `txid`. Throws on anything else. */
function subjectTx(beefHex: string, txid?: string): Transaction {
  if (!HEX.test(beefHex)) throw new Error('beef must be hex')
  if (!/^01010101/i.test(beefHex)) throw new Error('beef must be AtomicBEEF (BRC-95, prefix 01010101)')
  let tx: Transaction
  try {
    tx = Transaction.fromAtomicBEEF(Utils.toArray(beefHex, 'hex'))
  } catch (e) {
    throw new Error(`beef is not a valid AtomicBEEF: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (txid !== undefined && tx.id('hex') !== txid.toLowerCase()) {
    throw new Error(`txid does not match the BEEF's subject transaction (${tx.id('hex')})`)
  }
  return tx
}

/** The subject tx of an AtomicBEEF as EF hex (each input carries its source satoshis and locking script). */
export function efHexFromAtomicBeef(beefHex: string, txid: string): string {
  const tx = subjectTx(beefHex, txid)
  try {
    return tx.toHexEF()
  } catch (e) {
    throw new Error(`beef lacks a source transaction for an input: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** The locking script and satoshis of one output of an AtomicBEEF's subject tx. */
export function outputPaysScript(beefHex: string, outputIndex: number): { lockingScriptHex: string; satoshis: number } {
  const tx = subjectTx(beefHex)
  const out = Number.isInteger(outputIndex) && outputIndex >= 0 ? tx.outputs[outputIndex] : undefined
  if (out === undefined) throw new Error(`outputIndex ${outputIndex} is not an output of the transaction (it has ${tx.outputs.length})`)
  if (typeof out.satoshis !== 'number') throw new Error(`output ${outputIndex} has no satoshis`)
  return { lockingScriptHex: out.lockingScript.toHex(), satoshis: out.satoshis }
}

/**
 * Arcade's rawTx (Extended Format, with placeholder parents) re-read as a plain transaction, hex. The hash must be
 * `txid`. Throws on anything else.
 */
export function plainHexFromArcadeRawTx(rawTx: string, txid: string): string {
  let tx: Transaction
  try {
    tx = Transaction.fromHexEF(rawTx)
  } catch (e) {
    throw new Error(`Arcade's rawTx for ${txid} is not Extended Format: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (tx.id('hex') !== txid.toLowerCase()) throw new Error(`Arcade's rawTx for ${txid} hashes to ${tx.id('hex')}`)
  return tx.toHex()
}
