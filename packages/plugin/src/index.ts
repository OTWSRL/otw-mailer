import type { Delivery, Message } from '@otwdesign/mailer'
import { definePlugin, type PluginContext, type PluginDefinition } from '@otwdesign/sdk'
import { registerDeps, type MailerDeps } from './deps'
import { migrations } from './migrations'
import type { Pipeline } from './pipeline'

/** What the plugin offers other plugins: email with everything a message can carry. */
export interface MailerService {
  /**
   * Sends an email through the site's connections, with what `cms.mail` doesn't carry: Cc and
   * Bcc, attachments, extra headers. It's logged, and alerts go out if it fails. Throws a
   * `MailerError` from `@otwdesign/mailer` when it couldn't be sent.
   */
  send(message: Message, options?: { connection?: string }): Promise<Delivery>
  /** Sends an email from the log again, as it was. */
  resend(id: string): Promise<Delivery>
}

declare module '@otwdesign/sdk' {
  interface Capabilities {
    /** Set up how the site sends email, and read its email log. Administrators have it. */
    'mailer.manage': true
  }
  interface Services {
    /** Email with attachments, Cc, Bcc and headers, through the Mailer plugin's connections. */
    mailer: MailerService
  }
  interface Settings {
    /** Sends every email from the site's own address (Settings › General), whatever asks. */
    'mailer.force_from_email': boolean
    /** Sends every email under the site's own sender name. */
    'mailer.force_from_name': boolean
    /** Stops all email: nothing is sent, and each one is logged as failed. For staging sites. */
    'mailer.do_not_send': boolean
    /** Keeps a log of every email sent. Failed ones are always logged. */
    'mailer.log': boolean
    /** Keeps each email's text and HTML in the log, which resending needs. Off by default. */
    'mailer.log_content': boolean
    /** How long the log keeps an email: `7d`, `30d`, `90d`, `180d`, `365d` or `forever`. */
    'mailer.log_retention': string
    /** Addresses told when an email fails, separated by commas. */
    'mailer.alert_email': string
    /** A Slack incoming webhook told when an email fails: `MAILER_ALERT_SLACK_WEBHOOK`. */
    'mailer.alert_slack': string
    /** A Discord webhook told when an email fails: `MAILER_ALERT_DISCORD_WEBHOOK`. */
    'mailer.alert_discord': string
    /** A Microsoft Teams webhook told when an email fails: `MAILER_ALERT_TEAMS_WEBHOOK`. */
    'mailer.alert_teams': string
    /** A webhook of your own, sent the failure as JSON: `MAILER_ALERT_WEBHOOK`. */
    'mailer.alert_webhook': string
    /** The Twilio account that texts an alert: its Account SID. */
    'mailer.alert_twilio_sid': string
    /** The Twilio account's auth token: `MAILER_ALERT_TWILIO_TOKEN`. */
    'mailer.alert_twilio_token': string
    /** The Twilio number alerts are sent from. */
    'mailer.alert_twilio_from': string
    /** The phone number alerts are sent to. */
    'mailer.alert_twilio_to': string
  }
}

const ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJibGFjayIgc3Ryb2tlLXdpZHRoPSIxLjMiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHJlY3QgeD0iMiIgeT0iMy41IiB3aWR0aD0iMTIiIGhlaWdodD0iOSIgcng9IjEuMiIvPjxwYXRoIGQ9Ik0yLjUgNC41IDggOWw1LjUtNC41Ii8+PC9zdmc+'

/** The API routes under /api/p/mailer. Their code loads on the first request to one of them. */
export const ROUTES = [
  { method: 'GET', path: '/export' },
  { method: 'GET', path: '/oauth/start' },
  { method: 'GET', path: '/oauth/callback' },
] as const

const phone = (value: string) =>
  /^\+[1-9]\d{6,14}$/.test(value) ? null : 'Use the international form, such as +15551234567'

function setup(cms: PluginContext, deps: MailerDeps): void {
  cms.auth.capability('mailer.manage', { label: 'Manage email delivery' })

  // Everything that sends (the engine, the mailer in use, the log) loads with the first email. A
  // site that sends none boots as fast as without the plugin, and pays nothing per page.
  let pipeline: Promise<Pipeline> | undefined
  const load = () =>
    (pipeline ??= import('./pipeline').then((module) => module.createPipeline(cms, deps)))

  cms.mail.transport({ send: async (mail) => (await load()).deliver(mail) })
  cms.services.provide('mailer', {
    send: async (message, options) => (await load()).send(message, options),
    resend: async (id) => (await load()).resend(id),
  })
  for (const { method, path } of ROUTES) {
    cms.routes.api({
      method,
      path,
      handler: async (request, context) =>
        (await import('./routes')).handle(cms, deps, path, request, context),
    })
  }
}

