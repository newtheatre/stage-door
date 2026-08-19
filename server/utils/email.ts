/**
 * Email via Resend. In development only, a missing `NUXT_RESEND_API_KEY`
 * logs the message instead; in production it is a hard failure.
 */

import { getResend } from './resend'

interface SendEmailOptions {
  to: string
  subject: string
  html: string
}

/** Send an email via Resend, or log it to the console in dev with no key set. */
export async function sendEmail({ to, subject, html }: SendEmailOptions): Promise<void> {
  const resend = getResend()
  if (!resend) {
    // The body carries live reset and magic-link tokens, so logging it in
    // production would put working credentials in the log stream.
    if (!import.meta.dev) {
      console.error('[Email] NUXT_RESEND_API_KEY is not set: refusing to send')
      throw createError({ statusCode: 500, statusMessage: 'Email is not configured' })
    }
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

/** Send a magic sign-in link (ADR-0013). */
export async function sendMagicLinkEmail(email: string, token: string, redirect?: string): Promise<void> {
  const { public: { baseURL } } = useRuntimeConfig()
  const url = `${baseURL}/magic-link?token=${token}${redirect ? `&redirect=${encodeURIComponent(redirect)}` : ''}`

  await sendEmail({
    to: email,
    subject: 'Your NNT sign-in link',
    html: emailLayout(`
      <p>Click the link below to sign in to your NNT account:</p>
      <p><a href="${url}">${url}</a></p>
      <p>The link works once and expires in 15 minutes. If you didn't request it, no action is needed: nobody can sign in without it.</p>
    `),
  })
}

/** Role expiry warning to the holder: 14 days out (ADR-0011). */
export async function sendRoleExpiryWarningEmail(
  email: string,
  grants: { role: string, expiresAt: number }[],
): Promise<void> {
  const rows = grants
    .map(g => `<li><code>${g.role}</code>: expires ${formatDateLong(g.expiresAt)}</li>`)
    .join('')

  await sendEmail({
    to: email,
    subject: grants.length === 1 ? 'Your NNT role is expiring soon' : 'Some of your NNT roles are expiring soon',
    html: emailLayout(`
      <p>The following role${grants.length === 1 ? '' : 's'} on your NNT account will expire soon:</p>
      <ul>${rows}</ul>
      <p>Most roles run for a committee year and lapse automatically at handover.
      If you're continuing in the role, ask the IT Manager to renew it: it takes one click.
      If you're handing over, no action is needed.</p>
    `),
  })
}

/** Role expiry digest to the ITM: the renew-or-let-lapse prompt. */
export async function sendRoleExpiryDigestEmail(
  to: string,
  warned: { email: string, role: string, expiresAt: number }[],
): Promise<void> {
  const rows = warned
    .map(w => `<li>${w.email}: <code>${w.role}</code> expires ${formatDate(w.expiresAt)}</li>`)
    .join('')

  await sendEmail({
    to,
    subject: 'NNT role expiry digest: renew or let lapse',
    html: emailLayout(`
      <p>These role grants enter their expiry window today and the holders have been warned:</p>
      <ul>${rows}</ul>
      <p>Renew any that should continue (edit the expiry date on the user's admin page);
      the rest lapse automatically: that's the point.</p>
    `),
  })
}

/** Daily digest: grants that reference nothing an app reads (ADR-0023). */
export async function sendSuspectGrantsEmail(
  to: string,
  suspects: { role: string, holders: number, explanation: string }[],
): Promise<void> {
  const rows = suspects
    .map(s => `<li><code>${s.role}</code>: ${s.holders} holder${s.holders === 1 ? '' : 's'}. ${s.explanation}</li>`)
    .join('')

  await sendEmail({
    to,
    subject: 'NNT roles: grants that do nothing',
    html: emailLayout(`
      <p>These role grants are held by real accounts but match nothing any app
      reads, so they confer no access and never will:</p>
      <ul>${rows}</ul>
      <p>Either revoke them, or define the role if it was meant to work.
      Dormant namespaces are excluded, so nothing here is deliberate history.</p>
    `),
  })
}

/** Retention sweep: "log in to keep your account" warning (docs/gdpr-retention.md). */
export async function sendRetentionWarningEmail(email: string, daysLeft: number): Promise<void> {
  const { public: { baseURL } } = useRuntimeConfig()

  await sendEmail({
    to: email,
    subject: `Your NNT account will be closed in ${daysLeft} days`,
    html: emailLayout(`
      <p>Your Nottingham New Theatre account hasn't been used for over two years.
      Under our data retention policy it will be <strong>closed and anonymised in ${daysLeft} days</strong>.</p>
      <p>Want to keep it? Just <a href="${baseURL}/login">log in</a>: that's all it takes.</p>
      <p>If you'd rather it were closed, no action is needed. Your booking history is
      kept anonymously for the theatre's records; your personal details are removed.</p>
    `),
  })
}

/** Retention sweep digest to the Archivist: its absence is an alert. */
export async function sendRetentionDigestEmail(to: string, summary: Record<string, unknown>): Promise<void> {
  const dryRun = summary.dryRun === true

  await sendEmail({
    to,
    subject: `${dryRun ? '[DRY RUN] ' : ''}NNT retention sweep digest`,
    html: emailLayout(`
      <p>${dryRun
        ? 'The retention sweep ran in <strong>dry-run</strong> mode: nothing was changed. Review and set dryRun: false in retention.config to arm it.'
        : 'The retention sweep ran.'}</p>
      <pre style="background:#f5f5f4;padding:12px;border-radius:8px;font-size:12px;">${JSON.stringify(summary, null, 2)}</pre>
      <p style="font-size:13px;color:#666;">Full detail is in the audit log (action: retention.${dryRun ? 'dry-run' : 'sweep'}).</p>
    `),
  })
}

/**
 * Sent instead of a duplicate-account error, which would let anyone
 * enumerate registered addresses.
 */
export async function sendAccountExistsEmail(email: string): Promise<void> {
  const { public: { baseURL } } = useRuntimeConfig()

  await sendEmail({
    to: email,
    subject: 'You already have an NNT account',
    html: emailLayout(`
      <p>Someone (hopefully you) tried to create an NNT account with this address, but you already have one.</p>
      <p>You can <a href="${baseURL}/login">log in here</a>, or
      <a href="${baseURL}/forgot-password">reset your password</a> if you've forgotten it.</p>
    `),
  })
}
