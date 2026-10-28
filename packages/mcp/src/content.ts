import { fileURLToPath } from 'node:url'

// The packaged content snapshot. One level up from src/ (vitest) or build/ (runtime) is the package root.
export const CONTENT_DIR = fileURLToPath(new URL('../content', import.meta.url))
