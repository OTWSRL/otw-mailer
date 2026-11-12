import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { OAuthTokens } from '@otwdesign/mailer'

/*
 * OAuth tokens (Gmail, Microsoft 365, Zoho) have to be stored: the service hands them over when
 * an administrator connects the account, and Microsoft replaces them as they're used. They're
 * kept encrypted with a key made from the connection's client secret, which lives only in the
 * site's environment. So a copy of the database alone gives nobody the tokens, and they're no use
 * without that secret anyway.
 */

const VERSION = 'v1'

function keyFor(clientSecret: string, connection: string): Buffer {
  return Buffer.from(hkdfSync('sha256', clientSecret, 'otw-mailer', `oauth:${connection}`, 32))
}

/** Tokens as one encrypted text (AES-256-GCM), for the connection's `auth` column. */
export function seal(tokens: OAuthTokens, clientSecret: string, connection: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(clientSecret, connection), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()])
  return [VERSION, iv, Buffer.concat([data, cipher.getAuthTag()])]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.')
}

/**
 * The tokens back, or `null` when they can't be read: the client secret changed, the text was
 * altered, or it belongs to another connection. The account then has to be connected again.
 */
export function unseal(
  sealed: string,
  clientSecret: string,
  connection: string,
): OAuthTokens | null {
  const [version, iv, body] = sealed.split('.')
  if (version !== VERSION || !iv || !body) return null
  try {
    const bytes = Buffer.from(body, 'base64url')
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyFor(clientSecret, connection),
      Buffer.from(iv, 'base64url'),
    )
    decipher.setAuthTag(bytes.subarray(bytes.length - 16))
    const text = Buffer.concat([
      decipher.update(bytes.subarray(0, bytes.length - 16)),
      decipher.final(),
    ]).toString('utf8')
    const tokens = JSON.parse(text) as OAuthTokens
    return typeof tokens.refreshToken === 'string' ? tokens : null
  } catch {
    return null
  }
}
