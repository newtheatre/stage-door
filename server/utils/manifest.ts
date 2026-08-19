/**
 * The document an app serves at /api/_hooks/auth/manifest, and the rules for
 * turning it into role definitions. Reasoning: ADR-0018.
 */

import { z } from 'zod/v4'
import { defaultExpirySchema, namespaceSchema, roleNameSchema, permissionKeySchema, eligibilityKeySchema } from './validation'

/** Refuse anything larger before parsing: a manifest is a few kilobytes. */
export const MANIFEST_MAX_BYTES = 64 * 1024

export const manifestSchema = z.object({
  contract: z.literal(1),
  namespace: namespaceSchema,
  // Free text, echoed in the admin UI. Never parsed, never ordered.
  version: z.string().min(1).max(64),
  permissions: z.array(z.object({
    key: permissionKeySchema,
    description: z.string().min(1).max(200),
  })).max(200).default([]),
  roles: z.array(z.object({
    role: roleNameSchema,
    description: z.string().min(1).max(500),
    defaultExpiry: defaultExpirySchema.default({ kind: 'committee-year' }),
    permissions: z.array(permissionKeySchema).max(200).default([]),
    // The app names the rule; this service decides whether it bites (ADR-0019).
    requiresEligibility: z.object({
      key: eligibilityKeySchema,
      suggestedMode: z.enum(['advisory', 'enforcing']).default('advisory'),
    }).nullable().default(null),
  })).max(100),
  eligibilityRules: z.array(z.object({
    key: eligibilityKeySchema,
    name: z.string().min(1).max(120),
  })).max(100).default([]),
}).superRefine((manifest, ctx) => {
  const declared = new Set(manifest.permissions.map(p => p.key))
  if (declared.size !== manifest.permissions.length) {
    ctx.addIssue({ code: 'custom', path: ['permissions'], message: 'Duplicate permission key' })
  }

  const roles = new Set(manifest.roles.map(r => r.role))
  if (roles.size !== manifest.roles.length) {
    ctx.addIssue({ code: 'custom', path: ['roles'], message: 'Duplicate role' })
  }

  // A role granting a permission the same manifest does not declare is the
  // typo ADR-0014 exists to catch, one level down.
  for (const [i, role] of manifest.roles.entries()) {
    for (const key of role.permissions) {
      if (!declared.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['roles', i, 'permissions'], message: `Undeclared permission ${key}` })
      }
    }
  }
})

export type Manifest = z.infer<typeof manifestSchema>

/** SHA-256 of the raw body, so an unchanged document skips reconciliation. */
export async function manifestHash(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
