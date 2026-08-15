import { Resend } from 'resend'

let client: Resend | null | undefined

/**
 * Returns null rather than throwing when no key is set, so email degrades to
 * a console log instead of taking the Worker down at import time.
 */
export function getResend(): Resend | null {
  if (client !== undefined) return client

  const key = useRuntimeConfig().resendApiKey
  if (!key) {
    client = null
    return null
  }

  client = new Resend(key)
  return client
}
