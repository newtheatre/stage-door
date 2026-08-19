/**
 * Test globals: the auto-imports Nuxt provides in production, backed by light
 * fakes. Handlers under test are the real files from server/api.
 */

import { beforeEach, vi } from 'vitest'
import { resetDb } from './mocks/nuxthub-db'
import { passwordSchema, emailSchema, roleSchema, roleGrantSchema, MAX_GRANTS_PER_REQUEST, namespaceSchema, roleNameSchema, permissionKeySchema, eligibilityKeySchema, appNameSchema, baseUrlSchema, isUndeliverableEmail, isWorkspaceEmail, assertPasswordAllowed } from '../server/utils/validation'
import { TOKEN_EXPIRY, generateVerificationToken, hashLoginToken, createEmailVerificationToken, createPasswordResetToken, createMagicLinkToken } from '../server/utils/tokens'
import { enforceRateLimit, getClientIP, sweepRateLimits, RATE_LIMITS } from '../server/utils/rateLimit'
import { verifyPasswordGuarded } from '../server/utils/passwordCheck'
import { loadRoles, loadRoleGrants, loadEffectiveRolesFor, activeRoleCondition, activeGrantExists, effectiveRoleCondition, eligibilitySatisfiedCondition, sealUserSession, sealLoginSession } from '../server/utils/session'
import { assertGrantsDefined, assertEligibilityModeAllowed } from '../server/utils/roleDefinitions'
import { ROLES_CONFIG, nextCommitteeYearEnd } from '../server/utils/rolesConfig'
import { findSuspectGrants, explain } from '../server/utils/grantAudit'
import { writeAudit } from '../server/utils/audit'
import { validateRedirect } from '../shared/utils/validateRedirect'
import { refreshSession } from '../server/utils/refresh'
import { requireServiceToken, createServiceToken, hashServiceToken, generateServiceToken } from '../server/utils/serviceToken'
import { requireAuthAdmin } from '../server/utils/adminGuard'
import { requireAccountUser } from '../server/utils/accountGuard'
import { loadUserOr404, adminUserView, isAnonymisedRow, isRealRow, assertNotAnonymised, ANONYMISED_SUFFIX } from '../server/utils/adminUsers'
import { isWorkspaceProfile, resolveGoogleUser, WORKSPACE_DOMAIN } from '../server/utils/googleAccount'
import { callAppHook, callAllAppHooks, loadHookApps } from '../server/utils/appHooks'
import { manifestSchema, manifestHash, MANIFEST_MAX_BYTES } from '../server/utils/manifest'
import { snapshotRule, snapshotAllRules, referencedRuleKeys, trainingApp } from '../server/utils/eligibility'
import { syncApp, syncAllApps, reconcileManifest } from '../server/utils/manifestSync'
import { eraseUser } from '../server/utils/erase'
import { mergeUsers } from '../server/utils/mergeUsers'
import { exportUser } from '../server/utils/exportUser'
import { planRetention } from '../server/utils/retentionPlan'
import { RETENTION_CONFIG } from '../server/utils/retentionConfig'
import { base32Encode, base32Decode, generateTotpSecret, totpStep, totpCode, verifyTotp, totpUri } from '../server/utils/totp'
import { MFA_ATTEMPT_TTL_MS, WEBAUTHN_CHALLENGE_TTL_MS, isMfaRequired, enrolledFactors, sealOrChallenge, createMfaAttempt, consumeMfaAttempt, storeWebauthnChallenge, getWebauthnChallenge, sweepMfaChallenges, regenerateRecoveryCodes, useRecoveryCode, remainingRecoveryCodes, clearAllFactors, listPasskeys } from '../server/utils/mfa'

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
  // h3 carries `data` through to the client (that's how the login page gets
  // `useGoogle` and a re-issued MFA attempt) — the fake must too.
  data?: unknown
  constructor(opts: { statusCode: number, statusMessage: string, data?: unknown }) {
    super(opts.statusMessage)
    this.statusCode = opts.statusCode
    this.statusMessage = opts.statusMessage
    this.data = opts.data
  }
}

const g = globalThis as Record<string, unknown>

g.defineEventHandler = (handler: unknown) => handler
g.defineTask = (task: unknown) => task
g.createError = (opts: { statusCode: number, statusMessage: string, data?: unknown }) => new HttpError(opts)
g.readValidatedBody = async (event: FakeEvent, parse: (body: unknown) => unknown) => parse(event.body)
g.getRequestHeader = (event: FakeEvent, name: string) => event.headers[name.toLowerCase()]
g.getQuery = (event: FakeEvent) => event.query ?? {}
g.sendRedirect = (event: FakeEvent, url: string, status = 302) => {
  event.redirectedTo = { url, status }
}
g.getRouterParam = (event: FakeEvent, name: string) => event.params?.[name]
g.getValidatedQuery = async (event: FakeEvent, parse: (query: unknown) => unknown) => parse(event.query ?? {})
g.setHeader = () => {}
g.setResponseStatus = () => {}

