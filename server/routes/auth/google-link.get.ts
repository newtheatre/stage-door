/**
 * Self-service "Connect NNT Google account". Requires a fresh session, and
 * refuses an identity already linked elsewhere — that is a merge, not a link.
 */
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import type { GoogleProfile } from '../../utils/googleAccount'

/** How recent the login must be for account-linking to proceed. */
const FRESH_SESSION_MS = 10 * 60_000

export default defineOAuthGoogleEventHandler({
  config: {
    authorizationParams: {
      hd: WORKSPACE_DOMAIN,
    },
  },

  async onSuccess(event, { user: profile }) {
    const session = await getUserSession(event)
    if (!session.user) {
      return sendRedirect(event, '/login?redirect=/account', 302)
    }
    if (Date.now() - (session.loggedInAt ?? 0) > FRESH_SESSION_MS) {
      // Not fresh enough for a credential change — log in again first.
      return sendRedirect(event, '/account?error=stale-session', 302)
    }

    const googleProfile = profile as GoogleProfile
    if (!isWorkspaceProfile(googleProfile)) {
      return sendRedirect(event, '/google-rejected', 302)
    }

    const existing = await db.select().from(schema.users)
      .where(eq(schema.users.googleSub, googleProfile.sub)).get()
    if (existing && existing.id !== session.user.id) {
      return sendRedirect(event, '/account?error=google-already-linked', 302)
    }

    const [user] = await db.update(schema.users)
      .set({ googleSub: googleProfile.sub, pendingGoogleEmail: null })
      .where(eq(schema.users.id, session.user.id))
      .returning()

    if (!user || user.disabled) {
      return sendRedirect(event, '/google-rejected', 302)
    }

    await writeAudit({
      actorUserId: user.id,
      action: 'google.linked',
      target: user.id,
      detail: { googleEmail: googleProfile.email.toLowerCase(), via: 'self-service' },
    })

    // Re-seal so the account page reflects the link immediately.
    const roles = await loadRoles(user.id)
    await sealUserSession(event, user, roles, { fresh: false, loggedInAt: session.loggedInAt })

    return sendRedirect(event, '/account?linked=1', 302)
  },

  onError(event, error) {
    console.error('[Google OAuth] link flow failed:', error)
    return sendRedirect(event, '/account?error=google', 302)
  },
})