/**
 * The Mailer plugin. `deps` replaces the environment secrets are read from and the network, for
 * tests; a site uses the default export.
 */
export function createMailerPlugin(deps: Partial<MailerDeps> = {}): PluginDefinition {
  const resolved: MailerDeps = { env: deps.env ?? process.env, fetch: deps.fetch }
  const plugin = definePlugin({
    id: 'mailer',
    version: '1.0.0',
    name: 'Mailer',
    icon: ICON,
    description:
      'Sends the site’s email through SMTP or an email service, with a backup connection, routing rules, an email log and failure alerts.',
    requires: { core: '^1.2.0' },
    migrations,
    settings: {
      'mailer.force_from_email': {
        type: 'boolean',
        label: 'Force From email',
        description:
          'Send every email from the site’s address (Settings › General › Send email from), even when a plugin sets another.',
        default: false,
        env: 'MAILER_FORCE_FROM_EMAIL',
      },
      'mailer.force_from_name': {
        type: 'boolean',
        label: 'Force From name',
        description: 'Send every email under the site’s sender name.',
        default: false,
        env: 'MAILER_FORCE_FROM_NAME',
      },
      'mailer.do_not_send': {
        type: 'boolean',
        label: 'Do not send',
        description:
          'Stop all email. Nothing leaves the site, and each email is logged as failed. Useful on a staging copy.',
        default: false,
        env: 'MAILER_DO_NOT_SEND',
      },
      'mailer.log': {
        type: 'boolean',
        label: 'Log sent emails',
        description: 'Keep a record of every email sent. Failed emails are always recorded.',
        default: true,
        env: 'MAILER_LOG',
      },
      'mailer.log_content': {
        type: 'boolean',
        label: 'Log email content',
        description:
          'Keep each email’s text and HTML too, which sending it again needs. Emails can hold password-reset links and personal details: everyone who may manage email delivery can then read them.',
        default: false,
        env: 'MAILER_LOG_CONTENT',
      },
      'mailer.log_retention': {
        type: 'select',
        label: 'Keep the log for',
        // Not bare numbers: the CMS reads a stored "90" back as the number 90, and drops it.
        options: [
          { value: '7d', label: '1 week' },
          { value: '30d', label: '1 month' },
          { value: '90d', label: '3 months' },
          { value: '180d', label: '6 months' },
          { value: '365d', label: '1 year' },
          { value: 'forever', label: 'Forever' },
        ],
        default: '90d',
        env: 'MAILER_LOG_RETENTION',
      },
      'mailer.alert_email': {
        type: 'text',
        label: 'Email',
        description:
          'Addresses to tell, separated by commas. The alert goes through a connection that didn’t fail, so it needs a second connection.',
        env: 'MAILER_ALERT_EMAIL',
        validate: (value) =>
          value.split(',').every((address) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(address.trim()))
            ? null
            : 'Enter email addresses separated by commas',
      },
      'mailer.alert_slack': {
        type: 'secret',
        label: 'Slack',
        description: 'An incoming webhook’s address.',
        env: 'MAILER_ALERT_SLACK_WEBHOOK',
      },
      'mailer.alert_discord': {
        type: 'secret',
        label: 'Discord',
        description: 'A channel webhook’s address.',
        env: 'MAILER_ALERT_DISCORD_WEBHOOK',
      },
      'mailer.alert_teams': {
        type: 'secret',
        label: 'Microsoft Teams',
        description: 'A workflow or incoming webhook’s address.',
        env: 'MAILER_ALERT_TEAMS_WEBHOOK',
      },
      'mailer.alert_webhook': {
        type: 'secret',
        label: 'Webhook',
        description: 'An address of your own. It’s sent the failure as JSON.',
        env: 'MAILER_ALERT_WEBHOOK',
      },
      'mailer.alert_twilio_sid': {
        type: 'text',
        label: 'Twilio Account SID',
        description: 'Text messages through Twilio need the four Twilio settings.',
        env: 'MAILER_ALERT_TWILIO_SID',
        validate: (value) =>
          /^AC[0-9a-f]{32}$/i.test(value) ? null : 'An Account SID starts with AC',
      },
      'mailer.alert_twilio_token': {
        type: 'secret',
        label: 'Twilio auth token',
        env: 'MAILER_ALERT_TWILIO_TOKEN',
      },
      'mailer.alert_twilio_from': {
        type: 'text',
        label: 'Twilio phone number',
        description: 'The number alerts come from.',
        env: 'MAILER_ALERT_TWILIO_FROM',
        validate: phone,
      },
      'mailer.alert_twilio_to': {
        type: 'text',
        label: 'Send text alerts to',
        env: 'MAILER_ALERT_TWILIO_TO',
        validate: phone,
      },
    },
    setup: (cms) => setup(cms, resolved),
  })
  registerDeps(plugin, resolved)
  return plugin
}

export default createMailerPlugin()
