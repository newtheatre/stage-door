import { z } from 'zod/v4'

/**
 * The password policy, shared so the form and the handler cannot disagree.
 * Same rules as Proscenium's: 8+, one lowercase, one uppercase, one digit.
 */
export const passwordSchema = z.string('Password is required')
  .min(8, 'Password must be at least 8 characters long')
  .refine(val => /[a-z]/.test(val), { message: 'Password must contain at least one lowercase letter' })
  .refine(val => /[A-Z]/.test(val), { message: 'Password must contain at least one uppercase letter' })
  .refine(val => /\d/.test(val), { message: 'Password must contain at least one number' })

/** Email, lowercased on the way in: always (docs/data-model.md). */
export const emailSchema = z.email('Please enter a valid email address')
  .transform(val => val.toLowerCase())
