/**
 * Unknown, guest and disabled accounts must be indistinguishable from a
 * wrong password — in timing as well as in the response body.
 */

let dummyHash: string | undefined

async function getDummyHash(): Promise<string> {
  if (!dummyHash) {
    dummyHash = await hashPassword(`dummy-${crypto.randomUUID()}`)
  }
  return dummyHash
}

/**
 * Always performs exactly one scrypt verification, against a throwaway hash
 * when the account has none. False whenever `storedHash` is null.
 */
export async function verifyPasswordGuarded(storedHash: string | null, password: string): Promise<boolean> {
  if (storedHash === null) {
    await verifyPassword(await getDummyHash(), password)
    return false
  }
  return verifyPassword(storedHash, password)
}
