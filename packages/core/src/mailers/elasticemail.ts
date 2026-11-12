import { formatAddress } from '../address.ts'
import { request, textField } from '../http.ts'
import type { CreateTransport } from '../types.ts'
import { encoded, headerMap, some, texts } from './shared.ts'

/** Elastic Email's settings. */
export interface ElasticEmailConfig {
  apiKey: string
}

const MAILER = 'Elastic Email'

/** Elastic Email's v4 transactional API. Attachments go as files only. */
export const create: CreateTransport<ElasticEmailConfig> = (config, context) => ({
  async send(email, signal) {
    const headers = headerMap(email)
    const response = await request({
      mailer: MAILER,
      url: 'https://api.elasticemail.com/v4/emails/transactional',
      headers: { 'x-elasticemail-apikey': config.apiKey },
      json: {
        Recipients: {
          To: texts(email.to),
          CC: some(texts(email.cc)),
          BCC: some(texts(email.bcc)),
        },
        Content: {
          From: formatAddress(email.from),
          ReplyTo: email.replyTo[0] ? formatAddress(email.replyTo[0]) : undefined,
          Subject: email.subject,
          Body: [
            ...(email.html === null
              ? []
              : [{ ContentType: 'HTML', Content: email.html, Charset: 'utf-8' }]),
            ...(email.text === null
              ? []
              : [{ ContentType: 'PlainText', Content: email.text, Charset: 'utf-8' }]),
          ],
          Headers: Object.keys(headers).length > 0 ? headers : undefined,
          Attachments: some(
            email.attachments.map((file) => ({
              BinaryContent: encoded(file),
              Name: file.filename,
              ContentType: file.contentType,
            })),
          ),
        },
      },
      fetch: context.fetch,
      signal,
      explain: (body) => textField(body, 'Error'),
    })
    return {
      id:
        textField(response.body, 'MessageID') ?? textField(response.body, 'TransactionID') ?? null,
    }
  },
})
