import { db, schema } from '@nuxthub/db'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

const querySchema = z.object({
  // Bare role names. The namespace comes from the caller's own app, so no app
  // can ask who holds another app's roles.
  roles: z.string().min(1).max(200),
})

/** How many roles one question may name. Fixes the bound parameter count. */
const MAX_ROLES = 10
const MAX_HOLDERS = 200

/**
 * Service-token only. Who currently holds these roles, for a consumer app that
 * needs to offer a list of its own people.
 */
export default defineEventHandler(async (event) => {
  const serviceToken = await requireServiceToken(event)
  const { roles } = await getValidatedQuery(event, querySchema.parse)

  if (!serviceToken.appId) {
    throw createError({ statusCode: 403, statusMessage: 'This token is not bound to an app.' })
  }

  const app = await db.select({ namespace: schema.apps.namespace })
    .from(schema.apps).where(eq(schema.apps.id, serviceToken.appId)).get()

  if (!app) {
    throw createError({ statusCode: 403, statusMessage: 'This token is not bound to an app.' })
  }

  const wanted = [...new Set(roles.split(',').map(role => role.trim()).filter(Boolean))]
  if (!wanted.length || wanted.length > MAX_ROLES) {
    throw createError({ statusCode: 400, statusMessage: `Name between 1 and ${MAX_ROLES} roles.` })
  }

  const namespaced = wanted.map(role => `${app.namespace}:${role}`)

  // Effective, not merely granted: an expired grant, or one whose enforcing
  // training prerequisite is unmet, is not a holder (ADR-0011, ADR-0019).
  const rows = await db.selectDistinct({
    id: schema.users.id,
    name: schema.users.name,
  })
    .from(schema.users)
    .innerJoin(schema.userRoles, eq(schema.userRoles.userId, schema.users.id))
    .where(and(
      inArray(schema.userRoles.role, namespaced),
      effectiveRoleCondition(),
      eq(schema.users.disabled, false),
      isRealRow(),
    ))
    .orderBy(asc(schema.users.name))
    .limit(MAX_HOLDERS)

  // Id and name only. A picker needs no more, and less crosses the boundary.
  return { namespace: app.namespace, holders: rows }
})
