import { z } from 'zod'

// passwordSchema and emailSchema live in shared/utils/credentials.ts, which
// is auto-imported on both sides, so the forms and handlers cannot drift.

/** Scoped role string format: `app:ROLE` (docs/api-reference.md). */
export const roleSchema = z.string()
  .regex(/^[a-z][a-z0-9-]*:[A-Z][A-Z0-9_]*$/, 'Roles must be scoped strings like proscenium:ADMIN')

/** Namespace half of a scoped role (role-definition rows store the halves). */
export const namespaceSchema = z.string()
  .regex(/^[a-z][a-z0-9-]*$/, 'Namespaces are lowercase, e.g. proscenium')

/**
 * A permission an app declares, e.g. `money.refund`. Lowercase with at least
 * one dot, so no string can satisfy this and `roleSchema` both.
 */
export const permissionKeySchema = z.string()
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, 'Permissions are dotted lowercase, e.g. money.refund')
  .max(80)

/** An eligibility rule key as rehearsal names it, e.g. `duty-manager`. */
export const eligibilityKeySchema = z.string()
  .regex(/^[a-z][a-z0-9-]*$/, 'Eligibility keys are lowercase, e.g. duty-manager')
  .max(64)

/** An app's registered name, and the slug its service token joins on. */
export const appNameSchema = z.string()
  .regex(/^[a-z][a-z0-9-]*$/, 'App names are lowercase, e.g. rehearsal')
  .max(40)

/**
 * An app's hook and manifest origin. The localhost escape hatch is anchored
 * and dev-only: hooks send the app's bearer token to whatever this allows.
 */
export const baseUrlSchema = z.url().max(200).refine(
  value => value.startsWith('https://')
    || (import.meta.dev && /^http:\/\/localhost(:\d+)?(\/|$)/.test(value)),
  { message: 'Base URL must be https, or http://localhost for development' },
).refine(value => !value.endsWith('/'), { message: 'Base URL must not end with a slash' })

/** Role half of a scoped role. */
export const roleNameSchema = z.string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Role names are uppercase, e.g. BOX_OFFICE')

/**
 * A role definition's default expiry. Declared once: the manifest path and
 * both admin endpoints write the same two columns from it.
 */
export const defaultExpirySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('committee-year') }),
  z.object({ kind: z.literal('days'), days: z.number().int().min(1).max(3650) }),
])

/** The two columns `defaultExpirySchema` maps onto. */
export function defaultExpiryColumns(expiry: z.infer<typeof defaultExpirySchema>) {
  return {
    defaultExpiryKind: expiry.kind,
    defaultExpiryDays: expiry.kind === 'days' ? expiry.days : null,
  }
}

/**
 * The diff is applied as one D1 batch, so an uncapped array turns request size
 * into batch size. Generous: nobody holds this many roles.
 */
export const MAX_GRANTS_PER_REQUEST = 100

/**
 * A role grant (ADR-0011): a bare scoped string or an object with expiry and
 * a note. Normalised to the object shape either way.
 */
export const roleGrantSchema = z.union([
  roleSchema.transform(role => ({ role, expiresAt: null as number | null, note: null as string | null })),
  z.object({
    role: roleSchema,
    expiresAt: z.number().int().positive().nullable().default(null), // epoch ms; null = permanent
    note: z.string().max(500).nullable().default(null),
  }),
])

/**
 * Workspace addresses sign in with Google (ADR-0012). Exact-domain match
 * only, so `@dev.newtheatre.org.uk` stays usable for the local seed.
 */
export function isWorkspaceEmail(email: string): boolean {
  return email.toLowerCase().endsWith('@newtheatre.org.uk')
}

/**
 * The ADR-0012 rule, enforced where a password is actually written or a
 * set-password token minted. Login-side checks alone were bypassable.
 */
export function assertPasswordAllowed(email: string): void {
  if (isWorkspaceEmail(email)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'NNT accounts sign in with Google and cannot hold a password.',
      data: { useGoogle: true },
    })
  }
}

/**
 * The one list. SQL and JavaScript both derive from it, so adding a domain
 * cannot half-apply across the admin filters and the registration guards.
 */
export const UNDELIVERABLE_SUFFIXES = [
  '.invalid', '.test', '.example', '.localhost',
  '@example.com', '@example.org', '@example.net',
] as const

/**
 * Addresses that can never receive mail. They must never be registrable or
 * claimable: claiming needs no email round-trip.
 */
export function isUndeliverableEmail(email: string): boolean {
  const lower = email.toLowerCase()
  return UNDELIVERABLE_SUFFIXES.some(suffix => lower.endsWith(suffix))
}
