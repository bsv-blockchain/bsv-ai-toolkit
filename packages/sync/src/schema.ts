import { z } from 'zod'

const isRealDate = (s: string): boolean => {
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s)
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').refine(isRealDate, 'must be a real date')

export const VerifiedDate = isoDate

const nonEmpty = z.string().min(1)

export const GuardrailSchema = z
  .object({
    id: z.string().regex(/^G-\d{2}$/, 'must be G-xx'),
    title: nonEmpty,
    shape: z.enum(['A', 'B', 'both']),
    rule: nonEmpty,
    why: nonEmpty,
    detect: z.enum(['static', 'manual', 'contract']),
    severity: z.enum(['error', 'warn']),
    refs: z.array(z.string().regex(/^(docs:[a-z0-9.-]+|brc:\d+|fact:[a-z0-9-]+)$/, 'must be docs:<id>, brc:<n> or fact:<name>')),
  })
  .strict()

export const GuardrailsFile = z.array(GuardrailSchema)

export const VersionsFile = z
  .object({
    verified: isoDate,
    packages: z.record(
      z.object({ pinned: nonEmpty, verified: isoDate, note: z.string().optional() }).strict(),
    ),
    git: z.record(
      z
        .object({
          repo: nonEmpty,
          branch: nonEmpty,
          commit: nonEmpty,
          version: nonEmpty,
          verified: isoDate,
          npmVersion: z.string().optional(),
          npmUnsafe: z.boolean().optional(),
        })
        .strict(),
    ),
    services: z.record(
      z
        .object({
          version: nonEmpty,
          verified: isoDate,
          hosts: z.record(z.array(z.string().url())),
          probeTxid: z.string(),
        })
        .strict(),
    ),
    runtime: z.record(nonEmpty),
  })
  .strict()

export const DocsIndexFile = z
  .object({
    hosts: z.array(z.string().url().endsWith('/')).min(1),
    ids: z.record(
      z.object({ path: nonEmpty, title: nonEmpty, legacy: z.string().url().optional() }).strict(),
    ),
  })
  .strict()

export const BrcCategoriesFile = z
  .object({
    verified: isoDate,
    categories: z.array(nonEmpty).min(1),
    index: z.record(z.string().regex(/^\d{4}$/, 'BRC number must be four digits'), nonEmpty),
  })
  .strict()
  .superRefine((file, ctx) => {
    for (const [brc, category] of Object.entries(file.index)) {
      if (!file.categories.includes(category)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['index', brc], message: `unknown category "${category}"` })
      }
    }
  })

export type Guardrail = z.infer<typeof GuardrailSchema>
export type Versions = z.infer<typeof VersionsFile>
export type DocsIndex = z.infer<typeof DocsIndexFile>
export type BrcCategories = z.infer<typeof BrcCategoriesFile>
