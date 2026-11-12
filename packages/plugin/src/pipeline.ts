import {
  createMailer,
  DeliveryError,
  formatAddress,
  MailerError,
  mailerInfo,
  recipients,
  type Connection,
  type Delivery,
  type Email,
  type Mailer,
  type Message,
  type OAuthTokens,
  type TokenStore,
} from '@otwdesign/mailer'
import type { OutgoingMail, PluginContext } from '@otwdesign/sdk'
import { createAlerts } from './alerts'
import type { MailerDeps } from './deps'
import { envName, resolveConfig } from './secrets'
import {
  addEvent,
  getConnection,
  getEmail,
  loadSending,
  logEmail,
  prune,
  setAuth,
  type EmailRecord,
  type Sending,
  type StoredConnection,
} from './store'
import { seal, unseal } from './tokens'

/** How one email is sent. */
export interface DispatchOptions {
  /** Through this connection only: no routing rules, no backup. */
  connection?: string
  /** The log entry this is a resend of. */
  resentFrom?: string
}

/** Sends email for the site: through its connections, into its log, with alerts when it fails. */
export interface Pipeline {
  /** Sends a message. Throws a `MailerError` when it couldn't be sent, after logging why. */
  send(message: Message, options?: DispatchOptions): Promise<Delivery>
  /** Sends the site's own email, as `cms.mail` hands it over. */
  deliver(mail: OutgoingMail): Promise<void>
  /** Sends a logged email again, as it was. Needs its content, so "Log email content" on when it was sent. */
  resend(id: string): Promise<Delivery>
}

const PRUNE_EVERY = 3_600_000

const join = (addresses: readonly { email: string }[]) =>
  addresses.map((address) => address.email).join(', ')

/** What the log can say about a message that was refused before it was an email. */
function describe(message: Message): Pick<EmailRecord, 'sender' | 'recipients' | 'subject'> {
  const text = (value: unknown) =>
    typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  const list = (value: unknown) =>
    Array.isArray(value) ? value : value === undefined ? [] : [value]
  return {
    sender: text(message.from ?? '').slice(0, 320),
    recipients: [...list(message.to), ...list(message.cc), ...list(message.bcc)]
      .map(text)
      .join(', ')
      .slice(0, 2000),
    subject: text(message.subject ?? '').slice(0, 998),
  }
}

/**
 * The site's mailer. Built when the first email is sent, so a site that sends none never loads
 * it. Each send reads the connections (two queries), sends, and writes the log (one).
 */
