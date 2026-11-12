import { MailerError } from '../errors.ts'
import { field, request, textField } from '../http.ts'
import { tokenSource, zohoHosts } from '../oauth.ts'
import type { CreateTransport, EmailAttachment } from '../types.ts'

/** Zoho Mail's settings: a Zoho OAuth client, its data center, and the account's tokens unless a store keeps them. */
export interface ZohoConfig {
  clientId: string
  clientSecret: string
  /** The data center, such as `com` or `eu`. */
  region: string
  refreshToken?: string
}

const MAILER = 'Zoho Mail'

const explain = (body: unknown) =>
  textField(field(body, 'data'), 'moreInfo') ??
  [textField(field(body, 'status'), 'description'), textField(field(body, 'data'), 'errorCode')]
    .filter(Boolean)
    .join(': ')

/**
 * Zoho Mail's API, sending as the connected account. It sends one body, the HTML when there is
 * one, and takes no reply-to or extra headers. Attachments are uploaded first, then named in the
 * message.
 */
export const create: CreateTransport<ZohoConfig> = (config, context) => {
  const { mail } = zohoHosts(config.region)
  const token = tokenSource('zoho', config, {
    fetch: context.fetch,
    store: context.tokens,
    refreshToken: config.refreshToken,
  })
  let account: string | undefined

  const call = async (
    signal: AbortSignal,
    path: string,
    init: { method?: 'GET' | 'POST'; json?: unknown; body?: BodyInit; type?: string } = {},
  ) =>
    request({
      mailer: MAILER,
      url: `https://${mail}/api/accounts${path}`,
      method: init.method ?? 'POST',
      headers: {
        authorization: `Zoho-oauthtoken ${await token(signal)}`,
        ...(init.type ? { 'content-type': init.type } : {}),
      },
      json: init.json,
      body: init.body,
      fetch: context.fetch,
      signal,
      explain,
    })

  const accountId = async (signal: AbortSignal): Promise<string> => {
    if (account) return account
    const response = await call(signal, '', { method: 'GET' })
    const accounts = field(response.body, 'data')
    const id = Array.isArray(accounts) ? textField(accounts[0], 'accountId') : undefined
    if (!id)
      throw new MailerError('auth', `${MAILER} found no mail account to send from.`, {
        mailer: MAILER,
      })
    return (account = id)
  }

  const upload = async (signal: AbortSignal, id: string, file: EmailAttachment) => {
    const response = await call(
      signal,
      `/${id}/messages/attachments?fileName=${encodeURIComponent(file.filename)}`,
      { body: file.content as Uint8Array<ArrayBuffer>, type: 'application/octet-stream' },
    )
    const stored = field(response.body, 'data')
    return {
      storeName: textField(stored, 'storeName'),
      attachmentPath: textField(stored, 'attachmentPath'),
      attachmentName: textField(stored, 'attachmentName'),
    }
  }

  return {
    async send(email, signal) {
      const id = await accountId(signal)
      const attachments = []
      for (const file of email.attachments) attachments.push(await upload(signal, id, file))
      const emails = (list: readonly { email: string }[]) =>
        list.length > 0 ? list.map((address) => address.email).join(',') : undefined
      const response = await call(signal, `/${id}/messages`, {
        json: {
          // Zoho documents an address of the account here, without a name.
          fromAddress: email.from.email,
          toAddress: emails(email.to),
          ccAddress: emails(email.cc),
          bccAddress: emails(email.bcc),
          subject: email.subject,
          content: email.html ?? email.text ?? '',
          mailFormat: email.html === null ? 'plaintext' : 'html',
          encoding: 'UTF-8',
          askReceipt: 'no',
          attachments: attachments.length > 0 ? attachments : undefined,
        },
      })
      return { id: textField(field(response.body, 'data'), 'messageId') ?? null }
    },
  }
}
