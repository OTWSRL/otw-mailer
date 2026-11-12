import { request, textField } from '../http.ts'
import type { CreateTransport } from '../types.ts'
import { encoded, some, texts } from './shared.ts'

/** Postmark's settings. */
export interface PostmarkConfig {
  /** The server's API token. */
  apiKey: string
  messageStream: string
}

const MAILER = 'Postmark'

/** Postmark's Email API. */
export const create: CreateTransport<PostmarkConfig> = (config, context) => ({
  async send(email, signal) {
    const response = await request({
      mailer: MAILER,
      url: 'https://api.postmarkapp.com/email',
      headers: { 'x-postmark-server-token': config.apiKey },
      json: {
        From: texts([email.from])[0],
        To: texts(email.to).join(', '),
        Cc: some(texts(email.cc))?.join(', '),
        Bcc: some(texts(email.bcc))?.join(', '),
        ReplyTo: some(texts(email.replyTo))?.join(', '),
        Subject: email.subject,
        TextBody: email.text ?? undefined,
        HtmlBody: email.html ?? undefined,
        MessageStream: config.messageStream,
        Headers: some(email.headers.map((header) => ({ Name: header.name, Value: header.value }))),
        Attachments: some(
          email.attachments.map((file) => ({
            Name: file.filename,
            Content: encoded(file),
            ContentType: file.contentType,
            ...(file.cid !== null && email.html !== null ? { ContentID: `cid:${file.cid}` } : {}),
          })),
        ),
      },
      fetch: context.fetch,
      signal,
      explain: (body) => textField(body, 'Message'),
    })
    return {
      id: textField(response.body, 'MessageID') ?? null,
      detail: textField(response.body, 'Message'),
    }
  },
})
