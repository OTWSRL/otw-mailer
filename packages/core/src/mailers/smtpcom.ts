import { field, request, textField } from '../http.ts'
import type { Address, CreateTransport } from '../types.ts'
import { encoded, headerMap, some } from './shared.ts'

/** SMTP.com's settings. */
export interface SmtpComConfig {
  apiKey: string
  /** The sender (channel) to send through. */
  channel: string
}

const MAILER = 'SMTP.com'

const contact = (address: Address) => ({ name: address.name || undefined, address: address.email })

function explain(body: unknown): string | undefined {
  const data = field(body, 'data')
  if (typeof data === 'string') return data
  const errors = field(data, 'errors') ?? data
  return errors === undefined ? undefined : JSON.stringify(errors)
}

/** SMTP.com's v4 Messages API. */
export const create: CreateTransport<SmtpComConfig> = (config, context) => ({
  async send(email, signal) {
    const headers = headerMap(email)
    const response = await request({
      mailer: MAILER,
      url: 'https://api.smtp.com/v4/messages',
      headers: { authorization: `Bearer ${config.apiKey}` },
      json: {
        channel: config.channel,
        originator: {
          from: contact(email.from),
          reply_to: email.replyTo[0] ? contact(email.replyTo[0]) : undefined,
        },
        recipients: {
          to: email.to.map(contact),
          cc: some(email.cc.map(contact)),
          bcc: some(email.bcc.map(contact)),
        },
        subject: email.subject,
        body: {
          parts: [
            ...(email.text === null
              ? []
              : [{ type: 'text/plain', charset: 'UTF-8', content: email.text }]),
            ...(email.html === null
              ? []
              : [{ type: 'text/html', charset: 'UTF-8', content: email.html }]),
          ],
          attachments: some(
            email.attachments.map((file) => {
              const inline = file.cid !== null && email.html !== null
              return {
                content: encoded(file),
                type: file.contentType,
                filename: file.filename,
                disposition: inline ? 'inline' : 'attachment',
                ...(inline ? { cid: file.cid } : {}),
              }
            }),
          ),
        },
        custom_headers: Object.keys(headers).length > 0 ? headers : undefined,
      },
      fetch: context.fetch,
      signal,
      explain,
    })
    const data = field(response.body, 'data')
    const said = textField(data, 'message')
    // The id is `data.msg_id`; older answers carried it in words, "accepted msg_id=…".
    const id = textField(data, 'msg_id') ?? /msg_id[=:]\s*(\S+)/.exec(said ?? '')?.[1]
    return { id: id ?? null, detail: said }
  },
})
