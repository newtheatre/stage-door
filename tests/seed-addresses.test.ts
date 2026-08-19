import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isUndeliverableEmail, UNDELIVERABLE_SUFFIXES } from '../server/utils/validation'

/**
 * Guards #16: a reserved TLD in the dev seed makes isUndeliverableEmail treat
 * every seeded user as an anonymised placeholder.
 */
describe('dev seed addresses', () => {
  const seedSource = readFileSync(join(import.meta.dirname, '../scripts/seed.ts'), 'utf8')
  const addresses = [...seedSource.matchAll(/email: '([^']+)'/g)].map(m => m[1]!)

  it('finds the seeded addresses', () => {
    expect(addresses.length).toBeGreaterThan(0)
  })

  it.each(addresses)('%s is deliverable (not a reserved TLD)', (address) => {
    expect(isUndeliverableEmail(address)).toBe(false)
  })
})

/**
 * The same guard one level out: integrating-an-app.md is the template every
 * new estate app copies, so a reserved-TLD fixture there reproduces #16 in each.
 */
describe('integration guide fixture addresses', () => {
  const guide = readFileSync(join(import.meta.dirname, '../docs/integrating-an-app.md'), 'utf8')
  const addresses = [...guide.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map(m => m[0])

  it('finds the fixture addresses', () => {
    expect(addresses.length).toBeGreaterThan(0)
  })

  it.each(addresses)('%s is deliverable (not a reserved TLD)', (address) => {
    expect(isUndeliverableEmail(address)).toBe(false)
  })
})

describe('the undeliverable list has one source', () => {
  it('drives both the JS guard and the SQL filter', () => {
    // Adding a domain to one and not the other used to half-apply the policy:
    // either anonymised rows reappear in admin lists, or a blocked address is
    // still treated as mailable.
    for (const suffix of UNDELIVERABLE_SUFFIXES) {
      expect(isUndeliverableEmail(`someone${suffix.startsWith('@') ? '' : '@host'}${suffix}`)).toBe(true)
    }
    expect(isUndeliverableEmail('real@example-user.co.uk')).toBe(false)
  })

  it('matches case-insensitively, as the anonymised rows arrive', () => {
    expect(isUndeliverableEmail('Deleted-123@ANONYMISED.INVALID')).toBe(true)
  })
})
