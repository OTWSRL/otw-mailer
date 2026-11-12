import { checkConfig } from './config.ts'
import { MailerError } from './errors.ts'
import { mailerInfo, type MailerId } from './registry.ts'
import type { Connection, CreateTransport, Transport, TransportContext } from './types.ts'

type Module = { create: CreateTransport<never> }

/**
 * One import per mailer, each written out so bundlers split them into files of their own. A
 * mailer's code, and what it depends on (Nodemailer, for SMTP), loads when a connection first
 * sends through it, and never otherwise.
 */
const LOADERS: Record<MailerId, () => Promise<Module>> = {
  smtp: () => import('./mailers/smtp.ts'),
  sendlayer: () => import('./mailers/sendlayer.ts'),
  smtpcom: () => import('./mailers/smtpcom.ts'),
  brevo: () => import('./mailers/brevo.ts'),
  ses: () => import('./mailers/ses.ts'),
  gmail: () => import('./mailers/gmail.ts'),
  mailgun: () => import('./mailers/mailgun.ts'),
  mailjet: () => import('./mailers/mailjet.ts'),
  mailersend: () => import('./mailers/mailersend.ts'),
  mandrill: () => import('./mailers/mandrill.ts'),
  outlook: () => import('./mailers/outlook.ts'),
  postmark: () => import('./mailers/postmark.ts'),
  resend: () => import('./mailers/resend.ts'),
  sendgrid: () => import('./mailers/sendgrid.ts'),
  smtp2go: () => import('./mailers/smtp2go.ts'),
  sparkpost: () => import('./mailers/sparkpost.ts'),
  zoho: () => import('./mailers/zoho.ts'),
  elasticemail: () => import('./mailers/elasticemail.ts'),
}

/** A connection's transport: its settings checked, its mailer's code loaded. */
export async function loadTransport(
  connection: Connection,
  context: Omit<TransportContext, 'connection' | 'tokens'>,
): Promise<Transport> {
  const info = mailerInfo(connection.mailer)
  if (!info) {
    throw new MailerError(
      'not-configured',
      `The connection "${connection.id}" names a mailer that doesn't exist: "${String(connection.mailer)}".`,
    )
  }
  const config = checkConfig(info, connection.config)
  const module = await LOADERS[info.id]()
  return module.create(config as never, {
    ...context,
    connection: connection.id,
    tokens: connection.tokens,
  })
}
