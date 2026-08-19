import { db, schema } from '@nuxthub/db'
import { asc } from 'drizzle-orm'

/**
 * List registered apps, each with whether its service token exists.
 */
export default defineEventHandler(async (event) => {
  await requireAuthAdmin(event)

  const rows = await db.select().from(schema.apps).orderBy(asc(schema.apps.name)).all()
  const manifests = await db.select().from(schema.appManifests).all()
  const manifestByApp = new Map(manifests.map(m => [m.appId, m]))
  const tokens = await db.select({ name: schema.serviceTokens.name }).from(schema.serviceTokens).all()
  const named = new Set(tokens.map(t => t.name))

  return {
    apps: rows.map(app => ({
      id: app.id,
      name: app.name,
      namespace: app.namespace,
      displayName: app.displayName,
      baseUrl: app.baseUrl,
      hooksEnabled: app.hooksEnabled,
      manifestEnabled: app.manifestEnabled,
      lastSyncedAt: app.lastSyncedAt?.getTime() ?? null,
      createdAt: app.createdAt?.getTime() ?? null,
      // A registered app with no token cannot be called: hookBearer needs one.
      hasToken: named.has(app.name),
      manifest: manifestByApp.get(app.id)
        ? {
            version: manifestByApp.get(app.id)!.version,
            appliedAt: manifestByApp.get(app.id)!.appliedAt?.getTime() ?? null,
            lastAttemptAt: manifestByApp.get(app.id)!.lastAttemptAt?.getTime() ?? null,
            lastError: manifestByApp.get(app.id)!.lastError,
          }
        : null,
    })),
  }
})
