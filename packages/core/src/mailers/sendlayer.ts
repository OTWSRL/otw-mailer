import { field, request, textField } from '../http.ts'
import type { Address, CreateTransport } from '../types.ts'
import { encoded, headerMap, some } from './shared.ts'

/** SendLayer's settings. */
export interface SendLayerConfig {
  apiKey: string
}

const MAILER = 'SendLayer'

const contact = (address: Address) => ({ name: address.name || undefined, email: address.email })

function explain(body: unknown): string | undefined {
  const errors = field(body, 'Errors')
  if (!Array.isArray(errors)) return textField(body, 'Error') ?? textField(body, 'message')
  return errors
    .map((error) => textField(error, 'Message'))
    .filter(Boolean)
    .join(' ')
}

/** SendLayer's Email API. Attachments go as files only. */
export const create: CreateTransport<SendLayerConfig> = (config, context) => ({
  async send(email, signal) {
    const headers = headerMap(email)
    const response = await request({
      mailer: MAILER,
      url: 'https://console.sendlayer.com/api/v1/email',
      headers: { authorization: `Bearer ${config.apiKey}` },
      json: {
        From: contact(email.from),
        To: email.to.map(contact),
        CC: some(email.cc.map(contact)),
        BCC: some(email.bcc.map(contact)),
        ReplyTo: some(email.replyTo.map(contact)),
        Subject: email.subject,
        ContentType: email.html === null ? 'Text' : 'HTML',
        PlainContent: email.text ?? undefined,
        HTMLContent: email.html ?? undefined,
        Headers: Object.keys(headers).length > 0 ? headers : undefined,
        Attachments: some(
          email.attachments.map((file) => ({
            Content: encoded(file),
            Type: file.contentType,
            Filename: file.filename,
            Disposition: 'attachment',
          })),
        ),
      },
      fetch: context.fetch,
      signal,
      explain,
    })
    return { id: textField(response.body, 'MessageID') ?? null }
  },
})
