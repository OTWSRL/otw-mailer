import { MailerError } from './errors.ts'
import { loadTransport } from './load.ts'
import { mailerInfo } from './registry.ts'
import { prepare, type Defaults } from './message.ts'
import { routeFor } from './routing.ts'
import type { Attempt, Connection, Delivery, Email, Message, Route, Transport } from './types.ts'

/** How a mailer sends: its connections, which one sends, and what every email gets. */
export interface MailerOptions extends Defaults {
  /** At least one. Their mailers' code loads when they first send. */
  connections: readonly Connection[]
  /** The connection email goes through. Defaults to the first. */
  primary?: string
  /** Tried when the first choice fails. */
  backup?: string
  /** Rules that send matching emails through another connection, first match first. */
  routes?: readonly Route[]
  /** How long one try may take. Defaults to 20 seconds. */
  timeoutMs?: number
  /** Defaults to the runtime's own. */
  fetch?: typeof fetch
}

/** How one email is sent. */
export interface SendOptions {
  /** Sends through this connection only: no routing rules, no backup. For a test email. */
  connection?: string
  /** Stops the send, as a request that was cancelled would. */
  signal?: AbortSignal
}

/** Sends email through its connections. */
export interface Mailer {
  /**
   * Sends an email, through the backup connection if the first fails. Throws a `MailerError`
   * with code `invalid-message` for a message that isn't valid, and a `DeliveryError` when no
   * connection took it.
   */
  send(message: Message, options?: SendOptions): Promise<Delivery>
  /** The connection that would send this email: its routing rule's, or the primary. */
  route(email: Email): string
  /** Checks a connection's settings without sending. SMTP signs in; services check on send. */
  verify(connection?: string, signal?: AbortSignal): Promise<void>
}

/** An email no connection took, with every try and why it failed. */
export class DeliveryError extends MailerError {
  readonly email: Email
  readonly attempts: Attempt[]

  constructor(email: Email, attempts: Attempt[], last: MailerError) {
    const failures = attempts.map((attempt) => attempt.error?.message ?? '').filter(Boolean)
    const message =
      failures.length > 1
        ? `${failures[0]} The backup connection failed too: ${failures.at(-1)}`
        : (failures[0] ?? last.message)
    super(last.code, message, {
      mailer: last.mailer ?? undefined,
      status: last.status ?? undefined,
      cause: last,
    })
    this.name = 'DeliveryError'
    this.email = email
    this.attempts = attempts
  }
}

const DEFAULT_TIMEOUT = 20_000

function asMailerError(error: unknown): MailerError {
  if (error instanceof MailerError) return error
  const reason = error instanceof Error ? error.message : String(error)
  return new MailerError('unavailable', `The email couldn't be sent: ${reason}`, { cause: error })
}

/** A connection's keys and passwords, as its mailer's fields mark them. */
function secretsOf(connection: Connection | undefined): string[] {
  const fields = connection ? (mailerInfo(connection.mailer)?.fields ?? []) : []
  return fields
    .filter((item) => item.type === 'secret')
    .map((item) => connection!.config[item.name])
    .filter((value): value is string => typeof value === 'string' && value.length >= 6)
}

/**
 * The error with the connection's secrets taken out of its words. Some services repeat the key
 * they were sent when they refuse it, and an error's message goes into logs and onto screens.
 */
function withoutSecrets(error: MailerError, secrets: readonly string[]): MailerError {
  let message = error.message
  for (const secret of secrets) message = message.replaceAll(secret, '[secret]')
  if (message === error.message) return error
  return new MailerError(error.code, message, {
    mailer: error.mailer ?? undefined,
    status: error.status ?? undefined,
  })
}

/**
 * A mailer over one or more connections. Creating it loads nothing and opens nothing: a
 * connection's mailer is imported the first time an email goes through it.
 */
export function createMailer(options: MailerOptions): Mailer {
  const connections = new Map(options.connections.map((connection) => [connection.id, connection]))
  const transports = new Map<string, Promise<Transport>>()
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init))
  const primary = options.primary ?? options.connections[0]?.id

  const connectionFor = (id: string | undefined): Connection => {
    if (!id) throw new MailerError('not-configured', 'No connection is set up to send email.')
    const connection = connections.get(id)
    if (!connection) throw new MailerError('not-configured', `There is no connection "${id}".`)
    return connection
  }

  const transportFor = (connection: Connection): Promise<Transport> => {
    let transport = transports.get(connection.id)
    if (!transport) {
      transport = loadTransport(connection, { fetch: fetcher })
      transports.set(connection.id, transport)
      // A failed load (settings missing) is tried again next time, not remembered.
      transport.catch(() => transports.delete(connection.id))
    }
    return transport
  }

  const signalFor = (signal: AbortSignal | undefined): AbortSignal => {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT)
    return signal ? AbortSignal.any([signal, timeout]) : timeout
  }

  const attempt = async (
    id: string,
    email: Email,
    signal: AbortSignal | undefined,
  ): Promise<{ attempt: Attempt; error: MailerError | null }> => {
    const started = performance.now()
    const done = (
      mailer: Attempt['mailer'],
      rest: Pick<Attempt, 'ok' | 'providerId' | 'detail' | 'error'>,
    ) => ({
      connection: id,
      mailer,
      durationMs: Math.round(performance.now() - started),
      ...rest,
    })
    let mailer = connections.get(id)?.mailer ?? ('smtp' as Attempt['mailer'])
    try {
      const connection = connectionFor(id)
      mailer = connection.mailer
      const transport = await transportFor(connection)
      const receipt = await transport.send(email, signalFor(signal))
      return {
        attempt: done(mailer, {
          ok: true,
          providerId: receipt.id,
          detail: receipt.detail ?? null,
          error: null,
        }),
        error: null,
      }
    } catch (caught) {
      const error = withoutSecrets(asMailerError(caught), secretsOf(connections.get(id)))
      return {
        attempt: done(mailer, {
          ok: false,
          providerId: null,
          detail: null,
          error: { code: error.code, message: error.message, status: error.status },
        }),
        error,
      }
    }
  }

  const route = (email: Email): string => {
    const routed = routeFor(email, options.routes ?? [])
    // A rule that names a connection since removed falls back to the primary.
    return connectionFor(routed && connections.has(routed) ? routed : primary).id
  }

  return {
    route,

    async send(message, sendOptions = {}) {
      const email = prepare(message, options)
      const first = sendOptions.connection ? connectionFor(sendOptions.connection).id : route(email)
      const order = [first]
      if (!sendOptions.connection && options.backup && options.backup !== first) {
        order.push(options.backup)
      }
      const attempts: Attempt[] = []
      let last: MailerError | null = null
      for (const id of order) {
        const result = await attempt(id, email, sendOptions.signal)
        attempts.push(result.attempt)
        if (!result.error) {
          return {
            email,
            connection: id,
            mailer: result.attempt.mailer,
            providerId: result.attempt.providerId,
            attempts,
          }
        }
        last = result.error
        // The caller gave up: don't start on the backup.
        if (sendOptions.signal?.aborted) break
      }
      throw new DeliveryError(email, attempts, last!)
    },

    async verify(id, signal) {
      const transport = await transportFor(connectionFor(id ?? primary))
      await transport.verify?.(signalFor(signal))
    },
  }
}
