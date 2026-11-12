import { MailerError, type MailerErrorCode } from './errors.ts'

/** A request to a mail service's API. */
export interface HttpRequest {
  /** The mailer's label, for error messages. */
  mailer: string
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** Sent as JSON. */
  json?: unknown
  /** Sent as it is, when `json` isn't given. */
  body?: BodyInit
  fetch: typeof fetch
  signal: AbortSignal
  /** Picks the service's own words out of an error answer. */
  explain?(body: unknown): string | undefined
  /** Names the kind of error when the status alone doesn't say, as a throttle answered with 400. */
  classify?(status: number, body: unknown): MailerErrorCode | undefined
}

/** A service's answer: its status, headers, and body, parsed when it's JSON. */
export interface HttpResponse {
  status: number
  headers: Headers
  body: unknown
}

const MAX_DETAIL = 300

/** An answer's words on one line, cut short: enough to act on, and never a page of HTML. */
export function brief(value: unknown): string {
  const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL)}…` : line
}

function codeFor(status: number): MailerErrorCode {
  if (status === 401 || status === 403) return 'auth'
  // Mailgun answers 420 for its recipients rate limit.
  if (status === 429 || status === 420) return 'rate-limited'
  if (status === 408 || status >= 500) return 'unavailable'
  return 'rejected'
}

function parse(text: string, type: string | null): unknown {
  if (!text) return undefined
  if (type?.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

/**
 * Calls a mail service and returns its answer, or throws a `MailerError` that says what went
 * wrong in the service's own words. Redirects are refused, so a key is never sent on to another
 * host. Nothing from the request (its headers, its body) is ever put in an error.
 */
export async function request(options: HttpRequest): Promise<HttpResponse> {
  const { mailer, signal } = options
  const headers = new Headers(options.headers)
  let body = options.body
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(options.json)
  }
  if (!headers.has('accept')) headers.set('accept', 'application/json')
  // Some services (Resend) refuse a request that doesn't say who's calling.
  if (!headers.has('user-agent')) headers.set('user-agent', 'otw-mailer')

  let response: Response
  let text: string
  try {
    response = await options.fetch(options.url, {
      method: options.method ?? 'POST',
      headers,
      body,
      signal,
      redirect: 'error',
    })
    text = await response.text()
  } catch (error) {
    if (signal.aborted) {
      throw new MailerError('timeout', `${mailer} didn't answer in time.`, { mailer, cause: error })
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new MailerError('network', `Couldn't reach ${mailer}: ${brief(reason)}`, {
      mailer,
      cause: error,
    })
  }

  const parsed = parse(text, response.headers.get('content-type'))
  if (!response.ok) {
    const said = options.explain?.(parsed) ?? brief(parsed)
    throw new MailerError(
      options.classify?.(response.status, parsed) ?? codeFor(response.status),
      `${mailer} refused the email (HTTP ${response.status})${said ? `: ${brief(said)}` : '.'}`,
      { mailer, status: response.status },
    )
  }
  return { status: response.status, headers: response.headers, body: parsed }
}

/** A value's property, when the value is an object: for reading answers of unknown shape. */
export function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined
}

/** A value's property when it's text or a number, as text. */
export function textField(value: unknown, key: string): string | undefined {
  const found = field(value, key)
  if (typeof found === 'string') return found
  return typeof found === 'number' ? String(found) : undefined
}
