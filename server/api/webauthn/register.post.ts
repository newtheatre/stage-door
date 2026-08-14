import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'

/**
 * Enrol a passkey (ADR-0012). Three options here are not the module's
 * defaults and are load-bearing — see docs/security.md#passkeys.
 */
export default defineWebAuthnRegisterEventHandler({
  async validateUser(_userBody, event) {
    const { user } = await requireAccountUser(event)
    return { userName: user.email, displayName: user.name }
  },

  async getOptions(event) {
    const { user } = await requireAccountUser(event)
    return {
      userID: new TextEncoder().encode(user.id),
      userName: user.email,
      userDisplayName: user.name,
      // Shown in the OS prompt. rpID stays the request hostname (the default),
      // which is why a localhost passkey is not a production one.
      rpName: 'Nottingham New Theatre',
      attestationType: 'none',
      authenticatorSelection: {
        // Discoverable, so sign-in can be usernameless: the credential names the
        // account.
        residentKey: 'required',
        userVerification: 'required',
      },
    }
  },

  // Stops the same authenticator enrolling twice.
  async excludeCredentials(event) {
    const { user } = await requireAccountUser(event)
    const rows = await db.select().from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, user.id)).all()
    return rows.map(row => ({
      id: row.credentialId,
      transports: row.transports ? JSON.parse(row.transports) : undefined,
    }))
  },

  async storeChallenge(event, challenge, attemptId) {
    const { user } = await requireAccountUser(event)
    await enforceRateLimit('mfa:acct', user.id)
    await storeWebauthnChallenge(attemptId, challenge, 'webauthn-register', user.id)
  },

  async getChallenge(event, attemptId) {
    const { user } = await requireAccountUser(event)
    return getWebauthnChallenge(attemptId, 'webauthn-register', user.id)
  },

  async onSuccess(event, { credential, registrationInfo }) {
    const { user, loggedInAt } = await requireAccountUser(event)

    if (!registrationInfo.userVerified) {
      throw createError({
        statusCode: 400,
        statusMessage: 'That passkey did not ask you to confirm it was you. Set up a PIN, fingerprint or face unlock on the device and try again.',
      })
    }

    // The client's label for this device, carried on the user object because
    // that is the only part of the body useWebAuthn() lets a caller shape.
    const body = await readBody(event)
    const submitted = body?.user?.label
    const label = typeof submitted === 'string' && submitted.trim()
      ? submitted.trim().slice(0, 60)
      : 'Passkey'

    const firstFactor = (await enrolledFactors(user.id)).length === 0

    await db.insert(schema.webauthnCredentials).values({
      userId: user.id,
      credentialId: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ? JSON.stringify(credential.transports) : null,
      backedUp: credential.backedUp,
      name: label,
    })

    // A new factor invalidates other sessions (same pattern as a password
    // change): bump the epoch, then re-seal this one so only the others die.
    if (firstFactor) {
      const [updated] = await db.update(schema.users)
        .set({ sessionEpoch: sql`${schema.users.sessionEpoch} + 1` })
        .where(eq(schema.users.id, user.id))
        .returning()
      await sealUserSession(event, updated!, await loadRoles(user.id), { fresh: false, loggedInAt })
    }

    await writeAudit({
      actorUserId: user.id,
      action: 'mfa.passkey-enrolled',
      target: user.id,
      detail: { name: label },
    })
  },
})
