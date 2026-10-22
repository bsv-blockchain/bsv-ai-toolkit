import type { ShapeDetected } from '../types.js'
import type { ProjectFile } from './walk.js'

const SHAPE_A = /WalletClient\s*\(/
const SHAPE_B = /Setup\.createWallet|ServerWallet|go-wallet-toolbox|StorageKnex|WalletStorageManager/

/** A: a browser wallet (`WalletClient(`) in client code. B: a server-held wallet marker anywhere. */
export function detectShape(files: ProjectFile[]): ShapeDetected {
  const a = files.some(f => f.isClient && SHAPE_A.test(f.text))
  const b = files.some(f => SHAPE_B.test(f.text))
  return a && b ? 'A+B' : a ? 'A' : b ? 'B' : 'unknown'
}
