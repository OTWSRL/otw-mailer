/**
 * Why an email wasn't sent. `auth` and `rejected` need a person: the settings or the message are
 * wrong. `rate-limited`, `unavailable`, `network` and `timeout` may pass on another try.
 */
export type MailerErrorCode =
  | 'invalid-message'
  | 'not-configured'
  | 'auth'
  | 'rejected'
  | 'rate-limited'
  | 'unavailable'
  | 'network'
  | 'timeout'

const RETRYABLE: ReadonlySet<MailerErrorCode> = new Set([
  'rate-limited',
  'unavailable',
  'network',
  'timeout',
])

/** An email that couldn't be sent, and why. Its message never holds a key or a password. */
export class MailerError extends Error {
  readonly code: MailerErrorCode
  /** The mailer that failed, when one was reached. */
  readonly mailer: string | null
  /** The service's HTTP or SMTP status, when it answered. */
  readonly status: number | null

  constructor(
    code: MailerErrorCode,
    message: string,
    options: { mailer?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MailerError'
    this.code = code
    this.mailer = options.mailer ?? null
    this.status = options.status ?? null
  }

  /** Whether the same email may go through on another try. */
  get retryable(): boolean {
    return RETRYABLE.has(this.code)
  }
}

/** The message's own fault: throws the error every check uses. */
export function invalid(message: string): never {
  throw new MailerError('invalid-message', `Can't send this email: ${message}`)
}