/** Programmable stand-in for useRuntimeConfig (worker secrets in tests). */
export const runtimeConfig: Record<string, unknown> = {}
g.useRuntimeConfig = () => runtimeConfig

/** Programmable stand-in for the global $fetch (app-hook calls in tests). */
export const fetchMock = vi.fn()
/** $fetch.raw, which the manifest fetcher uses for its status and ETag. */
export const rawFetchMock = vi.fn()
g.$fetch = Object.assign(fetchMock, { raw: rawFetchMock })

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
g.sendMagicLinkEmail = async (to: string, token: string) => {
  sentEmails.push({ kind: 'magic-link', to, token })
}
g.sendRoleExpiryWarningEmail = async (to: string, grants: { role: string }[]) => {
  sentEmails.push({ kind: 'role-expiry-warning', to, token: grants.map(g => g.role).join(',') })
}
g.sendRoleExpiryDigestEmail = async (to: string) => {
  sentEmails.push({ kind: 'role-expiry-digest', to })
}
g.sendSuspectGrantsEmail = async (to: string, suspects: { role: string }[]) => {
  sentEmails.push({ kind: 'suspect-grants', to, token: suspects.map(s => s.role).join(',') })
}
g.sendRetentionWarningEmail = async (to: string) => {
  sentEmails.push({ kind: 'retention-warning', to })
}
g.sendRetentionDigestEmail = async (to: string) => {
  sentEmails.push({ kind: 'retention-digest', to })
}

// ── Real server utils, exposed the way auto-imports would ───────────────────

Object.assign(g, {
  passwordSchema,
  emailSchema,
  roleSchema,
  roleGrantSchema,
  MAX_GRANTS_PER_REQUEST,
  namespaceSchema,
  roleNameSchema,
  permissionKeySchema,
  eligibilityKeySchema,
  appNameSchema,
  baseUrlSchema,
  isUndeliverableEmail,
  isWorkspaceEmail,
  assertPasswordAllowed,
  TOKEN_EXPIRY,
  generateVerificationToken,
  hashLoginToken,
  createEmailVerificationToken,
  createPasswordResetToken,
  createMagicLinkToken,
  enforceRateLimit,
  getClientIP,
  sweepRateLimits,
  RATE_LIMITS,
  verifyPasswordGuarded,
  loadRoles,
  loadRoleGrants,
  loadEffectiveRolesFor,
  activeRoleCondition,
  activeGrantExists,
  effectiveRoleCondition,
  eligibilitySatisfiedCondition,
  assertGrantsDefined,
  assertEligibilityModeAllowed,
  ROLES_CONFIG,
  nextCommitteeYearEnd,
  findSuspectGrants,
  explain,
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
  isAnonymisedRow,
  isRealRow,
  assertNotAnonymised,
  ANONYMISED_SUFFIX,
  isWorkspaceProfile,
  resolveGoogleUser,
  WORKSPACE_DOMAIN,
  callAppHook,
  callAllAppHooks,
  loadHookApps,
  manifestSchema,
  manifestHash,
  MANIFEST_MAX_BYTES,
  syncApp,
  syncAllApps,
  reconcileManifest,
  snapshotRule,
  snapshotAllRules,
  referencedRuleKeys,
  trainingApp,
  eraseUser,
  mergeUsers,
  exportUser,
  planRetention,
  RETENTION_CONFIG,
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpStep,
  totpCode,
  verifyTotp,
  totpUri,
  MFA_ATTEMPT_TTL_MS,
  WEBAUTHN_CHALLENGE_TTL_MS,
  isMfaRequired,
  enrolledFactors,
  sealOrChallenge,
  createMfaAttempt,
  consumeMfaAttempt,
  storeWebauthnChallenge,
  getWebauthnChallenge,
  sweepMfaChallenges,
  regenerateRecoveryCodes,
  useRecoveryCode,
  remainingRecoveryCodes,
  clearAllFactors,
  listPasskeys,
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
  rawFetchMock.mockReset()
  Object.keys(runtimeConfig).forEach(key => Reflect.deleteProperty(runtimeConfig, key))
  vi.useRealTimers()
})
