/**
 * Fetching and reconciling app manifests (ADR-0018). Nothing is ever withdrawn
 * except as a consequence of a document that parsed.
 */

import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { manifestHash, manifestSchema, MANIFEST_MAX_BYTES, type Manifest } from './manifest'
import { defaultExpiryColumns } from './validation'
import { eligibilityModeAllowed } from './roleDefinitions'

type AppRow = typeof schema.apps.$inferSelect

export interface SyncResult {
  app: string
  ok: boolean
  /** True when the document hash matched and reconciliation was skipped. */
  unchanged?: boolean
  error?: string
  counts?: { roles: number, withdrawn: number, permissions: number, adopted: number }
}

async function recordFailure(appId: string, message: string): Promise<void> {
  const now = new Date()
  const existing = await db.select().from(schema.appManifests)
    .where(eq(schema.appManifests.appId, appId)).get()

  if (existing) {
    // Only the error fields move: the last good document stays authoritative.
    await db.update(schema.appManifests)
      .set({ lastAttemptAt: now, lastError: message })
      .where(eq(schema.appManifests.appId, appId))
    return
  }

  await db.insert(schema.appManifests).values({
    appId,
    document: '',
    documentHash: '',
    version: '',
    fetchedAt: now,
    lastAttemptAt: now,
    lastError: message,
  })
}

/**
 * Fetch one app's manifest. Returns the raw body, or null when nothing should
 * change (unreachable, oversized, or a 304).
 */
