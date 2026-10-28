import { ProtoWallet, PublicKey, Utils } from '@bsv/sdk'

// The creator proves it holds its identity key by signing a short message with its wallet; the relay holds no
// key and verifies as 'anyone'. The creator page signs with:
//   wallet.createSignature({ data: utf8(message), protocolID: TIPS_PROTOCOL, keyID: SIGNATURE_KEY_ID, counterparty: 'anyone' })
// Protocol names must match /^[a-z0-9 ]+$/ or @bsv/sdk refuses them (Ruling C10); this one is in the manifest.

export const TIPS_PROTOCOL: [1, string] = [1, 'bsv tipping demo tips']
export const SIGNATURE_KEY_ID = '1'

// Both messages name the deployment's origin (PUBLIC_ORIGIN), so a signature made for one relay is useless on
// another. The claim also carries a nonce from GET /api/config that changes after every successful claim, so a
// claim signature cannot be replayed once the claim is reset.

/** Signed by the identity key that claims the creator page: claim:<origin>:<identityKey>:<nonce>. */
export const claimMessage = (origin: string, identityKey: string, nonce: string) => `claim:${origin}:${identityKey.toLowerCase()}:${nonce}`
/** Signed by the creator after its wallet internalized the tip: internalized:<origin>:<txid>. */
export const internalizedMessage = (origin: string, txid: string) => `internalized:${origin}:${txid.toLowerCase()}`

const anyone = new ProtoWallet('anyone')

/** A 33-byte compressed public key in hex that is a point on the curve (and not an x ≥ p alias of one). */
export function isIdentityKey(hex: unknown): hex is string {
  if (typeof hex !== 'string' || !/^0[23][0-9a-f]{64}$/i.test(hex)) return false
  try {
    const key = PublicKey.fromString(hex)
    return key.validate() && key.toString() === hex.toLowerCase()
  } catch {
    return false
  }
}

/** True when `signatureHex` is `identityKey`'s signature over `message` under TIPS_PROTOCOL, counterparty 'anyone'. */
export async function verifyCreatorSignature(message: string, signatureHex: unknown, identityKey: string): Promise<boolean> {
  // A DER signature is at most 72 bytes.
  if (typeof signatureHex !== 'string' || !/^(?:[0-9a-f]{2}){8,80}$/i.test(signatureHex)) return false
  try {
    const { valid } = await anyone.verifySignature({
      data: Utils.toArray(message, 'utf8'),
      signature: Utils.toArray(signatureHex, 'hex'),
      protocolID: TIPS_PROTOCOL,
      keyID: SIGNATURE_KEY_ID,
      counterparty: identityKey,
    })
    return valid
  } catch {
    return false // the SDK throws on an invalid signature
  }
}
