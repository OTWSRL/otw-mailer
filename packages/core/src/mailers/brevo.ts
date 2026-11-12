import { request, textField } from '../http.ts'
import type { CreateTransport } from '../types.ts'
import { encoded, headerMap, person, some } from './shared.ts'

/** Brevo's settings. */
export interface BrevoConfig {
  apiKey: string
}

const MAILER = 'Brevo'

/** Brevo's transactional email API. It takes one reply-to address, and attachments as files only. */
export const create: CreateTransport<BrevoConfig> = (config, context) => ({
  async send(email, signal) {
    const headers = headerMap(email)
    const response = await request({
      mailer: MAILER,
      url: 'https://api.brevo.com/v3/smtp/email',
      headers: { 'api-key': config.apiKey },
      json: {
        sender: person(email.from),
        to: email.to.map(person),
        cc: some(email.cc.map(person)),
        bcc: some(email.bcc.map(person)),
        replyTo: email.replyTo[0] ? person(email.replyTo[0]) : undefined,
        subject: email.subject,
        textContent: email.text ?? undefined,
        htmlContent: email.html ?? undefined,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        attachment: some(
          email.attachments.map((file) => ({ name: file.filename, content: encoded(file) })),
        ),
      },
      fetch: context.fetch,
      signal,
      explain: (body) => textField(body, 'message'),
    })
    return { id: textField(response.body, 'messageId') ?? null }
  },
})
