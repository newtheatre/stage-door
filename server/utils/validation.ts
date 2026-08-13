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

/** Role half of a scoped role. */
export const roleNameSchema = z.string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Role names are uppercase, e.g. BOX_OFFICE')

/**
 * A role grant (ADR-0011): a bare scoped string (back-compat — a permanent
 * grant) or an object carrying expiry and a note. Normalised to the object
 * shape either way.
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
 * NNT Workspace addresses sign in with Google, never with a password
 * (ADR-0012). Exact-domain match only: subdomains like
 * `someone@dev.newtheatre.org.uk` are NOT Workspace accounts — which is
 * what keeps the dev seed usable locally.
 */
export function isWorkspaceEmail(email: string): boolean {
  return email.toLowerCase().endsWith('@newtheatre.org.uk')
}

/**
 * Addresses that can never receive mail: RFC 2606 reserved TLDs/domains,
 * plus our own anonymisation convention (`@anonymised.invalid`). The legacy
 * import created thousands of placeholder/anonymised accounts on these —
 * they must never be registrable or claimable, because claiming needs no
 * email round-trip (register seals a session immediately).
 */
export function isUndeliverableEmail(email: string): boolean {
  return /\.invalid$|\.test$|\.example$|\.localhost$|@example\.(com|org|net)$/.test(email)
}
