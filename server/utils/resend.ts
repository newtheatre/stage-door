import { Resend } from 'resend'

let client: Resend | null | undefined

/**
 * Lazily construct the Resend client.
 *
 * The key is read from `runtimeConfig.resendApiKey` (env `NUXT_RESEND_API_KEY`).
 * When no key is configured this returns `null` rather than throwing, so a
 * missing key degrades email to a console log (dev behaviour,
 * docs/development.md) instead of taking the Worker down at import time.
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
