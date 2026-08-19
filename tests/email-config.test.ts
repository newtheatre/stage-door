import { describe, expect, it, vi } from 'vitest'
import { sendEmail } from '../server/utils/email'

// import.meta.dev is undefined here, so this exercises the production branch.
describe('sendEmail without NUXT_RESEND_API_KEY', () => {
  it('fails loudly instead of logging the message', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(sendEmail({
      to: 'someone@example-user.co.uk',
      subject: 'Reset your password',
      html: '<a href="https://auth.newtheatre.org.uk/reset-password?token=live-token">link</a>',
    })).rejects.toMatchObject({ statusCode: 500 })

    // The body carries a working credential, so it must not reach the log.
    expect(spy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
