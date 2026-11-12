import { field, request, textField } from '../http.ts'
import { MailerError } from '../errors.ts'
import { splitAttachments } from '../message.ts'
import type { Address, CreateTransport } from '../types.ts'
import { encoded, headerMap, some } from './shared.ts'

/** Mailjet's settings. */
export interface MailjetConfig {
  apiKey: string
  secretKey: string
}

const MAILER = 'Mailjet'

const contact = (address: Address) => ({ Email: address.email, Name: address.name || undefined })

/** The first message's errors, wherever Mailjet put them. */
function explain(body: unknown): string | undefined {
  const top = textField(body, 'ErrorMessage')
  if (top) return top
  const messages = field(body, 'Messages')
  const errors = Array.isArray(messages) ? field(messages[0], 'Errors') : undefined
  if (!Array.isArray(errors)) return undefined
  return errors
    .map((error) => textField(error, 'ErrorMessage'))
    .filter(Boolean)
    .join(' ')
}

/** Mailjet's Send API v3.1. */
export const create: CreateTransport<MailjetConfig> = (config, context) => ({
  async send(email, signal) {
    const { inline, files } = splitAttachments(email)
    const headers = headerMap(email)
    const response = await request({
      mailer: MAILER,
      url: 'https://api.mailjet.com/v3.1/send',
      headers: { authorization: `Basic ${btoa(`${config.apiKey}:${config.secretKey}`)}` },
      json: {
        Messages: [
          {
            From: contact(email.from),
            To: email.to.map(contact),
            Cc: some(email.cc.map(contact)),
            Bcc: some(email.bcc.map(contact)),
            ReplyTo: email.replyTo[0] ? contact(email.replyTo[0]) : undefined,
            Subject: email.subject,
            TextPart: email.text ?? undefined,
            HTMLPart: email.html ?? undefined,
            Headers: Object.keys(headers).length > 0 ? headers : undefined,
            Attachments: some(
              files.map((file) => ({
                ContentType: file.contentType,
                Filename: file.filename,
                Base64Content: encoded(file),
              })),
            ),
            InlinedAttachments: some(
              inline.map((file) => ({
                ContentType: file.contentType,
                Filename: file.filename,
                ContentID: file.cid,
                Base64Content: encoded(file),
              })),
            ),
          },
        ],
      },
      fetch: context.fetch,
      signal,
      explain,
    })
    const messages = field(response.body, 'Messages')
    const message: unknown = Array.isArray(messages) ? messages[0] : undefined
    if (textField(message, 'Status') === 'error') {
      throw new MailerError(
        'rejected',
        `${MAILER} refused the email: ${explain(response.body) ?? 'no reason given'}`,
        {
          mailer: MAILER,
          status: response.status,
        },
      )
    }
    const to = field(message, 'To')
    // MessageID is a 64-bit number, which JSON reading rounds; the UUID is text.
    const first: unknown = Array.isArray(to) ? to[0] : undefined
    return { id: textField(first, 'MessageUUID') ?? textField(first, 'MessageID') ?? null }
  },
})
