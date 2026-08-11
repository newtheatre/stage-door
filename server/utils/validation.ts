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
