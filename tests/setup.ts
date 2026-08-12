/**
 * Test globals: the auto-imports Nuxt/Nitro provide in production, backed by
 * light fakes (H3 helpers, session store, email recorder) and the real
 * server utils. Handlers under test are the real files from server/api.
 */

import { beforeEach, vi } from 'vitest'
import { resetDb } from './mocks/nuxthub-db'
import { passwordSchema, emailSchema, roleSchema, isUndeliverableEmail } from '../server/utils/validation'
import { TOKEN_EXPIRY, generateVerificationToken, createEmailVerificationToken, createPasswordResetToken } from '../server/utils/tokens'
import { enforceRateLimit, getClientIP, sweepRateLimits, RATE_LIMITS } from '../server/utils/rateLimit'
import { verifyPasswordGuarded } from '../server/utils/passwordCheck'
import { loadRoles, sealUserSession, sealLoginSession } from '../server/utils/session'
import { writeAudit } from '../server/utils/audit'
import { validateRedirect } from '../shared/utils/validateRedirect'
import { refreshSession } from '../server/utils/refresh'
import { requireServiceToken, createServiceToken, hashServiceToken, generateServiceToken } from '../server/utils/serviceToken'
import { requireAuthAdmin } from '../server/utils/adminGuard'
import { requireAccountUser } from '../server/utils/accountGuard'
import { loadUserOr404, adminUserView } from '../server/utils/adminUsers'
import { isWorkspaceProfile, resolveGoogleUser, WORKSPACE_DOMAIN } from '../server/utils/googleAccount'
import { callAppHook, callAllAppHooks, HOOK_APPS } from '../server/utils/appHooks'
import { eraseUser } from '../server/utils/erase'
import { exportUser } from '../server/utils/exportUser'
import { planRetention } from '../server/utils/retentionPlan'
import { RETENTION_CONFIG } from '../server/utils/retentionConfig'

// ── H3 fakes ────────────────────────────────────────────────────────────────

export interface FakeEvent {
  method: string
  path: string
  body?: unknown
  headers: Record<string, string>
  query?: Record<string, unknown>
  params?: Record<string, string>
  redirectedTo?: { url: string, status: number }
}

class HttpError extends Error {
  statusCode: number
  statusMessage: string
  constructor(opts: { statusCode: number, statusMessage: string }) {
    super(opts.statusMessage)
    this.statusCode = opts.statusCode
    this.statusMessage = opts.statusMessage
  }
}

const g = globalThis as Record<string, unknown>

g.defineEventHandler = (handler: unknown) => handler
g.defineTask = (task: unknown) => task
g.createError = (opts: { statusCode: number, statusMessage: string }) => new HttpError(opts)
g.readValidatedBody = async (event: FakeEvent, parse: (body: unknown) => unknown) => parse(event.body)
g.getRequestHeader = (event: FakeEvent, name: string) => event.headers[name.toLowerCase()]
g.getQuery = (event: FakeEvent) => event.query ?? {}
g.sendRedirect = (event: FakeEvent, url: string, status = 302) => {
  event.redirectedTo = { url, status }
}
g.getRouterParam = (event: FakeEvent, name: string) => event.params?.[name]
g.getValidatedQuery = async (event: FakeEvent, parse: (query: unknown) => unknown) => parse(event.query ?? {})
g.setHeader = () => {}

/** Programmable stand-in for the global $fetch (app-hook calls in tests). */
export const fetchMock = vi.fn()
g.$fetch = fetchMock

// ── Session store fake (nuxt-auth-utils) ────────────────────────────────────

const sessions = new WeakMap<object, Record<string, unknown>>()

g.setUserSession = async (event: object, session: Record<string, unknown>) => {
  sessions.set(event, session)
  return session
}
g.replaceUserSession = async (event: object, session: Record<string, unknown>) => {
  sessions.set(event, session)
  return session
}
g.getUserSession = async (event: object) => sessions.get(event) ?? {}
g.clearUserSession = async (event: object) => sessions.delete(event)
g.requireUserSession = async (event: object) => {
  const session = sessions.get(event)
  if (!session?.user) throw new HttpError({ statusCode: 401, statusMessage: 'Unauthorized' })
  return session
}

/** Read the session a handler sealed for an event (test helper). */
export function sealedSession(event: object): Record<string, unknown> | undefined {
  return sessions.get(event)
}

// ── Password hashing fakes (deterministic, fast) ────────────────────────────

g.hashPassword = async (password: string) => `fake$${password}`
g.verifyPassword = async (hash: string, password: string) => hash === `fake$${password}`

// ── Email recorder ──────────────────────────────────────────────────────────

export const sentEmails: { kind: string, to: string, token?: string }[] = []

g.sendVerificationEmail = async (to: string, token: string) => {
  sentEmails.push({ kind: 'verification', to, token })
}
g.sendPasswordResetEmail = async (to: string, token: string) => {
  sentEmails.push({ kind: 'reset', to, token })
}
g.sendAccountExistsEmail = async (to: string) => {
  sentEmails.push({ kind: 'account-exists', to })
}

// ── Real server utils, exposed the way auto-imports would ───────────────────

Object.assign(g, {
  passwordSchema,
  emailSchema,
  roleSchema,
  isUndeliverableEmail,
  TOKEN_EXPIRY,
  generateVerificationToken,
  createEmailVerificationToken,
  createPasswordResetToken,
  enforceRateLimit,
  getClientIP,
  sweepRateLimits,
  RATE_LIMITS,
  verifyPasswordGuarded,
  loadRoles,
  sealUserSession,
  sealLoginSession,
  writeAudit,
  validateRedirect,
  refreshSession,
  requireServiceToken,
  createServiceToken,
  hashServiceToken,
  generateServiceToken,
  requireAuthAdmin,
  requireAccountUser,
  loadUserOr404,
  adminUserView,
  isWorkspaceProfile,
  resolveGoogleUser,
  WORKSPACE_DOMAIN,
  callAppHook,
  callAllAppHooks,
  HOOK_APPS,
  eraseUser,
  exportUser,
  planRetention,
  RETENTION_CONFIG,
})

// ── Per-test reset ──────────────────────────────────────────────────────────

let eventCounter = 0

/** Build a fake H3 event. Each gets a unique IP unless overridden. */
export function makeEvent(opts: Partial<FakeEvent> = {}): FakeEvent {
  eventCounter += 1
  return {
    method: opts.method ?? 'POST',
    path: opts.path ?? '/api/test',
    body: opts.body,
    query: opts.query,
    params: opts.params,
    headers: {
      'cf-connecting-ip': `10.0.${Math.floor(eventCounter / 250)}.${eventCounter % 250}`,
      ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    },
  }
}

beforeEach(() => {
  resetDb()
  sentEmails.length = 0
  fetchMock.mockReset()
  vi.useRealTimers()
})
