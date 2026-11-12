import { field, request, textField } from '../http.ts'
import { splitAttachments } from '../message.ts'
import type { CreateTransport } from '../types.ts'
import { encoded, headerMap, person, some } from './shared.ts'

/** SendGrid's settings. */
export interface SendGridConfig {
  apiKey: string
  region: 'global' | 'eu'
}

const MAILER = 'SendGrid'

function explain(body: unknown): string | undefined {
  const errors = field(body, 'errors')
  if (!Array.isArray(errors)) return undefined
  return errors
    .map((error) => textField(error, 'message'))
    .filter(Boolean)
    .join(' ')
}

/** SendGrid's v3 Mail Send API. */
export const create: CreateTransport<SendGridConfig> = (config, context) => ({
  async send(email, signal) {
    const { inline, files } = splitAttachments(email)
    const headers = headerMap(email)
    const response = await request({
      mailer: MAILER,
      url: `https://${config.region === 'eu' ? 'api.eu.sendgrid.com' : 'api.sendgrid.com'}/v3/mail/send`,
      headers: { authorization: `Bearer ${config.apiKey}` },
      json: {
        personalizations: [
          {
            to: email.to.map(person),
            cc: some(email.cc.map(person)),
            bcc: some(email.bcc.map(person)),
          },
        ],
        from: person(email.from),
        reply_to_list: some(email.replyTo.map(person)),
        subject: email.subject,
        // SendGrid wants text/plain before text/html, and refuses an empty part.
        content: [
          ...(email.text ? [{ type: 'text/plain', value: email.text }] : []),
          ...(email.html ? [{ type: 'text/html', value: email.html }] : []),
        ],
        attachments: some([
          ...files.map((file) => ({
            content: encoded(file),
            filename: file.filename,
            type: file.contentType,
            disposition: 'attachment',
          })),
          ...inline.map((file) => ({
            content: encoded(file),
            filename: file.filename,
            type: file.contentType,
            disposition: 'inline',
            content_id: file.cid,
          })),
        ]),
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      },
      fetch: context.fetch,
      signal,
      explain,
    })
    return { id: response.headers.get('x-message-id') }
  },
})
