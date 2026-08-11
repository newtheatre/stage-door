/**
 * Timing-comparable password verification for login.
 *
 * Unknown users, guest (password-less) accounts, and disabled accounts must
 * be indistinguishable from a wrong password (docs/api-reference.md). The
 * response bodies are identical; this also burns a real scrypt verification
 * when there is no stored hash, so response *timing* doesn't separate
 * "no such account" from "wrong password".
 */

let dummyHash: string | undefined

async function getDummyHash(): Promise<string> {
  if (!dummyHash) {
    dummyHash = await hashPassword(`dummy-${crypto.randomUUID()}`)
  }
  return dummyHash
}

/**
 * Verify `password` against `storedHash`, or against a throwaway hash when
 * the account has none. Always performs exactly one scrypt verification.
 * Returns false whenever `storedHash` is null.
 */
export async function verifyPasswordGuarded(storedHash: string | null, password: string): Promise<boolean> {
  if (storedHash === null) {
    await verifyPassword(await getDummyHash(), password)
    return false
  }
  return verifyPassword(storedHash, password)
}
