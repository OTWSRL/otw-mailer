import { MailerError } from '../errors.ts'
import { field, request, textField } from '../http.ts'
import type { CreateTransport } from '../types.ts'
import { encoded, person, some } from './shared.ts'

/** MailerSend's settings. */
export interface MailerSendConfig {
  apiKey: string
  /** Whether the account's plan takes custom headers; sending them on a lower plan is refused. */
  customHeaders: boolean
}

const MAILER = 'MailerSend'

function explain(body: unknown): string | undefined {
  const errors = field(body, 'errors')
  const details =
    errors !== null && typeof errors === 'object' ? Object.values(errors).flat().join(' ') : ''
  return [textField(body, 'message'), details].filter(Boolean).join(' ') || undefined
}

/** MailerSend's Email API. */
export const create: CreateTransport<MailerSendConfig> = (config, context) => ({
  async send(email, signal) {
    const response = await request({
      mailer: MAILER,
      url: 'https://api.mailersend.com/v1/email',
      headers: { authorization: `Bearer ${config.apiKey}` },
      json: {
        from: person(email.from),
        to: email.to.map(person),
        cc: some(email.cc.map(person)),
        bcc: some(email.bcc.map(person)),
        reply_to: email.replyTo[0] ? person(email.replyTo[0]) : undefined,
        subject: email.subject,
        text: email.text ?? undefined,
        html: email.html ?? undefined,
        headers: config.customHeaders
          ? some(email.headers.map((header) => ({ name: header.name, value: header.value })))
          : undefined,
        attachments: some(
          email.attachments.map((file) => {
            const inline = file.cid !== null && email.html !== null
            return {
              content: encoded(file),
              filename: file.filename,
              disposition: inline ? 'inline' : 'attachment',
              ...(inline ? { id: file.cid } : {}),
            }
          }),
        ),
      },
      fetch: context.fetch,
      signal,
      explain,
    })
    const id = response.headers.get('x-message-id')
    const warnings = field(response.body, 'warnings')
    // Accepted, but with every recipient on a suppression list nothing is sent, and there's no id.
    if (!id && Array.isArray(warnings) && warnings.length > 0) {
      const kinds = warnings.map((warning) => textField(warning, 'type')).filter(Boolean)
      throw new MailerError(
        'rejected',
        `${MAILER} didn't send the email: ${kinds.join(', ') || textField(response.body, 'message')}.`,
        { mailer: MAILER, status: response.status },
      )
    }
    return { id }
  },
})