export function createPipeline(cms: PluginContext, deps: MailerDeps): Pipeline {
  const alerts = createAlerts(cms, deps)
  let cached: { key: string; mailer: Mailer } | null = null
  let pruned = 0

  /** A connected account's tokens, encrypted in the connection's row. */
  const tokenStore = (connection: StoredConnection, clientSecret: string): TokenStore => ({
    async read() {
      const row = await getConnection(cms.db, connection.id)
      return row?.auth ? unseal(row.auth, clientSecret, connection.id) : null
    },
    async write(tokens: OAuthTokens) {
      await setAuth(cms.db, connection.id, seal(tokens, clientSecret, connection.id))
    },
  })

  const engineConnection = (connection: StoredConnection): Connection => {
    const config = resolveConfig(connection, deps.env)
    const secret = config.clientSecret
    const oauth = mailerInfo(connection.mailer)?.oauth
    return {
      id: connection.id,
      mailer: connection.mailer,
      config,
      // A refresh token in the environment wins: nothing is stored then.
      tokens:
        oauth && typeof secret === 'string' && !config.refreshToken
          ? tokenStore(connection, secret)
          : undefined,
    }
  }

  /** The engine for the settings as they are now; rebuilt only when they change. */
  const mailerFor = (sending: Sending): Mailer => {
    const options = {
      connections: sending.connections.map(engineConnection),
      primary: sending.primary ?? undefined,
      backup: sending.backup ?? undefined,
      routes: sending.routes,
      forceFromEmail: cms.settings.get('mailer.force_from_email') === true,
      forceFromName: cms.settings.get('mailer.force_from_name') === true,
      from: cms.settings.get('mail.from') || undefined,
    }
    // Secrets are part of the key, so a rotated key takes effect at once. It stays in memory.
    const key = JSON.stringify({
      ...options,
      connections: options.connections.map(({ tokens: _, ...rest }) => rest),
    })
    if (cached?.key !== key)
      cached = { key, mailer: createMailer({ ...options, fetch: deps.fetch }) }
    return cached.mailer
  }

  /** Writes the log entry and a debug event per failed try, or `failure` when none was made. */
  const record = async (entry: EmailRecord, failure?: MailerError): Promise<void> => {
    if (cms.settings.get('mailer.log') === false && entry.status === 'sent') return
    const keep = cms.settings.get('mailer.log_content') === true
    try {
      // A transaction of its own: inside a caller's, that's a savepoint, so a log that can't be
      // written never undoes what the caller did.
      await cms.transaction(async (db) => {
        if (cms.settings.get('mailer.log') !== false) {
          await logEmail(db, keep ? entry : { ...entry, textBody: null, htmlBody: null })
        }
        if (failure && entry.attempts.length === 0) {
          await addEvent(db, 'error', failure.message, {
            code: failure.code,
            subject: entry.subject,
          })
        }
        for (const attempt of entry.attempts.filter((item) => !item.ok)) {
          await addEvent(db, 'error', attempt.error?.message ?? 'The email could not be sent.', {
            connection: attempt.connection,
            mailer: attempt.mailer,
            code: attempt.error?.code ?? null,
            status: attempt.error?.status ?? null,
            subject: entry.subject,
          })
        }
        if (Date.now() - pruned > PRUNE_EVERY) {
          pruned = Date.now()
          // "90d" is 90 days; "forever" is no number, so nothing is pruned.
          await prune(
            db,
            Number.parseInt(cms.settings.get('mailer.log_retention') ?? '90d', 10) || 0,
          )
        }
      })
    } catch (error) {
      cms.logger.error('The email log could not be written', { error })
    }
  }

  const fromEmail = (email: Email) => ({
    sender: formatAddress(email.from),
    recipients: join(recipients(email)),
    addresses: {
      to: email.to.map(formatAddress),
      cc: email.cc.map(formatAddress),
      bcc: email.bcc.map(formatAddress),
    },
    subject: email.subject,
    textBody: email.text,
    htmlBody: email.html,
    replyTo: email.replyTo.length > 0 ? join(email.replyTo) : null,
    messageId: email.messageId,
  })

  const send = async (message: Message, options: DispatchOptions = {}): Promise<Delivery> => {
    const resentFrom = options.resentFrom ?? null
    let sending: Sending | null = null
    let mailer: Mailer | null = null
    try {
      if (cms.settings.get('mailer.do_not_send') === true) {
        throw new MailerError(
          'rejected',
          'Sending is turned off: "Do not send" is on in the Mailer settings.',
        )
      }
      if (message.from === undefined && !cms.settings.get('mail.from')) {
        throw new MailerError(
          'invalid-message',
          'The site has no sender. Set “Send email from” in Settings › General.',
        )
      }
      sending = await loadSending(cms.db)
      if (sending.connections.length === 0) {
        throw new MailerError(
          'not-configured',
          'No connection is set up yet. Add one under Mailer › Connections.',
        )
      }
      mailer = mailerFor(sending)
      const delivery = await mailer.send(message, { connection: options.connection })
      await record({
        ...fromEmail(delivery.email),
        status: 'sent',
        connection: delivery.connection,
        mailer: delivery.mailer,
        providerId: delivery.providerId,
        error: null,
        attempts: delivery.attempts,
        resentFrom,
      })
      return delivery
    } catch (caught) {
      const error =
        caught instanceof MailerError
          ? caught
          : new MailerError('unavailable', `The email couldn't be sent: ${String(caught)}`, {
              cause: caught,
            })
      const attempts = error instanceof DeliveryError ? error.attempts : []
      const last = attempts.at(-1)
      const about =
        error instanceof DeliveryError
          ? fromEmail(error.email)
          : {
              ...describe(message),
              addresses: null,
              textBody: null,
              htmlBody: null,
              replyTo: null,
              messageId: null,
            }
      await record(
        {
          ...about,
          status: 'failed',
          connection: last?.connection ?? null,
          mailer: last?.mailer ?? null,
          providerId: null,
          error: error.message,
          attempts,
          resentFrom,
        },
        error,
      )
      const tried = attempts.map((attempt) => attempt.connection)
      const others = (sending?.connections ?? [])
        .map((c) => c.id)
        .filter((id) => !tried.includes(id))
      await alerts
        .failed(
          { subject: about.subject, error: error.message, connections: tried },
          mailer,
          others,
        )
        .catch((alertError: unknown) =>
          cms.logger.warn('Failure alerts could not be sent', { error: alertError }),
        )
      throw error
    }
  }

  return {
    send,

    async deliver(mail) {
      await send({
        from: mail.from ?? undefined,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html ?? undefined,
        replyTo: mail.replyTo ?? undefined,
      })
    },

    async resend(id) {
      const email = await getEmail(cms.db, id)
      if (!email) throw new MailerError('invalid-message', 'That email is no longer in the log.')
      if (email.textBody === null && email.htmlBody === null) {
        throw new MailerError(
          'invalid-message',
          'This email’s content wasn’t kept, so it can’t be sent again. Turn on "Log email content" to resend later emails.',
        )
      }
      const list = (text: string | null) =>
        (text ?? '')
          .split(',')
          .map((address) => address.trim())
          .filter(Boolean)
      // The same people the same way: those who were Bcc stay hidden from the others.
      const to = email.addresses?.to ?? list(email.recipients)
      return send(
        {
          from: email.sender,
          to,
          cc: email.addresses?.cc,
          bcc: email.addresses?.bcc,
          subject: email.subject,
          text: email.textBody ?? undefined,
          html: email.htmlBody ?? undefined,
          replyTo: list(email.replyTo),
        },
        { resentFrom: email.id },
      )
    },
  }
}

/** The variable a connected account's refresh token can be set in, instead of connecting in the admin. */
export function refreshTokenEnv(connection: string): string {
  return envName(connection, 'refreshToken')
}
