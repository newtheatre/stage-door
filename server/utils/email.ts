/**
 * Email sending via Resend (docs/architecture.md#components).
 *
 * Dev mode (no `NUXT_RESEND_API_KEY`): emails are logged to the console
 * instead of sent — docs/development.md.
 */

import { getResend } from './resend'

interface SendEmailOptions {
  to: string
  subject: string
  html: string
}

/** Send an email via Resend, or log it to the console when no key is set. */
export async function sendEmail({ to, subject, html }: SendEmailOptions): Promise<void> {
  const resend = getResend()
  if (!resend) {
    console.info(`[Email:dev] To: ${to}\n[Email:dev] Subject: ${subject}\n[Email:dev] ${html}`)
    return
  }

  const resendFromEmail = useRuntimeConfig().resendFromEmail
  const { error } = await resend.emails.send({
    from: resendFromEmail || 'auth@newtheatre.org.uk',
    to,
    subject,
    html,
  })

  if (error) {
    console.error('[Email] Failed to send email:', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to send email',
    })
  }
}

function emailLayout(body: string): string {
  return `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
      <p style="font-weight: 700; font-size: 18px;">The Nottingham New Theatre</p>
      ${body}
      <p style="margin-top: 32px; font-size: 13px; color: #666;">
        This email is about your NNT account. If you weren't expecting it, you can safely ignore it.
      </p>
    </div>
  `
}

/** Send an email verification link. */
export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const { public: { baseURL } } = useRuntimeConfig()
  const url = `${baseURL}/verify-email?token=${token}`

  await sendEmail({
    to: email,
    subject: 'Verify your email address',
    html: emailLayout(`
      <p>Click the link below to verify your email address:</p>
      <p><a href="${url}">${url}</a></p>
      <p>The link is valid for 24 hours.</p>
    `),
  })
}

/** Send a password reset link. */
export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const { public: { baseURL } } = useRuntimeConfig()
  const url = `${baseURL}/reset-password?token=${token}`

  await sendEmail({
    to: email,
    subject: 'Reset your password',
    html: emailLayout(`
      <p>Click the link below to reset your NNT account password:</p>
      <p><a href="${url}">${url}</a></p>
      <p>The link is valid for one hour. If you didn't request this, no action is needed.</p>
    `),
  })
}

/**
 * Sent when someone tries to register with an email that already has a full
 * account — instead of a duplicate-account error, which would let anyone
 * enumerate registered addresses (docs/api-reference.md#post-apiauthregister).
 */
export async function sendAccountExistsEmail(email: string): Promise<void> {
  const { public: { baseURL } } = useRuntimeConfig()

  await sendEmail({
    to: email,
    subject: 'You already have an NNT account',
    html: emailLayout(`
      <p>Someone (hopefully you) tried to create an NNT account with this address — but you already have one.</p>
      <p>You can <a href="${baseURL}/login">log in here</a>, or
      <a href="${baseURL}/forgot-password">reset your password</a> if you've forgotten it.</p>
    `),
  })
}
