import { formatAddress } from '../address.ts'
import { MailerError } from '../errors.ts'
import { request, textField } from '../http.ts'
import { splitAttachments } from '../message.ts'
import type { Address, CreateTransport } from '../types.ts'
import { encoded, headerMap, some } from './shared.ts'

/** Mandrill's settings. */
export interface MandrillConfig {
  apiKey: string
}

const MAILER = 'Mandrill'

const recipient = (type: 'to' | 'cc' | 'bcc') => (address: Address) => ({
  email: address.email,
  name: address.name || undefined,
  type,
})

/** Mandrill's Messages API. It answers per recipient, so one refused by all of them is an error. */
export const create: CreateTransport<MandrillConfig> = (config, context) => ({
  async send(email, signal) {
    const split = splitAttachments(email)
    // Mandrill shows only images inline; any other file with a content id goes as an attachment.
    const inline = split.inline.filter((file) => file.contentType.startsWith('image/'))
    const files = email.attachments.filter((file) => !inline.includes(file))
    const headers = headerMap(email)
    if (email.replyTo.length > 0) headers['Reply-To'] = email.replyTo.map(formatAddress).join(', ')
    const response = await request({
      mailer: MAILER,
      url: 'https://mandrillapp.com/api/1.4/messages/send',
      json: {
        key: config.apiKey,
        message: {
          from_email: email.from.email,
          from_name: email.from.name || undefined,
          to: [
            ...email.to.map(recipient('to')),
            ...email.cc.map(recipient('cc')),
            ...email.bcc.map(recipient('bcc')),
          ],
          subject: email.subject,
          text: email.text ?? undefined,
          html: email.html ?? undefined,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          attachments: some(
            files.map((file) => ({
              type: file.contentType,
              name: file.filename,
              content: encoded(file),
            })),
          ),
          images: some(
            inline.map((file) => ({
              type: file.contentType,
              name: file.cid,
              content: encoded(file),
            })),
          ),
        },
      },
      fetch: context.fetch,
      signal,
      explain: (body) => textField(body, 'message'),
    })
    const results: unknown[] = Array.isArray(response.body) ? response.body : []
    const refused = results.filter((result) =>
      ['rejected', 'invalid'].includes(textField(result, 'status') ?? ''),
    )
    if (results.length > 0 && refused.length === results.length) {
      const reason = textField(refused[0], 'reject_reason') ?? textField(refused[0], 'status')
      throw new MailerError('rejected', `${MAILER} refused the email: ${reason}.`, {
        mailer: MAILER,
        status: response.status,
      })
    }
    return { id: textField(results[0], '_id') ?? null }
  },
})
