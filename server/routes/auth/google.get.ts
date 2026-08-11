/**
 * GET /auth/google — Google OAuth sign-in (browser redirect flow).
 *
 * The `?redirect=` target rides through the OAuth round-trip in `state` and
 * is validated against the allowlist on the way back out. Workspace-only:
 * the server-side `hd` + `email_verified` assertion is the real check
 * (CLAUDE.md invariant 5); non-Workspace accounts land on the friendly
 * rejection page with no session.
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

    const { state } = getQuery(event)
    return sendRedirect(event, validateRedirect(state), 302)
  },

  onError(event, error) {
    console.error('[Google OAuth] flow failed:', error)
    return sendRedirect(event, '/login?error=google', 302)
  },
})
