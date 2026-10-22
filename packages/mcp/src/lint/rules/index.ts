import type { Finding, ShapeDetected } from '../../types.js'
import type { GuardrailMeta } from '../engine.js'
import type { ProjectFile } from '../walk.js'

export interface RuleContext { files: ProjectFile[]; shape: ShapeDetected; root: string; meta: GuardrailMeta }
/** Findings use 1-based line numbers; the engine adds `fix` and `ref`. */
export interface RuleResult { findings: Omit<Finding, 'ref' | 'fix'>[]; applicable: boolean }
export interface Rule { id: string; run(ctx: RuleContext): RuleResult }

/** Static guardrail rules, one per `detect: static` guardrail (Tasks 9–10). */
export const rules: Rule[] = []
