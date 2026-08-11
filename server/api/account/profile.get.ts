/** GET /api/account/profile — the caller's own profile. */
export default defineEventHandler(async (event) => {
  const { user } = await requireAccountUser(event)

  return {
    profile: {
      id: user.id,
      email: user.email,
      name: user.name,
      verified: user.verified,
      hasPassword: user.password !== null,
      googleLinked: user.googleSub !== null,
      createdAt: user.createdAt,
    },
  }
})
