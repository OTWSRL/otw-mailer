import { field, request, textField } from '../http.ts'
import { toMime } from '../mime.ts'
import { tokenSource } from '../oauth.ts'
import type { CreateTransport } from '../types.ts'

/** Gmail's settings: a Google OAuth client, and the account's tokens unless a store keeps them. */
export interface GmailConfig {
  clientId: string
  clientSecret: string
  refreshToken?: string
}

const MAILER = 'Gmail'

/**
 * The Gmail API, sending as the connected account. The email goes as a MIME message through the
 * upload endpoint, which takes requests up to 35 MB. `Bcc` is in the message: Gmail sends to the
 * recipients its `To`, `Cc` and `Bcc` headers name.
 */
export const create: CreateTransport<GmailConfig> = (config, context) => {
  const token = tokenSource('google', config, {
    fetch: context.fetch,
    store: context.tokens,
    refreshToken: config.refreshToken,
  })
  return {
    async send(email, signal) {
      const response = await request({
        mailer: MAILER,
        url: 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media',
        headers: {
          authorization: `Bearer ${await token(signal)}`,
          'content-type': 'message/rfc822',
        },
        body: toMime(email, { bcc: true }),
        fetch: context.fetch,
        signal,
        explain: (body) => textField(field(body, 'error'), 'message'),
      })
      return { id: textField(response.body, 'id') ?? null }
    },
  }
}
