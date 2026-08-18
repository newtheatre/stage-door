import { z } from 'zod/v4'

/**
 * Reusable Zod password schema — same policy as Proscenium's:
 * minimum 8 characters, at least one lowercase, one uppercase, one digit.
 */
export const passwordSchema = z.string()
  .min(8, 'Password must be at least 8 characters long')
  .refine(val => /[a-z]/.test(val), { message: 'Password must contain at least one lowercase letter' })
  .refine(val => /[A-Z]/.test(val), { message: 'Password must contain at least one uppercase letter' })
  .refine(val => /\d/.test(val), { message: 'Password must contain at least one number' })

/** Email, lowercased on the way in — always (docs/data-model.md). */
export const emailSchema = z.email('Please enter a valid email address')
  .transform(val => val.toLowerCase())

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
 * An app's hook and manifest origin. HTTPS only in production; localhost over
 * http is what makes the estate testable on ports 3000-3003.
 */
export const baseUrlSchema = z.url().max(200).refine(
  value => value.startsWith('https://') || /^http:\/\/localhost(:\d+)?/.test(value),
  { message: 'Base URL must be https, or http://localhost for development' },
).refine(value => !value.endsWith('/'), { message: 'Base URL must not end with a slash' })

/** Role half of a scoped role. */
export const roleNameSchema = z.string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Role names are uppercase, e.g. BOX_OFFICE')

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
 * Addresses that can never receive mail. They must never be registrable or
 * claimable — claiming needs no email round-trip.
 */
export function isUndeliverableEmail(email: string): boolean {
  return /\.invalid$|\.test$|\.example$|\.localhost$|@example\.(com|org|net)$/.test(email)
}
