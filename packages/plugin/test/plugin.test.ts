import { readFileSync } from 'node:fs'
import { MailerError } from '@otwdesign/mailer'
import { definePlugin } from '@otwdesign/sdk'
import { describe, expect, it } from 'vitest'
import mailer from '../src/index.ts'
import { emails, events } from '../src/schema.ts'
import { envName } from '../src/secrets.ts'
import { listEmails, listEvents, loadSending } from '../src/store.ts'
import { act, bootMailer, fakeFetch, MESSAGE, resend } from './fixtures.ts'

const log = async (harness: Awaited<ReturnType<typeof bootMailer>>) =>
  (await listEmails(harness.db, { page: 1, perPage: 50 })).rows

describe('the plugin', () => {
  it('has the version its package has', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(mailer.version).toBe(pkg.version)
  })

  it('names a connection’s secrets after it', () => {
    expect(envName('main', 'apiKey')).toBe('MAILER_MAIN_API_KEY')
    expect(envName('eu_backup', 'secretAccessKey')).toBe('MAILER_EU_BACKUP_SECRET_ACCESS_KEY')
  })
})

describe('sending the site’s email', () => {
  it('fails, and says what to do, until a connection is added', async () => {
    const harness = await bootMailer()
    expect(await harness.kernel.mail.send(MESSAGE)).toBe(false)
    const [entry] = await log(harness)
    expect(entry).toMatchObject({
      status: 'failed',
      subject: 'Welcome',
      recipients: 'bo@example.com',
      error: 'No connection is set up yet. Add one under Mailer › Connections.',
      textBody: null,
    })
    expect((await listEvents(harness.db, 10))[0]).toMatchObject({
      level: 'error',
      message: 'No connection is set up yet. Add one under Mailer › Connections.',
      context: { code: 'not-configured', subject: 'Welcome' },
    })
  })

  it('asks for the site’s sender when neither the email nor the site has one', async () => {
    const { connection, env } = resend('main')
    const network = fakeFetch()
    const harness = await bootMailer({
      env,
      fetch: network.fetch,
      connections: [connection],
      settings: { 'mail.from': '' },
    })
    expect(await harness.kernel.mail.send(MESSAGE)).toBe(false)
    expect((await log(harness))[0]!.error).toBe(
      'The site has no sender. Set “Send email from” in Settings › General.',
    )
    expect(await harness.kernel.mail.send({ ...MESSAGE, from: 'shop@example.com' })).toBe(true)
    expect(network.calls).toHaveLength(1)
  })

  it('sends through the connection with its key from the environment, and logs it without its content', async () => {
    const { connection, env } = resend('main')
    const network = fakeFetch()
    const harness = await bootMailer({ env, fetch: network.fetch, connections: [connection] })
    expect(await harness.kernel.mail.send({ ...MESSAGE, html: '<p>Hello Bo</p>' })).toBe(true)

    expect(network.calls).toHaveLength(1)
    expect(network.calls[0]!.url).toBe('https://api.resend.com/emails')
    expect(network.calls[0]!.headers.authorization).toBe('Bearer key-main')
    expect(network.calls[0]!.body).toMatchObject({
      from: '"Site" <site@example.com>',
      to: ['bo@example.com'],
      subject: 'Welcome',
      text: 'Hello Bo',
      html: '<p>Hello Bo</p>',
    })
    const [entry] = await log(harness)
    expect(entry).toMatchObject({
      status: 'sent',
      sender: '"Site" <site@example.com>',
      recipients: 'bo@example.com',
      subject: 'Welcome',
      connection: 'main',
      mailer: 'resend',
      providerId: 'sent-1',
      error: null,
      textBody: null,
      htmlBody: null,
    })
    expect(entry!.messageId).toMatch(/^<[0-9a-f]{32}@example\.com>$/)
    expect(entry!.attempts).toMatchObject([{ connection: 'main', ok: true }])
  })

  it('keeps the content when asked, and nothing at all of sent emails when logging is off', async () => {
    const { connection, env } = resend('main')
    const kept = await bootMailer({
      env,
      fetch: fakeFetch().fetch,
      connections: [connection],
      settings: { 'mailer.log_content': true },
    })
    await kept.kernel.mail.send({ ...MESSAGE, html: '<p>Hello</p>', replyTo: 'help@example.com' })
    expect((await log(kept))[0]).toMatchObject({
      textBody: 'Hello Bo',
      htmlBody: '<p>Hello</p>',
      replyTo: 'help@example.com',
    })

    const off = await bootMailer({
      env,
      fetch: fakeFetch(() => Response.json({ message: 'bad key' }, { status: 401 })).fetch,
      connections: [connection],
      settings: { 'mailer.log': false },
    })
    // Failures are always logged, even with the log off for sent emails.
    await off.kernel.mail.send(MESSAGE)
    expect(await log(off)).toHaveLength(0)
    expect(await listEvents(off.db, 10)).toHaveLength(1)
  })

  it('reports a failure to the site, the log and the debug events, never with the key', async () => {
    const { connection, env } = resend('main')
    const failed: string[] = []
    const harness = await bootMailer({
      env,
      // A service that repeats the key it was sent.
      fetch: fakeFetch(() =>
        Response.json({ message: 'The key-main API key is invalid' }, { status: 401 }),
      ).fetch,
      connections: [connection],
      plugins: [
        definePlugin({
          id: 'listener',
          version: '1.0.0',
          setup: (cms) =>
            cms.hooks.addAction('mail.failed', ({ error }) => void failed.push(error)),
        }),
      ],
    })
    expect(await harness.kernel.mail.send(MESSAGE)).toBe(false)
    const error = 'Resend refused the email (HTTP 401): The [secret] API key is invalid'
    expect(failed).toEqual([error])
    expect((await log(harness))[0]).toMatchObject({ status: 'failed', error, connection: 'main' })
    expect((await listEvents(harness.db, 10))[0]).toMatchObject({
      message: error,
      context: {
        connection: 'main',
        mailer: 'resend',
        code: 'auth',
        status: 401,
        subject: 'Welcome',
      },
    })
    // Neither the log, the events nor the stored connection holds the key.
    const stored = [
      await log(harness),
      await listEvents(harness.db, 10),
      await loadSending(harness.db),
    ]
    expect(JSON.stringify(stored)).not.toContain('key-main')
  })

  it('says which variable is missing when a connection’s key isn’t set', async () => {
    const harness = await bootMailer({ connections: [{ id: 'main', mailer: 'sendgrid' }] })
    expect(await harness.kernel.mail.send(MESSAGE)).toBe(false)
    expect((await log(harness))[0]!.error).toBe("SendGrid isn't set up: it needs its api key.")
  })

  it('falls back to the backup connection, and logs both tries', async () => {
    const a = resend('main')
    const b = resend('spare')
    const network = fakeFetch((call) =>
      call.headers.authorization === 'Bearer key-main'
        ? Response.json({ message: 'down' }, { status: 503 })
        : Response.json({ id: 'r2' }),
    )
    const harness = await bootMailer({
      env: { ...a.env, ...b.env },
      fetch: network.fetch,
      connections: [a.connection, b.connection],
      backup: 'spare',
    })
    expect(await harness.kernel.mail.send(MESSAGE)).toBe(true)
    const [entry] = await log(harness)
    expect(entry).toMatchObject({ status: 'sent', connection: 'spare', providerId: 'r2' })
    expect(entry!.attempts.map((attempt) => [attempt.connection, attempt.ok])).toEqual([
      ['main', false],
      ['spare', true],
    ])
    // The failed try is in the debug events, though the email went out.
    expect((await listEvents(harness.db, 10)).map((event) => event.context.connection)).toEqual([
      'main',
    ])
  })

  it('routes by rule, and forces the site’s sender when asked', async () => {
    const a = resend('main')
    const b = resend('orders')
    const network = fakeFetch()
    const harness = await bootMailer({
      env: { ...a.env, ...b.env },
      fetch: network.fetch,
      connections: [a.connection, b.connection],
      settings: { 'mailer.force_from_email': true },
    })
    const { cookie } = await harness.signIn()
    expect(
      await act(harness, cookie, 'add-route', {
        'field.0': 'subject',
        'operator.0': 'contains',
        'value.0': 'order',
        connection: 'orders',
      }),
    ).toMatchObject({ flash: { kind: 'notice', message: 'Rule added.' } })
    await harness.kernel.mail.send({
      ...MESSAGE,
      subject: 'Your ORDER',
      from: 'Shop <shop@other.test>',
    })
    await harness.kernel.mail.send(MESSAGE)
    expect(network.calls.map((call) => call.headers.authorization)).toEqual([
      'Bearer key-orders',
      'Bearer key-main',
    ])
    expect((network.calls[0]!.body as { from: string }).from).toBe('"Shop" <site@example.com>')
  })

  it('sends nothing while "Do not send" is on', async () => {
    const { connection, env } = resend('main')
    const network = fakeFetch()
    const harness = await bootMailer({
      env,
      fetch: network.fetch,
      connections: [connection],
      settings: { 'mailer.do_not_send': true },
    })
    expect(await harness.kernel.mail.send(MESSAGE)).toBe(false)
    expect(network.calls).toEqual([])
    expect((await log(harness))[0]!.error).toMatch(/^Sending is turned off/)
  })

  it('doesn’t lose the caller’s work when the email is sent inside a transaction', async () => {
    const { connection, env } = resend('main')
    const harness = await bootMailer({ env, fetch: fakeFetch().fetch, connections: [connection] })
    await harness.kernel.transaction(async () => {
      expect(await harness.kernel.mail.send({ ...MESSAGE, text: 'NUL \u0000 inside' })).toBe(true)
    })
    expect(await log(harness)).toHaveLength(1)
  })

  it('offers other plugins email with Cc, Bcc, attachments and headers', async () => {
    const { connection, env } = resend('main')
    const network = fakeFetch()
    const harness = await bootMailer({ env, fetch: network.fetch, connections: [connection] })
    const service = harness.kernel.service('mailer')
    const delivery = await service.send({
      ...MESSAGE,
      cc: 'cy@example.com',
      bcc: 'di@example.com',
      headers: { 'X-Kind': 'invoice' },
      attachments: [{ filename: 'invoice.pdf', content: '%PDF' }],
    })
    expect(delivery).toMatchObject({ connection: 'main', providerId: 'sent-1' })
    expect(network.calls[0]!.body).toMatchObject({
      cc: ['cy@example.com'],
      bcc: ['di@example.com'],
      headers: { 'X-Kind': 'invoice' },
      attachments: [
        { filename: 'invoice.pdf', content: 'JVBERg==', content_type: 'application/pdf' },
      ],
    })
    const [entry] = await log(harness)
    expect(entry!.recipients).toBe('bo@example.com, cy@example.com, di@example.com')
    expect(entry!.addresses).toEqual({
      to: ['bo@example.com'],
      cc: ['cy@example.com'],
      bcc: ['di@example.com'],
    })
    await expect(service.send({ ...MESSAGE, to: 'nope' })).rejects.toBeInstanceOf(MailerError)
    expect((await log(harness))[0]).toMatchObject({ status: 'failed', recipients: 'nope' })
  })

  it('forgets old emails once the log’s keeping time has passed', async () => {
    const { connection, env } = resend('main')
    const harness = await bootMailer({
      env,
      fetch: fakeFetch().fetch,
      connections: [connection],
      settings: { 'mailer.log_retention': '7d' },
    })
    const old = {
      status: 'sent' as const,
      sender: 'a',
      recipients: 'b',
      subject: 'old',
      attempts: [],
    }
    await harness.db.insert(emails).values([
      { ...old, createdAt: new Date(Date.now() - 8 * 86_400_000) },
      { ...old, subject: 'recent', createdAt: new Date(Date.now() - 6 * 86_400_000) },
    ])
    await harness.db.insert(events).values({
      level: 'error',
      message: 'old',
      context: {},
      createdAt: new Date(Date.now() - 31 * 86_400_000),
    })
    await harness.kernel.mail.send(MESSAGE)
    expect((await log(harness)).map((entry) => entry.subject)).toEqual(['Welcome', 'recent'])
    expect(await listEvents(harness.db, 10)).toEqual([])
  })
})

