/**
 * Google identity resolution. A linked identity is keyed by the stable
 * `google_sub`, never by address. Precedence: docs/architecture.md
 */

import { db, schema } from '@nuxthub/db'
import { and, eq, ne } from 'drizzle-orm'

export interface GoogleProfile {
  sub: string
  email: string
  email_verified: boolean
  hd?: string
  name?: string
}

export const WORKSPACE_DOMAIN = 'newtheatre.org.uk'

/**
 * Server-side Workspace assertion: CLAUDE.md invariant 5. The
 * `authorizationParams.hd` hint is cosmetic; this is the check.
 */
export function isWorkspaceProfile(profile: GoogleProfile): boolean {
  return profile.hd === WORKSPACE_DOMAIN && profile.email_verified === true
}

type UserRow = typeof schema.users.$inferSelect

/**
 * Never writes `users.email` when attaching to an existing account, and
 * commits nothing at all for a disabled one (docs/api-reference.md).
 */
export async function resolveGoogleUser(profile: GoogleProfile): Promise<{ user: UserRow, how: 'sub' | 'pending' | 'email' | 'created' }> {
  const googleEmail = profile.email.toLowerCase()

  // 1. Already linked by stable subject id.
  const bySub = await db.select().from(schema.users)
    .where(eq(schema.users.googleSub, profile.sub)).get()
  if (bySub) {
    // A marker for an address already linked can never be consumed, so clear
    // it. Not for a disabled account: a rejected sign-in writes nothing.
    if (!bySub.disabled) {
      await db.update(schema.users).set({ pendingGoogleEmail: null })
        .where(and(eq(schema.users.pendingGoogleEmail, googleEmail), ne(schema.users.id, bySub.id)))
    }
    return { user: bySub, how: 'sub' }
  }

  // Admin-directed link: the user still proves control by authenticating, so
  // an admin can never complete a link alone.
  const byPending = await db.select().from(schema.users)
    .where(eq(schema.users.pendingGoogleEmail, googleEmail)).get()
  if (byPending) {
    // Refusing after the write would leave the link committed and the admin's
    // pending intent consumed on a sign-in that is about to be rejected.
    if (byPending.disabled) return { user: byPending, how: 'pending' }

    const [user] = await db.update(schema.users)
      .set({ googleSub: profile.sub, pendingGoogleEmail: null })
      .where(eq(schema.users.id, byPending.id))
      .returning()
    await writeAudit({
      actorUserId: byPending.id,
      action: 'google.pending-link-consumed',
      target: byPending.id,
      // No address: it must not outlive an erasure (same rule as user.erased).
      detail: { via: 'pending-link' },
    })
    return { user: user!, how: 'pending' }
  }

  // Google has verified this exact address, so the account's email flips to
  // verified. Shadow accounts are claimed this way.
  const byEmail = await db.select().from(schema.users)
    .where(eq(schema.users.email, googleEmail)).get()
  if (byEmail) {
    if (byEmail.disabled) return { user: byEmail, how: 'email' }

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
