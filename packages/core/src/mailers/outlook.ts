import { base64, utf8 } from '../encoding.ts'
import { MailerError } from '../errors.ts'
import { field, request, textField } from '../http.ts'
import { toMime } from '../mime.ts'
import { tokenSource } from '../oauth.ts'
import type { CreateTransport } from '../types.ts'

/** Microsoft 365's settings: an Entra app registration, and the account's tokens unless a store keeps them. */
export interface OutlookConfig {
  clientId: string
  clientSecret: string
  /** The directory (tenant) ID, or `common`. */
  tenant: string
  refreshToken?: string
}

const MAILER = 'Microsoft 365'
/** Microsoft Graph refuses a request larger than 4 MB. */
const MAX_REQUEST = 4_000_000

/**
 * Microsoft Graph's sendMail, sending as the connected account. The email goes as a base64 MIME
 * message, so both bodies, headers and inline files arrive as written. Graph answers with no id.
 */
export const create: CreateTransport<OutlookConfig> = (config, context) => {
  const token = tokenSource('microsoft', config, {
    fetch: context.fetch,
    store: context.tokens,
    refreshToken: config.refreshToken,
  })
  return {
    async send(email, signal) {
      const body = base64(utf8(toMime(email, { bcc: true })))
      if (body.length > MAX_REQUEST) {
        throw new MailerError(
          'rejected',
          `${MAILER} takes emails up to about 3 MB, attachments included. This one is larger.`,
          { mailer: MAILER },
        )
      }
      await request({
        mailer: MAILER,
        url: 'https://graph.microsoft.com/v1.0/me/sendMail',
        headers: { authorization: `Bearer ${await token(signal)}`, 'content-type': 'text/plain' },
        body,
        fetch: context.fetch,
        signal,
        explain: (body) => textField(field(body, 'error'), 'message'),
      })
      return { id: null }
    },
  }
}
