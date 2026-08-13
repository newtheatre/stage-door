import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/**
 * POST /api/webauthn/authenticate — sign in with a passkey (ADR-0012).
 *
 * A passkey is a complete login, not a second step after a password:
 * possession of the authenticator plus the user verification we insist on
 * below (PIN/biometric) is already two factors, and it is phishing-resistant
 * in a way TOTP is not. So this route seals a session on its own, and the
 * MFA challenge screen offers it as an alternative to typing a code.
 *
 * Usernameless by design: no `allowCredentials`, so nothing here answers
 * "does this address have a passkey?" for an unauthenticated caller. The
 * credential in the response identifies the account.
 *
 * See register.post.ts for why storeChallenge/getChallenge and the manual
 * `userVerified` assertion are not optional.
 */
export default defineWebAuthnAuthenticateEventHandler({
  // The module defaults to 'preferred', and asserting userVerified afterwards
  // would mean failing the user *after* they'd already tapped. Ask up front.
  getOptions: () => ({ userVerification: 'required' }),

  async storeChallenge(event, challenge, attemptId) {
    await enforceRateLimit('mfa:ip', getClientIP(event))
    await storeWebauthnChallenge(attemptId, challenge, 'webauthn-authenticate', null)
  },

  getChallenge: (event, attemptId) => getWebauthnChallenge(attemptId, 'webauthn-authenticate'),

  async getCredential(event, credentialId) {
    const row = await db.select().from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.credentialId, credentialId)).get()

    if (!row) {
      throw createError({ statusCode: 401, statusMessage: 'That passkey is not registered' })
    }

    return {
      id: row.credentialId,
      publicKey: row.publicKey,
      counter: row.counter,
      backedUp: row.backedUp,
      transports: row.transports ? JSON.parse(row.transports) : undefined,
      // Carried through to onSuccess, which gets this object back verbatim.
      rowId: row.id,
      userId: row.userId,
    }
  },

  async onSuccess(event, { credential, authenticationInfo }) {
    if (!authenticationInfo.userVerified) {
      throw createError({
        statusCode: 400,
        statusMessage: 'That passkey did not confirm it was you. Unlock the device with your PIN, fingerprint or face and try again.',
      })
    }

    const userId = credential.userId as string

    await enforceRateLimit('mfa:acct', userId)

    const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get()
    if (!user || user.disabled) {
      throw createError({ statusCode: 401, statusMessage: 'Invalid email or password' })
    }

    // Signature counter: authenticators that keep one increment it. A
    // non-increasing counter from an authenticator that uses them is the
    // classic clone signal — but most passkeys (synced ones especially)
    // report a constant 0, so this is recorded, not enforced.
    await db.update(schema.webauthnCredentials)
      .set({ counter: authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(schema.webauthnCredentials.id, credential.rowId as string))

    await sealLoginSession(event, user)
  },
})
