import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

/**
 * docs/api-reference.md states "All mutations [AUD]". Nothing enforced it, so
 * the audit log quietly lost a mutation whenever someone forgot the call.
 */
const ROOTS = ['server/api/account', 'server/api/users']

/** Helpers that write the entry themselves, so the handler need not. */
const AUDITS_VIA = ['eraseUser', 'mergeUsers']

/**
 * Mutations that deliberately write nothing, with the reason. Adding to this
 * list should take an argument; forgetting the call should not.
 */
const EXEMPT: Record<string, string> = {
  'server/api/account/mfa/totp.post.ts':
    'starts an unconfirmed enrolment that gates nothing; totp-confirm audits the act',
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return routeFiles(full)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.get.ts') ? [full] : []
  })
}

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
