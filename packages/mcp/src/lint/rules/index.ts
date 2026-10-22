import type { Finding, ShapeDetected } from '../../types.js'
import type { GuardrailMeta } from '../engine.js'
import type { ProjectFile } from '../walk.js'
import { g01 } from './g01.js'
import { g02 } from './g02.js'
import { g03 } from './g03.js'
import { g04 } from './g04.js'
import { g06 } from './g06.js'

export interface RuleContext { files: ProjectFile[]; shape: ShapeDetected; root: string; meta: GuardrailMeta }
/** Findings use 1-based line numbers; the engine adds `fix` and `ref`. */
export interface RuleResult { findings: Omit<Finding, 'ref' | 'fix'>[]; applicable: boolean }
export interface Rule { id: string; run(ctx: RuleContext): RuleResult }

/** Static guardrail rules, one per `detect: static` guardrail (Tasks 9–10). */
export const rules: Rule[] = [g01, g02, g03, g04, g06]
