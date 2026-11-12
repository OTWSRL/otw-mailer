import { request, textField } from '../http.ts'
import type { CreateTransport } from '../types.ts'
import { encoded, headerMap, some, texts } from './shared.ts'

/** Resend's settings. */
export interface ResendConfig {
  apiKey: string
}

const MAILER = 'Resend'

/** Resend's Emails API. */
export const create: CreateTransport<ResendConfig> = (config, context) => ({
  async send(email, signal) {
    const headers = headerMap(email)
    const response = await request({
      mailer: MAILER,
      url: 'https://api.resend.com/emails',
      headers: { authorization: `Bearer ${config.apiKey}` },
      json: {
        from: texts([email.from])[0],
        to: email.to.map((address) => address.email),
        cc: some(email.cc.map((address) => address.email)),
        bcc: some(email.bcc.map((address) => address.email)),
        reply_to: some(email.replyTo.map((address) => address.email)),
        subject: email.subject,
        text: email.text ?? undefined,
        html: email.html ?? undefined,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        attachments: some(
          email.attachments.map((file) => ({
            filename: file.filename,
            content: encoded(file),
            content_type: file.contentType,
            ...(file.cid !== null && email.html !== null ? { content_id: file.cid } : {}),
          })),
        ),
      },
      fetch: context.fetch,
      signal,
      explain: (body) => textField(body, 'message'),
    })
    return { id: textField(response.body, 'id') ?? null }
  },
})
