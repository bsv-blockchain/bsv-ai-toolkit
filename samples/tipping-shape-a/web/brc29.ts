import { P2PKH, PublicKey, Random, Utils, type WalletInterface } from '@bsv/sdk'

// BRC-29: a payment goes to a key derived for one recipient from one sender. The sender derives it with the
// recipient as counterparty; the recipient's wallet re-derives it for self from the remittance when it
// internalizes the payment, and refuses an output that does not match.

export const BRC29: [2, string] = [2, '3241645161d8']

/** A fresh remittance derivation: 16 random bytes each, base64. Save it before the payment is broadcast. */
export function newDerivation(): { derivationPrefix: string; derivationSuffix: string } {
  return { derivationPrefix: Utils.toBase64(Random(16)), derivationSuffix: Utils.toBase64(Random(16)) }
}

/** The P2PKH locking script (hex) paying the key `creatorIdentityKey` alone can derive for this derivation. */
export async function payeeLockingScript(
  wallet: WalletInterface,
  creatorIdentityKey: string,
  derivationPrefix: string,
  derivationSuffix: string,
): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: creatorIdentityKey,
  })
  return new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
}
