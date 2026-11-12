import { MailerError, type MailerErrorCode } from '../errors.ts'
import { brief } from '../http.ts'
import { recipients } from '../message.ts'
import { toMime } from '../mime.ts'
import type { CreateTransport } from '../types.ts'

/** An SMTP server's settings. */
export interface SmtpConfig {
  host: string
  /** Defaults to 587 for TLS, 465 for SSL and 25 for none. */
  port?: number
  /** `tls` upgrades the connection with STARTTLS and refuses to send without it. */
  encryption: 'tls' | 'ssl' | 'none'
  /** With `none`, still encrypt when the server offers STARTTLS. */
  autoTls: boolean
  verifyCertificate: boolean
  /** Empty for a server without sign-in. */
  username?: string
  password?: string
}

const MAILER = 'SMTP'
const PORTS = { tls: 587, ssl: 465, none: 25 }

interface SmtpFailure {
  code?: string
  responseCode?: number
  response?: string
  message?: string
}

/** A certificate that can't be trusted, or a server that won't encrypt: settings to fix, not luck. */
const ENCRYPTION = /ETLS|CERT_|ERR_TLS|certificate|self.signed/i

function failure(error: unknown, signal: AbortSignal): MailerError {
  const { code, responseCode, response, message } = (error ?? {}) as SmtpFailure
  const said = brief(response ?? message ?? String(error))
  let kind: MailerErrorCode = 'network'
  let text = `Couldn't reach the SMTP server: ${said}`
  if (signal.aborted || code === 'ETIMEDOUT') {
    kind = 'timeout'
    text = `The SMTP server didn't answer in time.`
  } else if (ENCRYPTION.test(`${code} ${message}`)) {
    kind = 'rejected'
    text = `Couldn't make an encrypted connection to the SMTP server: ${said}`
  } else if (code === 'EAUTH' || [530, 534, 535].includes(responseCode ?? 0)) {
    kind = 'auth'
    text = `The SMTP server refused the sign-in: ${said}`
  } else if (responseCode !== undefined && responseCode >= 400) {
    // 4xx is the server asking to try later; 5xx is final.
    kind = responseCode >= 500 ? 'rejected' : 'unavailable'
    text = `The SMTP server refused the email: ${said}`
  }
  return new MailerError(kind, text, { mailer: MAILER, status: responseCode, cause: error })
}

/**
 * Any SMTP server, through Nodemailer, which is loaded on the first email. Each email opens a
 * connection and closes it: nothing is kept open between requests, which is what serverless
 * hosts need. TLS is at least 1.2, and the server's certificate is checked.
 */
export const create: CreateTransport<SmtpConfig> = (config) => {
  const open = async () => {
    const module = await import('nodemailer')
    // CommonJS: some loaders give its exports by name, others only as the default.
    const nodemailer = (module as unknown as { default?: typeof module }).default ?? module
    return nodemailer.createTransport({
      host: config.host,
      port: config.port || PORTS[config.encryption],
      secure: config.encryption === 'ssl',
      requireTLS: config.encryption === 'tls',
      ignoreTLS: config.encryption === 'none' && !config.autoTls,
      auth: config.username ? { user: config.username, pass: config.password ?? '' } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      tls: { rejectUnauthorized: config.verifyCertificate, minVersion: 'TLSv1.2' },
      // The message is built here, so Nodemailer never needs to read a file or fetch a URL.
      disableFileAccess: true,
      disableUrlAccess: true,
    })
  }

  const run = async <T>(
    signal: AbortSignal,
    task: (transport: Awaited<ReturnType<typeof open>>) => Promise<T>,
  ) => {
    const transport = await open()
    const stop = () => transport.close()
    signal.addEventListener('abort', stop, { once: true })
    try {
      return await task(transport)
    } catch (error) {
      throw failure(error, signal)
    } finally {
      signal.removeEventListener('abort', stop)
      transport.close()
    }
  }

  return {
    send: (email, signal) =>
      run(signal, async (transport) => {
        const info = await transport.sendMail({
          envelope: {
            from: email.returnPath ?? email.from.email,
            to: recipients(email).map((address) => address.email),
          },
          // Bcc recipients are in the envelope only, so no reader sees them.
          raw: toMime(email),
        })
        return { id: null, detail: brief(info.response) }
      }),
    verify: (signal) =>
      run(signal, async (transport) => {
        await transport.verify()
      }),
  }
}
