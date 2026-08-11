/**
 * Google identity resolution — ADR-0005 and docs/architecture.md
 * §identity-continuity.
 *
 * A person is their `users.id`; a linked Google identity is a credential
 * keyed by the stable `google_sub`, never by address. Match precedence:
 * `google_sub` → `pending_google_email` (admin-directed link, consumed) →
 * lowercased email (including shadow accounts — claiming) → create.
 */

import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

export interface GoogleProfile {
  sub: string
  email: string
  email_verified: boolean
  hd?: string
  name?: string
}

export const WORKSPACE_DOMAIN = 'newtheatre.org.uk'

/**
 * Server-side Workspace assertion — CLAUDE.md invariant 5. The
 * `authorizationParams.hd` hint is cosmetic; this is the check.
 */
export function isWorkspaceProfile(profile: GoogleProfile): boolean {
  return profile.hd === WORKSPACE_DOMAIN && profile.email_verified === true
}

type UserRow = typeof schema.users.$inferSelect

/**
 * Find or create the account for a Workspace Google profile.
 *
 * Never writes `users.email` when attaching to an existing account — one
 * account, two sign-in methods, two addresses is a supported steady state.
 * Returns the (possibly updated) user row; caller decides about sessions.
 */
export async function resolveGoogleUser(profile: GoogleProfile): Promise<{ user: UserRow, how: 'sub' | 'pending' | 'email' | 'created' }> {
  const googleEmail = profile.email.toLowerCase()

  // 1. Already linked by stable subject id.
  const bySub = await db.select().from(schema.users)
    .where(eq(schema.users.googleSub, profile.sub)).get()
  if (bySub) return { user: bySub, how: 'sub' }

  // 2. Admin-directed link: attach and consume the pending marker. The user
  //    proves control by authenticating — an admin can never complete a link
  //    alone, by design.
  const byPending = await db.select().from(schema.users)
    .where(eq(schema.users.pendingGoogleEmail, googleEmail)).get()
  if (byPending) {
    const [user] = await db.update(schema.users)
      .set({ googleSub: profile.sub, pendingGoogleEmail: null })
      .where(eq(schema.users.id, byPending.id))
      .returning()
    await writeAudit({
      actorUserId: byPending.id,
      action: 'google.pending-link-consumed',
      target: byPending.id,
      detail: { googleEmail },
    })
    return { user: user!, how: 'pending' }
  }

  // 3. First sign-in, address matches an account (shadow accounts included —
  //    this claims them). Google has verified this exact address, so the
  //    account's email flips to verified.
  const byEmail = await db.select().from(schema.users)
    .where(eq(schema.users.email, googleEmail)).get()
  if (byEmail) {
    const [user] = await db.update(schema.users)
      .set({ googleSub: profile.sub, verified: true })
      .where(eq(schema.users.id, byEmail.id))
      .returning()
    return { user: user!, how: 'email' }
  }

  // 4. New person entirely.
  const [user] = await db.insert(schema.users).values({
    email: googleEmail,
    name: profile.name || googleEmail,
    password: null,
    verified: true,
    googleSub: profile.sub,
  }).returning()
  return { user: user!, how: 'created' }
}
