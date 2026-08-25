import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

/**
 * docs/api-reference.md states "All mutations [AUD]". Nothing enforced it, so
 * the audit log quietly lost a mutation whenever someone forgot the call.
 */
const ROOTS = ['server/api/account', 'server/api/users', 'server/api/auth']

/** Helpers that write the entry themselves, so the handler need not. */
const AUDITS_VIA = ['eraseUser', 'mergeUsers']

/**
 * Mutations that deliberately write nothing, with the reason. Adding to this
 * list should take an argument; forgetting the call should not.
 */
const EXEMPT: Record<string, string> = {
  'server/api/account/mfa/totp.post.ts':
    'starts an unconfirmed enrolment that gates nothing; totp-confirm audits the act',
  'server/api/auth/login.post.ts':
    'an ordinary login is last_login, not an audit row (docs/data-model.md)',
  'server/api/auth/logout.post.ts':
    'clears this cookie only; logout-everywhere is the one that changes the account',
  'server/api/auth/register.post.ts':
    'creates the actor, so there is nobody to attribute it to; the row itself is the record',
  'server/api/auth/email/request.post.ts':
    'resends a verification link and changes nothing on the account',
  'server/api/auth/email/verify.post.ts':
    'the address holder proving their own address; no privilege moves',
  'server/api/auth/magic-link/request.post.ts':
    'mints and emails a link; redemption is a login, and logins are last_login',
  'server/api/auth/magic-link/verify.post.ts':
    'a login by another name (docs/data-model.md)',
  'server/api/auth/password/forgot.post.ts':
    'mints and emails a token; the reset that spends it is what audits',
}

/**
 * GET routes the reference marks [AUD]. Reads are not mutations, so the sweep
 * below skips them; these few are disclosures and must stay recorded.
 */
const AUDITED_GETS = [
  'server/api/account/export.get.ts',
  'server/api/users/[id]/export.get.ts',
]

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return routeFiles(full)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.get.ts') ? [full] : []
  })
}

function getRoutes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return getRoutes(full)
    return entry.name.endsWith('.get.ts') ? [full] : []
  })
}

describe('the reads this service records', () => {
  it.each(AUDITED_GETS)('%s writes an audit entry', (file) => {
    expect(readFileSync(file, 'utf8').includes('writeAudit'), `${file} no longer audits`).toBe(true)
  })

  it('is the whole list, so a new audited read is a deliberate act', () => {
    const audited = getRoutes('server/api').filter(file => readFileSync(file, 'utf8').includes('writeAudit'))
    expect(audited.sort()).toEqual([...AUDITED_GETS].sort())
  })
})

describe('every account and user mutation is audited', () => {
  const files = ROOTS.flatMap(routeFiles)

  it('finds the routes to check', () => {
    expect(files.length).toBeGreaterThan(15)
  })

  it.each(files)('%s writes an audit entry', (file) => {
    if (EXEMPT[file]) {
      expect(EXEMPT[file]).toBeTruthy()
      return
    }

    const source = readFileSync(file, 'utf8')
    const audits = source.includes('writeAudit')
      || AUDITS_VIA.some(helper => source.includes(helper))

    expect(audits, `${file} mutates without an audit entry`).toBe(true)
  })
})
