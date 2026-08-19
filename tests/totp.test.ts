import { describe, expect, it } from 'vitest'
import { base32Encode, base32Decode, totpCode, totpStep, verifyTotp, generateTotpSecret, totpUri } from '../server/utils/totp'

const b32 = (ascii: string) => base32Encode(new TextEncoder().encode(ascii))

// RFC 6238 Appendix B. Each algorithm has its own seed length; the vectors
// are 8-digit codes, hence the explicit `digits` argument.
const SEEDS = {
  'SHA-1': b32('12345678901234567890'),
  'SHA-256': b32('12345678901234567890123456789012'),
  'SHA-512': b32('1234567890123456789012345678901234567890123456789012345678901234'),
} as const

const VECTORS: [number, string, string, string][] = [
  // time (s), SHA-1, SHA-256, SHA-512
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
]

describe('TOTP (RFC 6238)', () => {
  it.each(VECTORS)('matches the published vectors at T=%i', async (time, sha1, sha256, sha512) => {
    const step = totpStep(time * 1000)
    expect(await totpCode(SEEDS['SHA-1'], step, 'SHA-1', 8)).toBe(sha1)
    expect(await totpCode(SEEDS['SHA-256'], step, 'SHA-256', 8)).toBe(sha256)
    expect(await totpCode(SEEDS['SHA-512'], step, 'SHA-512', 8)).toBe(sha512)
  })

  it('round-trips base32 and rejects rubbish', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes))
    expect(() => base32Decode('not-base32!')).toThrow()
  })

  it('generates a 160-bit secret', () => {
    const secret = generateTotpSecret()
    expect(base32Decode(secret)).toHaveLength(20)
    expect(secret).not.toBe(generateTotpSecret())
  })

  it('puts the secret and parameters in the otpauth URI', () => {
    const uri = totpUri('JBSWY3DPEHPK3PXP', 'someone@example.com')
    expect(uri).toContain('otpauth://totp/NNT:someone%40example.com')
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP')
    expect(uri).toContain('digits=6&period=30')
  })
})

describe('verifyTotp', () => {
  const secret = SEEDS['SHA-1']
  const at = 1111111111000

  it('accepts the current code and reports the step it matched', async () => {
    const step = totpStep(at)
    const result = await verifyTotp(secret, await totpCode(secret, step), { at })
    expect(result).toEqual({ valid: true, step })
  })

  it('tolerates a clock one step either side, but not two', async () => {
    const step = totpStep(at)
    expect((await verifyTotp(secret, await totpCode(secret, step - 1), { at })).valid).toBe(true)
    expect((await verifyTotp(secret, await totpCode(secret, step + 1), { at })).valid).toBe(true)
    expect((await verifyTotp(secret, await totpCode(secret, step - 2), { at })).valid).toBe(false)
    expect((await verifyTotp(secret, await totpCode(secret, step + 2), { at })).valid).toBe(false)
  })

  it('refuses a code from a step already used: a code is valid for 30s, once', async () => {
    const step = totpStep(at)
    const code = await totpCode(secret, step)

    expect((await verifyTotp(secret, code, { at })).valid).toBe(true)
    expect((await verifyTotp(secret, code, { at, lastUsedStep: step })).valid).toBe(false)
    // The tolerance window cannot be walked backwards either.
    expect((await verifyTotp(secret, await totpCode(secret, step - 1), { at, lastUsedStep: step })).valid).toBe(false)
    // The next step still works.
    expect((await verifyTotp(secret, await totpCode(secret, step + 1), { at, lastUsedStep: step })).valid).toBe(true)
  })

  it('rejects anything that is not six digits without hashing', async () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
      expect((await verifyTotp(secret, bad, { at })).valid).toBe(false)
    }
  })
})
