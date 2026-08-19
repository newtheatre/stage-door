import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/**
 * Sign in with a passkey — a complete login, not a second step (ADR-0012).
 * Usernameless by design. See register.post.ts for the non-default options.
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

    // Here, not in onSuccess: this is the first point the flow knows the
    // account, and the only one where a failed assertion can be counted.
    await enforceRateLimit('passkey:acct', row.userId)

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

    const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get()
    if (!user || user.disabled) {
      throw createError({ statusCode: 401, statusMessage: 'Invalid email or password' })
    }

    // Recorded, not enforced: most synced passkeys report a constant 0, so a
    // non-increasing counter is not a reliable clone signal.
    await db.update(schema.webauthnCredentials)
      .set({ counter: authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(schema.webauthnCredentials.id, credential.rowId as string))

    await sealLoginSession(event, user)
  },
})
