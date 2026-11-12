import type { Mailer } from '@otwdesign/mailer'
import type { PluginContext } from '@otwdesign/sdk'
import type { MailerDeps } from './deps'
import { addEvent } from './store'

/** An email that failed, as an alert reports it. Never its body or its recipients. */
export interface FailureReport {
  subject: string
  error: string
  /** The connections tried. */
  connections: string[]
}

const TIMEOUT = 5000
/** A burst of failures (a service down) sends one alert a minute, not one per email. */
const MIN_INTERVAL = 60_000
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g

interface Channel {
  name: string
  send(text: string, report: FailureReport): Promise<void>
}

/**
 * Tells the people who run the site that an email failed: by email through another connection,
 * Slack, Discord, Microsoft Teams, a text message through Twilio, or a webhook of your own.
 * Webhook addresses and Twilio's token come from the environment. An alert that fails is noted in
 * the debug events and never stops the site.
 */
export function createAlerts(cms: PluginContext, deps: MailerDeps) {
  const fetcher = deps.fetch ?? fetch
  let last = 0
  let suppressed = 0

  const post = async (
    url: string,
    init: { json?: unknown; body?: BodyInit; headers?: Record<string, string> },
  ) => {
    if (!/^https:\/\//i.test(url)) throw new Error('The address must start with https://')
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      body: init.json === undefined ? init.body : JSON.stringify(init.json),
      signal: AbortSignal.timeout(TIMEOUT),
      redirect: 'error',
    })
    if (!response.ok) throw new Error(`It answered HTTP ${response.status}`)
  }

  const channels = (mailer: Mailer | null, others: readonly string[]): Channel[] => {
    const list: Channel[] = []
    const setting = cms.settings.get
    const to = (setting('mailer.alert_email') ?? '')
      .split(',')
      .map((address) => address.trim())
      .filter(Boolean)
    if (to.length > 0 && mailer && others.length > 0) {
      list.push({
        name: 'email',
        // Through a connection that didn't just fail, and not through the log: an alert that
        // fails must not raise another.
        send: async (text, report) => {
          await mailer.send(
            { to, subject: `An email failed to send: ${report.subject}`.slice(0, 200), text },
            { connection: others[0] },
          )
        },
      })
    }
    const slack = setting('mailer.alert_slack')
    if (slack) list.push({ name: 'Slack', send: (text) => post(slack, { json: { text } }) })
    const discord = setting('mailer.alert_discord')
    if (discord)
      list.push({
        name: 'Discord',
        send: (text) => post(discord, { json: { content: text.slice(0, 1900) } }),
      })
    const teams = setting('mailer.alert_teams')
    if (teams)
      list.push({ name: 'Microsoft Teams', send: (text) => post(teams, { json: { text } }) })
    const webhook = setting('mailer.alert_webhook')
    if (webhook) {
      list.push({
        name: 'webhook',
        send: (_text, report) =>
          post(webhook, {
            json: {
              event: 'mailer.failed',
              site: setting('site.url') || setting('site.title') || '',
              subject: report.subject,
              error: report.error,
              connections: report.connections,
              occurredAt: new Date().toISOString(),
            },
          }),
      })
    }
    const sid = setting('mailer.alert_twilio_sid')
    const token = setting('mailer.alert_twilio_token')
    const from = setting('mailer.alert_twilio_from')
    const phone = setting('mailer.alert_twilio_to')
    if (sid && token && from && phone && /^AC[0-9a-f]{32}$/i.test(sid)) {
      list.push({
        name: 'Twilio',
        send: (text) =>
          post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
            headers: { authorization: `Basic ${btoa(`${sid}:${token}`)}` },
            body: new URLSearchParams({ From: from, To: phone, Body: text.slice(0, 320) }),
          }),
      })
    }
    return list
  }

  return {
    /**
     * Sends the alert on every channel that's set up. `mailer` and `others` name the connections
     * an alert email can still go through.
     */
    async failed(
      report: FailureReport,
      mailer: Mailer | null,
      others: readonly string[],
    ): Promise<void> {
      const active = channels(mailer, others)
      if (active.length === 0) return
      const now = Date.now()
      if (now - last < MIN_INTERVAL) {
        suppressed++
        return
      }
      last = now
      const site = cms.settings.get('site.title') || 'Your site'
      const origin = cms.settings.get('site.url') ?? ''
      const lines = [
        `${site} couldn't send an email.`,
        `Subject: ${report.subject.replace(CONTROL, ' ')}`,
        `Error: ${report.error.replace(CONTROL, ' ')}`,
        `Tried: ${report.connections.join(', ') || 'no connection'}`,
        ...(suppressed > 0 ? [`${suppressed} more failed since the last alert.`] : []),
        ...(origin ? [`Email log: ${origin}${cms.admin.url('/log')}?status=failed`] : []),
      ]
      suppressed = 0
      await Promise.all(
        active.map(async (channel) => {
          try {
            await channel.send(lines.join('\n'), report)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            cms.logger.warn(`The ${channel.name} alert about a failed email wasn't sent`, {
              reason,
            })
            await addEvent(
              cms.db,
              'error',
              `The ${channel.name} alert wasn't sent: ${reason}`,
            ).catch(() => {})
          }
        }),
      )
    },
  }
}
