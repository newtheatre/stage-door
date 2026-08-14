import { db, schema } from '@nuxthub/db'

type UserInsert = typeof schema.users.$inferInsert

/** Insert a user directly. Password given in plain text — stored with the test fake hash. */
export async function createUser(overrides: Partial<UserInsert> & { plainPassword?: string } = {}) {
  const { plainPassword, ...rest } = overrides

  const [user] = await db.insert(schema.users).values({
    email: 'someone@example.com',
    name: 'Some One',
    password: plainPassword !== undefined ? `fake$${plainPassword}` : null,
    verified: false,
    ...rest,
  }).returning()

  if (!user) throw new Error('failed to insert test user')
  return user
}

export async function grantRole(
  userId: string,
  role: string,
  opts: { expiresAt?: Date, grantedBy?: string, note?: string, expiryWarnedAt?: Date } = {},
) {
  await db.insert(schema.userRoles).values({
    userId,
    role,
    expiresAt: opts.expiresAt ?? null,
    grantedBy: opts.grantedBy ?? null,
    note: opts.note ?? null,
    expiryWarnedAt: opts.expiryWarnedAt ?? null,
  })
}

/**
 * Give a user a confirmed TOTP factor. Admin fixtures need one: a password
 * admin with no factor is deliberately refused by `requireAuthAdmin`
 * (ADR-0012).
 */
export async function enrolTotp(userId: string, secret = 'JBSWY3DPEHPK3PXP') {
  await db.insert(schema.totpSecrets).values({ userId, secret, confirmedAt: new Date() })
}

/**
 * Insert a role definition so a grant of `namespace:role` is legal — new
 * grants must reference one (ADR-0014).
 */
export async function defineRole(namespace: string, role: string) {
  await db.insert(schema.roleDefinitions).values({
    namespace,
    role,
    description: `${namespace} ${role} (test)`,
    defaultExpiryKind: 'none',
  })
}