describe('alerts', () => {
  const failing = () =>
    fakeFetch((call) =>
      call.url.startsWith('https://api.resend.com')
        ? Response.json({ message: 'down' }, { status: 503 })
        : new Response('ok'),
    )

  it('tells Slack, Discord, Teams, a webhook and Twilio, without the email’s body or recipients', async () => {
    const { connection, env } = resend('main')
    const network = failing()
    const harness = await bootMailer({
      env: {
        ...env,
        MAILER_ALERT_SLACK_WEBHOOK: 'https://hooks.slack.test/T1',
        MAILER_ALERT_DISCORD_WEBHOOK: 'https://discord.test/api/webhooks/1',
        MAILER_ALERT_TEAMS_WEBHOOK: 'https://teams.test/hook',
        MAILER_ALERT_WEBHOOK: 'https://ops.example.com/mail-failed',
        MAILER_ALERT_TWILIO_TOKEN: 'tw-token',
      },
      fetch: network.fetch,
      connections: [connection],
      settings: {
        'site.title': 'Shop',
        'site.url': 'https://shop.test',
        'mailer.alert_twilio_sid': `AC${'a'.repeat(32)}`,
        'mailer.alert_twilio_from': '+15550001111',
        'mailer.alert_twilio_to': '+15550002222',
      },
    })
    await harness.kernel.mail.send({
      ...MESSAGE,
      text: 'Your reset link: https://shop.test/reset/SECRET',
    })
    const alerts = network.calls.filter((call) => !call.url.startsWith('https://api.resend.com'))
    expect(alerts.map((call) => call.url).sort()).toEqual([
      `https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Messages.json`,
      'https://discord.test/api/webhooks/1',
      'https://hooks.slack.test/T1',
      'https://ops.example.com/mail-failed',
      'https://teams.test/hook',
    ])
    const slack = alerts.find((call) => call.url.includes('slack'))!.body as { text: string }
    expect(slack.text).toBe(
      [
        "Shop couldn't send an email.",
        'Subject: Welcome',
        'Error: Resend refused the email (HTTP 503): down',
        'Tried: main',
        'Email log: https://shop.test/admin/mailer/log?status=failed',
      ].join('\n'),
    )
    expect(alerts.find((call) => call.url.includes('ops.example'))!.body).toMatchObject({
      event: 'mailer.failed',
      site: 'https://shop.test',
      subject: 'Welcome',
      error: 'Resend refused the email (HTTP 503): down',
      connections: ['main'],
    })
    const twilio = alerts.find((call) => call.url.includes('twilio'))!
    expect(twilio.headers.authorization).toBe(`Basic ${btoa(`AC${'a'.repeat(32)}:tw-token`)}`)
    expect(new URLSearchParams(twilio.body as string).get('To')).toBe('+15550002222')
    expect(JSON.stringify(alerts)).not.toMatch(/SECRET|bo@example\.com/)
  })

  it('sends one alert a minute however many emails fail, and notes an alert that fails', async () => {
    const { connection, env } = resend('main')
    const network = fakeFetch((call) =>
      call.url.startsWith('https://api.resend.com')
        ? Response.json({ message: 'down' }, { status: 503 })
        : new Response('no', { status: 500 }),
    )
    const harness = await bootMailer({
      env: { ...env, MAILER_ALERT_SLACK_WEBHOOK: 'https://hooks.slack.test/T1' },
      fetch: network.fetch,
      connections: [connection],
    })
    await harness.kernel.mail.send(MESSAGE)
    await harness.kernel.mail.send(MESSAGE)
    await harness.kernel.mail.send(MESSAGE)
    expect(network.calls.filter((call) => call.url.includes('slack'))).toHaveLength(1)
    expect((await listEvents(harness.db, 10)).map((event) => event.message)).toContain(
      "The Slack alert wasn't sent: It answered HTTP 500",
    )
  })

  it('emails the alert through a connection that didn’t fail, outside the log', async () => {
    const a = resend('main')
    const b = resend('spare')
    const network = fakeFetch((call) =>
      call.headers.authorization === 'Bearer key-main'
        ? Response.json({ message: 'down' }, { status: 503 })
        : Response.json({ id: 'alert-1' }),
    )
    const harness = await bootMailer({
      env: { ...a.env, ...b.env },
      fetch: network.fetch,
      connections: [a.connection, b.connection],
      settings: { 'mailer.alert_email': 'ops@example.com, owner@example.com' },
    })
    expect(await harness.kernel.mail.send(MESSAGE)).toBe(false)
    const alert = network.calls.find((call) => call.headers.authorization === 'Bearer key-spare')!
    expect(alert.body).toMatchObject({
      to: ['ops@example.com', 'owner@example.com'],
      subject: 'An email failed to send: Welcome',
    })
    expect(await log(harness)).toHaveLength(1)
  })
})
