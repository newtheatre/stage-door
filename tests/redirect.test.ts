import { describe, expect, it } from 'vitest'
import { validateRedirect } from '../shared/utils/validateRedirect'

const APEX = 'https://newtheatre.org.uk'

// Table-driven per docs/development.md#testing.
describe('redirect allowlist', () => {
  it.each([
    ['https://newtheatre.org.uk', 'https://newtheatre.org.uk'],
    ['https://newtheatre.org.uk/', 'https://newtheatre.org.uk/'],
    ['https://newtheatre.org.uk/whats-on', 'https://newtheatre.org.uk/whats-on'],
    ['https://rooms.newtheatre.org.uk/bookings?id=1', 'https://rooms.newtheatre.org.uk/bookings?id=1'],
    ['https://auth.newtheatre.org.uk/account', 'https://auth.newtheatre.org.uk/account'],
    ['https://some-new-app.newtheatre.org.uk', 'https://some-new-app.newtheatre.org.uk'],
  ])('allows %s', (input, expected) => {
    expect(validateRedirect(input)).toBe(expected)
  })

  it.each([
    ['http://newtheatre.org.uk'], // not https
    ['https://evil-newtheatre.org.uk'],
    ['https://newtheatre.org.uk.evil.com'],
    ['https://newtheatre.org.uk.evil.com/phish'],
    ['https://evil.com/newtheatre.org.uk'],
    ['javascript:alert(1)'],
    ['//evil.com'],
    ['https://sub.sub.newtheatre.org.uk'], // only one subdomain level allowed
    ['HTTPS://NEWTHEATRE.ORG.UK'], // conservative: case must match a real URL our apps emit
    [''],
    ['not a url'],
  ])('rejects %s to the apex', (input) => {
    expect(validateRedirect(input)).toBe(APEX)
  })

  it.each([
    [undefined],
    [null],
    [42],
    [['https://newtheatre.org.uk']],
  ])('rejects non-string %s to the apex', (input) => {
    expect(validateRedirect(input)).toBe(APEX)
  })
})
