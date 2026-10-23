import type { Finding, ShapeDetected } from '../../types.js'
import type { GuardrailMeta } from '../engine.js'
import type { ProjectFile } from '../walk.js'
import { g01 } from './g01.js'
import { g02 } from './g02.js'
import { g03 } from './g03.js'
import { g04 } from './g04.js'
import { g06 } from './g06.js'
import { g08 } from './g08.js'
import { g09 } from './g09.js'
import { g10 } from './g10.js'
import { g12 } from './g12.js'
import { g14 } from './g14.js'
import { g15 } from './g15.js'
import { g16 } from './g16.js'
import { g21 } from './g21.js'
import { g25 } from './g25.js'
import { g31 } from './g31.js'
import { g34 } from './g34.js'
import { g36 } from './g36.js'

/** `contentDir` is the content folder the engine was given (`guardrails.json`, `versions.json`). */
export interface RuleContext { files: ProjectFile[]; shape: ShapeDetected; root: string; meta: GuardrailMeta; contentDir: string }
/** Findings use 1-based line numbers; the engine adds `fix` and `ref`. */
export interface RuleResult { findings: Omit<Finding, 'ref' | 'fix'>[]; applicable: boolean }
export interface Rule { id: string; run(ctx: RuleContext): RuleResult }

/** Static guardrail rules, one per `detect: static` guardrail. */
export const rules: Rule[] = [g01, g02, g03, g04, g06, g08, g09, g10, g12, g14, g15, g16, g21, g25, g31, g34, g36]
