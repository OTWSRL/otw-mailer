import { formatAddress } from '../address.ts'
import { field, request, textField } from '../http.ts'
import { splitAttachments } from '../message.ts'
import type { CreateTransport } from '../types.ts'
import { encoded, headerMap, some } from './shared.ts'

/** SparkPost's settings. */
export interface SparkPostConfig {
  apiKey: string
  region: 'us' | 'eu'
}

const MAILER = 'SparkPost'

function explain(body: unknown): string | undefined {
  const errors = field(body, 'errors')
  if (!Array.isArray(errors)) return undefined
  return errors
    .map((error) =>
      [textField(error, 'message'), textField(error, 'description')].filter(Boolean).join(': '),
    )
    .join(' ')
}

/**
 * SparkPost reads `{{ … }}` in the subject, bodies and headers as its template language. An
 * email's own braces are written the way that language writes a literal brace, so they arrive
 * as they were and never run as a template.
 */
function literal(text: string): string {
  return text.replace(/\{\{|\}\}/g, (braces) =>
    braces === '{{' ? '{{opening_double_curly()}}' : '{{closing_double_curly()}}',
  )
}

/**
 * SparkPost's Transmissions API. It has no cc or bcc of its own: every recipient is listed, and
 * `header_to` is the address their copy shows in `To`. One recipient keeps their name. Several,
 * or any copies, all show the same list of `To` addresses, and the `CC` header names those
 * copied.
 */
export const create: CreateTransport<SparkPostConfig> = (config, context) => ({
  async send(email, signal) {
    const { inline, files } = splitAttachments(email)
    const headers = Object.fromEntries(
      Object.entries(headerMap(email)).map(([name, value]) => [name, literal(value)]),
    )
    if (email.cc.length > 0) headers.CC = literal(email.cc.map(formatAddress).join(', '))
    const alone = email.to.length === 1 && email.cc.length === 0 && email.bcc.length === 0
    const shownTo = email.to.map((address) => address.email).join(', ')
    const recipients = alone
      ? [{ address: { email: email.to[0]!.email, name: email.to[0]!.name || undefined } }]
      : [...email.to, ...email.cc, ...email.bcc].map((address) => ({
          address: { email: address.email, header_to: shownTo },
        }))
    const host = config.region === 'eu' ? 'api.eu.sparkpost.com' : 'api.sparkpost.com'
    const response = await request({
      mailer: MAILER,
      url: `https://${host}/api/v1/transmissions`,
      headers: { authorization: config.apiKey },
      json: {
        recipients,
        content: {
          from: {
            email: email.from.email,
            name: email.from.name ? literal(email.from.name) : undefined,
          },
          subject: literal(email.subject),
          text: email.text === null ? undefined : literal(email.text),
          html: email.html === null ? undefined : literal(email.html),
          reply_to: email.replyTo[0] ? literal(formatAddress(email.replyTo[0])) : undefined,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          attachments: some(
            files.map((file) => ({
              name: file.filename,
              type: file.contentType,
              data: encoded(file),
            })),
          ),
          inline_images: some(
            inline.map((file) => ({ name: file.cid, type: file.contentType, data: encoded(file) })),
          ),
        },
      },
      fetch: context.fetch,
      signal,
      explain,
    })
    return { id: textField(field(response.body, 'results'), 'id') ?? null }
  },
})
