import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isUndeliverableEmail } from '../server/utils/validation'

/**
 * Guards #16: the dev seed once used `@stage-door.test`, and reserved TLDs
 * are exactly what isUndeliverableEmail treats as anonymised placeholders —
 * so every seeded user vanished from /admin and couldn't register or reset.
 * The dev environment must not diverge from production that way.
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
 * Same guard, one level out: integrating-an-app.md is the template every new
 * estate app copies, so a reserved-TLD fixture in it reproduces #16 in each of
 * them rather than once here.
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
