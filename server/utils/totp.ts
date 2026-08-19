/**
 * TOTP (RFC 6238) over Web Crypto: no dependency, no Node shims. The RFC's
 * test vectors are asserted in tests/totp.test.ts.
 */

const STEP_SECONDS = 30
const DIGITS = 6
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 without padding: the format authenticator apps expect. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) throw new Error('Invalid base32 character')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xFF)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** A fresh 20-byte (160-bit) secret, base32-encoded: the RFC 4226 size. */
export function generateTotpSecret(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  return base32Encode(bytes)
}

/** The time-step counter for a given moment. Exposed for replay checks. */
export function totpStep(at: number = Date.now()): number {
  return Math.floor(at / 1000 / STEP_SECONDS)
}

/**
 * `algorithm` is a parameter only so the RFC test vectors can be asserted;
 * authenticator apps all use SHA-1.
 */
export async function totpCode(
  secret: string,
  step: number = totpStep(),
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512' = 'SHA-1',
  digits: number = DIGITS,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secret) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  )

  // Counter as a big-endian 64-bit value.
  const counter = new Uint8Array(8)
  const view = new DataView(counter.buffer)
  view.setUint32(0, Math.floor(step / 2 ** 32))
  view.setUint32(4, step >>> 0)

  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter as unknown as ArrayBuffer))

  // Dynamic truncation (RFC 4226 §5.4).
  const offset = mac[mac.length - 1]! & 0x0F
  const binary
    = ((mac[offset]! & 0x7F) << 24)
      | ((mac[offset + 1]! & 0xFF) << 16)
      | ((mac[offset + 2]! & 0xFF) << 8)
      | (mac[offset + 3]! & 0xFF)

  return (binary % 10 ** digits).toString().padStart(digits, '0')
}

export interface TotpVerifyResult {
  valid: boolean
  /** The step the code matched: persist it to block replay within the window. */
  step?: number
}

/**
 * ±1 step of clock tolerance. `lastUsedStep` blocks replay: without it an
 * intercepted code could be used twice within its window.
 */
export async function verifyTotp(
  secret: string,
  submitted: string,
  opts: { at?: number, lastUsedStep?: number | null } = {},
): Promise<TotpVerifyResult> {
  const code = submitted.replace(/\s/g, '')
  if (!/^\d{6}$/.test(code)) return { valid: false }

  const current = totpStep(opts.at ?? Date.now())

  for (const step of [current, current - 1, current + 1]) {
    if (opts.lastUsedStep != null && step <= opts.lastUsedStep) continue
    if (await totpCode(secret, step) === code) return { valid: true, step }
  }

  return { valid: false }
}

/** The `otpauth://` URI an authenticator app scans (or you paste). */
export function totpUri(secret: string, accountEmail: string): string {
  const issuer = encodeURIComponent('NNT')
  const label = encodeURIComponent(accountEmail)
  return `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`
}
