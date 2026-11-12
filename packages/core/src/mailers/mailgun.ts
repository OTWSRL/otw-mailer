import { formatAddress } from '../address.ts'
import { request, textField } from '../http.ts'
import { splitAttachments } from '../message.ts'
import type { CreateTransport, EmailAttachment } from '../types.ts'
import { hostPart } from './shared.ts'

/** Mailgun's settings. */
export interface MailgunConfig {
  apiKey: string
  /** The sending domain, such as `mg.example.com`. */
  domain: string
  region: 'us' | 'eu'
}

const MAILER = 'Mailgun'

function blob(file: EmailAttachment): Blob {
  return new Blob([file.content as Uint8Array<ArrayBuffer>], { type: file.contentType })
}

/** Mailgun's Messages API, which takes a form. */
export const create: CreateTransport<MailgunConfig> = (config, context) => {
  const domain = hostPart(config.domain, 'The Mailgun domain', MAILER)
  const host = config.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net'
  return {
    async send(email, signal) {
      const form = new FormData()
      form.append('from', formatAddress(email.from))
      for (const address of email.to) form.append('to', formatAddress(address))
      for (const address of email.cc) form.append('cc', formatAddress(address))
      for (const address of email.bcc) form.append('bcc', formatAddress(address))
      form.append('subject', email.subject)
      if (email.text !== null) form.append('text', email.text)
      if (email.html !== null) form.append('html', email.html)
      if (email.replyTo.length > 0) {
        form.append('h:Reply-To', email.replyTo.map(formatAddress).join(', '))
      }
      for (const header of email.headers) form.append(`h:${header.name}`, header.value)
      const { inline, files } = splitAttachments(email)
      for (const file of files) form.append('attachment', blob(file), file.filename)
      // Mailgun's content id for an inline file is its file name.
      for (const file of inline) form.append('inline', blob(file), file.cid!)

      const response = await request({
        mailer: MAILER,
        url: `https://${host}/v3/${domain}/messages`,
        headers: { authorization: `Basic ${btoa(`api:${config.apiKey}`)}` },
        body: form,
        fetch: context.fetch,
        signal,
        explain: (body) => textField(body, 'message'),
      })
      return {
        id: textField(response.body, 'id') ?? null,
        detail: textField(response.body, 'message'),
      }
    },
  }
}