async function fetchManifest(app: AppRow): Promise<{ body: string, etag: string | null } | null> {
  const stored = await db.select().from(schema.appManifests)
    .where(eq(schema.appManifests.appId, app.id)).get()

  const bearer = await db.select({ tokenHash: schema.serviceTokens.tokenHash })
    .from(schema.serviceTokens).where(eq(schema.serviceTokens.name, app.name)).get()
  if (!bearer) throw new Error(`No service token registered for app '${app.name}'`)

  const response = await $fetch.raw<unknown>(`${app.baseUrl}/api/_hooks/auth/manifest`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${bearer.tokenHash}`,
      ...(stored?.etag ? { 'If-None-Match': stored.etag } : {}),
    },
    retry: 1,
    timeout: 15_000,
    responseType: 'text',
  })

  if (response.status === 304) return null

  const body = typeof response._data === 'string' ? response._data : JSON.stringify(response._data)
  // Bytes, not UTF-16 code units: a non-ASCII manifest is up to 3x longer
  // on the wire than String.length suggests.
  if (new TextEncoder().encode(body).length > MANIFEST_MAX_BYTES) {
    throw new Error(`Manifest is over ${MANIFEST_MAX_BYTES} bytes`)
  }

  return { body, etag: response.headers.get('etag') }
}

/**
 * Apply a parsed manifest. Callers must have validated it: reaching here is
 * what authorises withdrawing a role.
 */
export async function reconcileManifest(app: AppRow, manifest: Manifest): Promise<SyncResult['counts']> {
  const now = new Date()

  // Permissions first: role links reference their ids.
  const declared = new Map(manifest.permissions.map(p => [p.key, p]))
  const existingPermissions = await db.select().from(schema.appPermissions)
    .where(eq(schema.appPermissions.appId, app.id)).all()
  const permissionByKey = new Map(existingPermissions.map(p => [p.key, p]))

  for (const [key, permission] of declared) {
    const current = permissionByKey.get(key)
    if (current) {
      await db.update(schema.appPermissions)
        .set({ description: permission.description, active: true, lastSeenAt: now })
        .where(eq(schema.appPermissions.id, current.id))
      continue
    }
    const [inserted] = await db.insert(schema.appPermissions).values({
      appId: app.id,
      namespace: app.namespace,
      key,
      description: permission.description,
    }).returning()
    permissionByKey.set(key, inserted!)
  }

  // Undeclared permissions are deactivated, never deleted: audit detail and
  // role links point at the row.
  for (const permission of existingPermissions) {
    if (!declared.has(permission.key) && permission.active) {
      await db.update(schema.appPermissions).set({ active: false })
        .where(eq(schema.appPermissions.id, permission.id))
    }
  }

  const existingDefinitions = await db.select().from(schema.roleDefinitions)
    .where(eq(schema.roleDefinitions.namespace, app.namespace)).all()
  const definitionByRole = new Map(existingDefinitions.map(d => [d.role, d]))

  let adopted = 0
  for (const role of manifest.roles) {
    const expiry = role.defaultExpiry
    const current = definitionByRole.get(role.role)

    const fields = {
      description: role.description,
      appId: app.id,
      source: 'manifest' as const,
      manifestVersion: manifest.version,
      withdrawnAt: null,
      syncedAt: now,
    }
    const expiryFields = defaultExpiryColumns(expiry)
    // An app may suggest enforcing, but never for its own ADMIN (ADR-0019).
    const suggested = role.requiresEligibility?.suggestedMode ?? 'advisory'
    const eligibilityFields = {
      requiresEligibilityKey: role.requiresEligibility?.key ?? null,
      // Same rule assertEligibilityModeAllowed throws for on the admin path;
      // a manifest is downgraded rather than rejected (ADR-0019).
      eligibilityMode: eligibilityModeAllowed(app.namespace, role.role, suggested) ? suggested : 'advisory',
    }

    if (!current) {
      const [definition] = await db.insert(schema.roleDefinitions).values({
        namespace: app.namespace,
        role: role.role,
        ...fields,
        ...expiryFields,
        ...eligibilityFields,
      }).returning()
      await linkPermissions(definition!.id, role.permissions, permissionByKey)
      continue
    }

    if (current.source === 'manual') {
      // Adoption: the hand-made row was a stand-in for what has now arrived.
      // (namespace, role) is unique, so the alternative is two sources of truth.
      adopted += 1
      await writeAudit({
        actorUserId: null,
        action: 'role-definition.adopted',
        target: current.id,
        detail: {
          role: `${app.namespace}:${role.role}`,
          app: app.name,
          was: {
            description: current.description,
            defaultExpiryKind: current.defaultExpiryKind,
            defaultExpiryDays: current.defaultExpiryDays,
          },
        },
      })
    }

    await db.update(schema.roleDefinitions).set({
      ...fields,
      ...(current.defaultExpiryPinned ? {} : expiryFields),
      ...(current.eligibilityModePinned
        ? { requiresEligibilityKey: eligibilityFields.requiresEligibilityKey }
        : eligibilityFields),
    }).where(eq(schema.roleDefinitions.id, current.id))

    await linkPermissions(current.id, role.permissions, permissionByKey)
  }

  // Withdrawal: this app's manifest-sourced rows it no longer declares. Grants
  // are untouched and the row survives (ADR-0011).
  const declaredRoles = new Set(manifest.roles.map(r => r.role))
  let withdrawn = 0
  for (const definition of existingDefinitions) {
    const ownedHere = definition.source === 'manifest' && definition.appId === app.id
    if (ownedHere && !declaredRoles.has(definition.role) && definition.withdrawnAt === null) {
      await db.update(schema.roleDefinitions).set({ withdrawnAt: now, syncedAt: now })
        .where(eq(schema.roleDefinitions.id, definition.id))
      withdrawn += 1
    }
  }

  return { roles: manifest.roles.length, withdrawn, permissions: declared.size, adopted }
}

type PermissionRow = typeof schema.appPermissions.$inferSelect

async function linkPermissions(definitionId: string, keys: readonly string[], byKey: Map<string, PermissionRow>): Promise<void> {
  await db.delete(schema.roleDefinitionPermissions)
    .where(eq(schema.roleDefinitionPermissions.roleDefinitionId, definitionId))

  const ids = keys.map(key => byKey.get(key)?.id).filter((id): id is string => Boolean(id))
  // Two bound parameters per row, so 40 rows is 80 (D1 caps at 100).
  for (let i = 0; i < ids.length; i += 40) {
    await db.insert(schema.roleDefinitionPermissions)
      .values(ids.slice(i, i + 40).map(permissionId => ({ roleDefinitionId: definitionId, permissionId })))
  }
}

/** Fetch, validate and reconcile one app. Never throws. */
export async function syncApp(app: AppRow): Promise<SyncResult> {
  if (!app.manifestEnabled) {
    return { app: app.name, ok: false, error: 'Manifest sync is disabled for this app' }
  }

  try {
    const fetched = await fetchManifest(app)
    const now = new Date()

    if (!fetched) {
      await db.update(schema.appManifests)
        .set({ lastAttemptAt: now, lastError: null })
        .where(eq(schema.appManifests.appId, app.id))
      return { app: app.name, ok: true, unchanged: true }
    }

    const hash = await manifestHash(fetched.body)
    const stored = await db.select().from(schema.appManifests)
      .where(eq(schema.appManifests.appId, app.id)).get()

    if (stored && stored.documentHash === hash) {
      await db.update(schema.appManifests)
        .set({ fetchedAt: now, lastAttemptAt: now, lastError: null, etag: fetched.etag })
        .where(eq(schema.appManifests.appId, app.id))
      return { app: app.name, ok: true, unchanged: true }
    }

    const manifest = manifestSchema.parse(JSON.parse(fetched.body))

    // A manifest may only speak for its own namespace, and never for this
    // service's: auth:ADMIN stays a manual definition (ADR-0018).
    if (manifest.namespace !== app.namespace) {
      throw new Error(`Manifest declares namespace '${manifest.namespace}', registered as '${app.namespace}'`)
    }
    if (manifest.namespace === 'auth') {
      throw new Error('The auth namespace cannot be manifest-declared')
    }

    const counts = await reconcileManifest(app, manifest)

    await db.insert(schema.appManifests).values({
      appId: app.id,
      document: fetched.body,
      documentHash: hash,
      version: manifest.version,
      etag: fetched.etag,
      fetchedAt: now,
      appliedAt: now,
      lastAttemptAt: now,
      lastError: null,
    }).onConflictDoUpdate({
      target: schema.appManifests.appId,
      set: {
        document: fetched.body,
        documentHash: hash,
        version: manifest.version,
        etag: fetched.etag,
        fetchedAt: now,
        appliedAt: now,
        lastAttemptAt: now,
        lastError: null,
      },
    })

    await db.update(schema.apps).set({ lastSyncedAt: now }).where(eq(schema.apps.id, app.id))
    await writeAudit({
      actorUserId: null,
      action: 'app.manifest-applied',
      target: app.id,
      detail: { app: app.name, version: manifest.version, ...counts },
    })

    return { app: app.name, ok: true, counts }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[manifest] ${app.name} sync failed:`, error)
    await recordFailure(app.id, message)
    await writeAudit({
      actorUserId: null,
      action: 'app.manifest-rejected',
      target: app.id,
      detail: { app: app.name, error: message },
    })
    return { app: app.name, ok: false, error: message }
  }
}

/** Sync every app with manifests enabled. */
export async function syncAllApps(): Promise<SyncResult[]> {
  const rows = await db.select().from(schema.apps)
    .where(eq(schema.apps.manifestEnabled, true)).all()
  const results: SyncResult[] = []
  for (const app of rows) results.push(await syncApp(app))
  return results
}
