import { formatAddress } from '../address.ts'
import { MailerError } from '../errors.ts'
import { field, request, textField } from '../http.ts'
import { splitAttachments } from '../message.ts'
import type { CreateTransport } from '../types.ts'
import { encoded, some, texts } from './shared.ts'

/** SMTP2GO's settings. */
export interface Smtp2goConfig {
  apiKey: string
}

const MAILER = 'SMTP2GO'

const explain = (body: unknown) =>
  textField(field(body, 'data'), 'error') ?? textField(field(body, 'data'), 'error_code')

/** SMTP2GO's email/send API. Reply-To travels as a custom header. */
export const create: CreateTransport<Smtp2goConfig> = (config, context) => ({
  async send(email, signal) {
    const { inline, files } = splitAttachments(email)
    const headers = email.headers.map((header) => ({ header: header.name, value: header.value }))
    if (email.replyTo.length > 0) {
      headers.push({ header: 'Reply-To', value: email.replyTo.map(formatAddress).join(', ') })
    }
    const response = await request({
      mailer: MAILER,
      url: 'https://api.smtp2go.com/v3/email/send',
      headers: { 'x-smtp2go-api-key': config.apiKey },
      json: {
        sender: formatAddress(email.from),
        to: texts(email.to),
        cc: some(texts(email.cc)),
        bcc: some(texts(email.bcc)),
        subject: email.subject,
        text_body: email.text ?? undefined,
        html_body: email.html ?? undefined,
        custom_headers: some(headers),
        attachments: some(
          files.map((file) => ({
            filename: file.filename,
            fileblob: encoded(file),
            mimetype: file.contentType,
          })),
        ),
        inlines: some(
          inline.map((file) => ({
            filename: file.cid,
            fileblob: encoded(file),
            mimetype: file.contentType,
          })),
        ),
      },
      fetch: context.fetch,
      signal,
      explain,
    })
    const data = field(response.body, 'data')
    if (field(data, 'succeeded') === 0) {
      const failures = field(data, 'failures')
      const reason =
        Array.isArray(failures) && failures.length > 0
          ? JSON.stringify(failures[0])
          : 'no reason given'
      throw new MailerError('rejected', `${MAILER} refused the email: ${reason}`, {
        mailer: MAILER,
        status: response.status,
      })
    }
    return { id: textField(data, 'email_id') ?? null }
  },
})
