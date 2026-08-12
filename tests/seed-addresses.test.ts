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
