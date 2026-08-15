/**
 * Google OAuth sign-in. The server-side `hd` + `email_verified` assertion is
 * the real check (CLAUDE.md invariant 5); `?redirect=` rides in `state`.
 */
import type { GoogleProfile } from '../../utils/googleAccount'

export default defineOAuthGoogleEventHandler({
  config: {
    authorizationParams: {
      hd: WORKSPACE_DOMAIN, // UX hint only — pre-selects the Workspace account
    },
  },

  async onSuccess(event, { user: profile }) {
    if (!isWorkspaceProfile(profile as GoogleProfile)) {
      return sendRedirect(event, '/google-rejected', 302)
    }

    const { user } = await resolveGoogleUser(profile as GoogleProfile)

    if (user.disabled) {
      return sendRedirect(event, '/google-rejected', 302)
    }

    await sealLoginSession(event, user)

    // No state = they started here, not at an app — stay on the account
    // home. An invalid state still falls back to the apex (invariant 6).
    const { state } = getQuery(event)
    return sendRedirect(event, typeof state === 'string' && state ? validateRedirect(state) : '/', 302)
  },

  onError(event, error) {
    console.error('[Google OAuth] flow failed:', error)
    return sendRedirect(event, '/login?error=google', 302)
  },
})
