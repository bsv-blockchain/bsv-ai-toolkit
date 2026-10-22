import { PrivateKey } from '@bsv/sdk'

// Deliberate G-06 violation for the guardrail tests: a key generated and held in client code.
export const sessionKey = PrivateKey.fromRandom()
