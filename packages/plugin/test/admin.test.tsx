import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { simpleParser } from 'mailparser'
import { SMTPServer } from 'smtp-server'
import { describe, expect, it } from 'vitest'
import { pageOf, parseConditions, parseConfig } from '../src/admin-handlers.tsx'
import { csvCell } from '../src/routes.ts'
import { previewDocument } from '../src/screens.tsx'
import { emails } from '../src/schema.ts'
import { getConnection, listEmails, listEvents, loadSending } from '../src/store.ts'
import { mailerInfo } from '@otwdesign/mailer/mailers'
import { act, bootMailer, fakeFetch, MESSAGE, renderAdmin, resend } from './fixtures.ts'

const form = (entries: Record<string, string>) => {
  const data = new FormData()
  for (const [name, value] of Object.entries(entries)) data.set(name, value)
  return data
}

describe('connections', () => {
  it('adds one, keeps only what the mailer names, and never a secret', async () => {
    const harness = await bootMailer()
    const { cookie } = await harness.signIn()
    const added = await act(harness, cookie, 'save-connection', {
      mailer: 'smtp',
      name: 'Office server',
      new_id: 'main',
      'config.host': ' smtp.example.com ',
      'config.port': '2525',
      'config.encryption': 'none',
      'config.autoTls': 'on',
      'config.username': 'site',
      // A crafted form can't store a password, or a setting the mailer doesn't have.
      'config.password': 'hunter2',
      'config.evil': 'x',
    })
    expect(added).toEqual({
      status: 303,
      path: '/admin/mailer/connections/main',
      flash: { kind: 'notice', message: 'Connection added.' },
    })
    expect(await getConnection(harness.db, 'main')).toMatchObject({
      id: 'main',
      name: 'Office server',
      mailer: 'smtp',
      config: {
        host: 'smtp.example.com',
        port: 2525,
        encryption: 'none',
        autoTls: true,
        verifyCertificate: false,
        username: 'site',
      },
      auth: null,
    })
    // The first connection is the primary one without being told.
    expect(await loadSending(harness.db)).toMatchObject({ primary: 'main', backup: null })
  })

  it('refuses a taken or malformed ID, an unknown mailer, and settings that aren’t right', async () => {
    const harness = await bootMailer({ connections: [{ id: 'main', mailer: 'resend' }] })
    const { cookie } = await harness.signIn()
    const save = (fields: Record<string, string>) =>
      act(harness, cookie, 'save-connection', {
        mailer: 'mailgun',
        name: 'MG',
        'config.domain': 'mg.example.com',
        ...fields,
      })
    expect((await save({ new_id: 'main' })).flash).toEqual({
      kind: 'error',
      message: 'There is already a connection with the ID “main”.',
    })
    for (const id of ['Main', '1st', 'a-b', 'a'.repeat(25), '']) {
      expect((await save({ new_id: id })).flash?.message).toMatch(
        /^The ID must start with a letter/,
      )
    }
    expect((await save({ new_id: 'x', mailer: 'nope' })).flash?.message).toBe('Choose a mailer.')
    expect((await save({ new_id: 'x', 'config.domain': '' })).flash?.message).toBe(
      'Domain name is required.',
    )
    expect((await save({ new_id: 'x', 'config.region': 'mars' })).flash?.message).toBe(
      'Region: choose one of the options.',
    )
    expect((await loadSending(harness.db)).connections.map((c) => c.id)).toEqual(['main'])
  })

  it('reads a form’s settings by each field’s type', () => {
    const smtp = mailerInfo('smtp')!
    expect(
      parseConfig(
        smtp,
        form({
          'config.host': 'h.example.com',
          'config.encryption': 'ssl',
          'config.verifyCertificate': 'on',
        }),
      ),
    ).toEqual({ host: 'h.example.com', encryption: 'ssl', autoTls: false, verifyCertificate: true })
    expect(() =>
      parseConfig(
        smtp,
        form({ 'config.host': 'h', 'config.encryption': 'tls', 'config.port': '70000' }),
      ),
    ).toThrow('SMTP port must be a number from 1 to 65535.')
    expect(() =>
      parseConfig(smtp, form({ 'config.host': 'a\nb', 'config.encryption': 'tls' })),
    ).toThrow(/one line/)
  })

  it('makes one primary and another the backup, never both', async () => {
    const harness = await bootMailer({
      connections: [
        { id: 'a', mailer: 'resend' },
        { id: 'b', mailer: 'resend' },
      ],
    })
    const { cookie } = await harness.signIn()
    const role = (id: string, value: string) =>
      act(harness, cookie, 'set-role', { id, role: value })
    expect((await role('a', 'backup')).flash?.message).toBe(
      'The primary connection can’t be its own backup.',
    )
    expect((await role('b', 'backup')).flash?.message).toBe('b is now the backup connection.')
    expect(await loadSending(harness.db)).toMatchObject({ primary: 'a', backup: 'b' })
    // The backup made primary stops being the backup.
    await role('b', 'primary')
    expect(await loadSending(harness.db)).toMatchObject({ primary: 'b', backup: null })
    await role('a', 'backup')
    await role('a', 'none')
    expect(await loadSending(harness.db)).toMatchObject({ primary: 'b', backup: null })
  })

  it('keeps a connection’s role whatever it’s called, and a setting saved in the admin', async () => {
    // "true" and "null" are words JSON reads as values; as IDs they must stay text.
    const harness = await bootMailer({
      connections: [
        { id: 'main', mailer: 'resend' },
        { id: 'true', mailer: 'resend' },
        { id: 'null', mailer: 'resend' },
      ],
    })
    const { cookie } = await harness.signIn()
    await act(harness, cookie, 'set-role', { id: 'true', role: 'primary' })
    await act(harness, cookie, 'set-role', { id: 'null', role: 'backup' })
    expect(await loadSending(harness.db)).toMatchObject({ primary: 'true', backup: 'null' })

    const saved = await harness.request('POST', '/api/p/core/actions/save-settings', {
      cookie,
      form: { page: 'mailer.settings', 'mailer.log_retention': '7d', 'mailer.log': 'on' },
    })
    expect(saved.status).toBe(303)
    const kernel = await harness.reboot()
    expect(kernel.setting('mailer.log_retention')).toBe('7d')
    expect(harness.logger.entries.filter((entry) => entry.level === 'warn')).toEqual([])
  })

  it('deletes one with its role and the rules that used it', async () => {
    const harness = await bootMailer({
      connections: [
        { id: 'a', mailer: 'resend' },
        { id: 'b', mailer: 'resend' },
      ],
      backup: 'b',
    })
    const { cookie } = await harness.signIn()
    await act(harness, cookie, 'add-route', {
      'field.0': 'to',
      'operator.0': 'is',
      'value.0': 'x@example.com',
      connection: 'b',
    })
    await act(harness, cookie, 'delete-connection', { id: 'b' })
    expect(await loadSending(harness.db)).toMatchObject({ primary: 'a', backup: null, routes: [] })
  })

  it('shows what each connection still needs, and never a secret’s value', async () => {
    const harness = await bootMailer({
      env: { MAILER_READY_API_KEY: 'super-secret-value' },
      connections: [
        { id: 'ready', mailer: 'resend', name: 'Ready <b>one</b>' },
        { id: 'waiting', mailer: 'sendgrid' },
        { id: 'google', mailer: 'gmail', config: { clientId: 'cid' } },
      ],
    })
    const { user } = await harness.signIn()
    const list = await renderAdmin(harness, '/admin/mailer', user)
    expect(list).toContain('Ready &lt;b&gt;one&lt;/b&gt;')
    expect(list).toContain('<span class="mailer-mark ok">Ready</span>')
    expect(list).toContain('Set MAILER_WAITING_API_KEY')
    expect(list).toContain('Set MAILER_GOOGLE_CLIENT_SECRET')
    expect(list).toContain('<span class="mailer-mark role">Primary</span>')

    const edit = await renderAdmin(harness, '/admin/mailer/connections/ready', user)
    expect(edit).toContain('<code>MAILER_READY_API_KEY</code>')
    expect(edit).toContain('<span class="mailer-mark ok">Set</span>')
    expect(list + edit).not.toContain('super-secret-value')

    const picker = await renderAdmin(harness, '/admin/mailer/connections/new', user)
    expect(picker.match(/class="mailer-card"/g)).toHaveLength(18)
    const fresh = await renderAdmin(harness, '/admin/mailer/connections/new', user, {
      mailer: 'mailgun',
    })
    expect(fresh).toContain('name="config.domain"')
    expect(fresh).not.toContain('name="config.apiKey"')
  })
})

describe('routing rules', () => {
  it('reads the rows that have a value', () => {
    expect(
      parseConditions(
        form({
          'field.0': 'subject',
          'operator.0': 'contains',
          'value.0': ' Invoice ',
          'field.1': 'header',
          'operator.1': 'is',
          'header.1': 'X-Kind',
          'value.1': 'receipt',
          'field.2': 'to',
          'operator.2': 'is',
          'value.2': '',
        }),
      ),
    ).toEqual([
      { field: 'subject', operator: 'contains', value: 'Invoice' },
      { field: 'header', operator: 'is', value: 'receipt', header: 'X-Kind' },
    ])
    expect(() => parseConditions(form({}))).toThrow('Give the rule at least one condition.')
    expect(() =>
      parseConditions(form({ 'field.0': 'nope', 'operator.0': 'is', 'value.0': 'x' })),
    ).toThrow('Choose what to compare, and how.')
    expect(() =>
      parseConditions(
        form({ 'field.0': 'header', 'operator.0': 'is', 'value.0': 'x', 'header.0': 'a b' }),
      ),
    ).toThrow(/Name the header/)
  })

  it('are added, moved and deleted', async () => {
    const harness = await bootMailer({
      connections: [
        { id: 'a', mailer: 'resend' },
        { id: 'b', mailer: 'resend' },
      ],
    })
    const { cookie, user } = await harness.signIn()
    const add = (value: string) =>
      act(harness, cookie, 'add-route', {
        'field.0': 'subject',
        'operator.0': 'contains',
        'value.0': value,
        connection: 'b',
      })
    await add('one')
    await add('two')
    expect(
      (
        await act(harness, cookie, 'add-route', {
          'field.0': 'subject',
          'operator.0': 'is',
          'value.0': 'x',
          connection: 'gone',
        })
      ).flash?.message,
    ).toBe('Choose the connection to send through.')
    const ids = async () =>
      (await loadSending(harness.db)).routes.map((route) => route.conditions[0]!.value)
    expect(await ids()).toEqual(['one', 'two'])
    const [first] = (await loadSending(harness.db)).routes
    await act(harness, cookie, 'move-route', { id: first!.id, direction: 'down' })
    expect(await ids()).toEqual(['two', 'one'])
    const screen = await renderAdmin(harness, '/admin/mailer/routing', user)
    expect(screen).toContain('Subject contains “two”')
    await act(harness, cookie, 'delete-route', { id: first!.id })
    expect(await ids()).toEqual(['two'])
  })
})

describe('the email log', () => {
  const seeded = async () => {
    const { connection, env } = resend('main')
    const harness = await bootMailer({
      env,
      fetch: fakeFetch((call) =>
        (call.body as { subject: string }).subject.includes('fail')
          ? Response.json({ message: 'no' }, { status: 422 })
          : Response.json({ id: 'ok' }),
      ).fetch,
      connections: [connection],
      settings: { 'mailer.log_content': true },
    })
    await harness.kernel.mail.send({
      to: 'bo@example.com',
      subject: 'Welcome Bo',
      text: 'one',
      html: '<p>one</p><script>alert(1)</script>',
    })
    await harness.kernel.mail.send({ to: 'cy@example.com', subject: 'This will fail', text: 'two' })
    await harness.kernel.mail.send({
      to: 'di@example.com',
      subject: '100%_off <b>today</b>',
      text: 'three',
    })
    return harness
  }

  it('lists, filters and searches, with % and _ meaning themselves', async () => {
    const harness = await seeded()
    const list = (query: object) => listEmails(harness.db, { page: 1, perPage: 2, ...query })
    const all = await list({})
    expect(all.rows.map((row) => row.subject)).toEqual(['100%_off <b>today</b>', 'This will fail'])
    expect(all).toMatchObject({ total: 3, counts: { all: 3, sent: 2, failed: 1 } })
    expect((await list({ page: 2 })).rows.map((row) => row.subject)).toEqual(['Welcome Bo'])
    expect((await list({ status: 'failed' })).rows.map((row) => row.subject)).toEqual([
      'This will fail',
    ])
    expect((await list({ search: 'CY@' })).rows).toHaveLength(1)
    expect((await list({ search: '100%_' })).rows).toHaveLength(1)
    expect((await list({ search: '%' })).rows).toHaveLength(1)
    expect((await list({ search: '_' })).rows).toHaveLength(1)
    expect((await list({ search: 'welcome', status: 'failed' })).total).toBe(0)
  })

  it('shows an email with its markup escaped and its HTML shut in a frame without permissions', async () => {
    const harness = await seeded()
    const { user } = await harness.signIn()
    const list = await renderAdmin(harness, '/admin/mailer/log', user)
    expect(list).toContain('100%_off &lt;b&gt;today&lt;/b&gt;')
    expect(list).not.toContain('<b>today</b>')
    const rows = (await listEmails(harness.db, { page: 1, perPage: 10 })).rows
    const welcome = rows.find((row) => row.subject === 'Welcome Bo')!
    const page = await renderAdmin(harness, `/admin/mailer/log/${welcome.id}`, user)
    expect(page).toContain('sandbox=""')
    // The script is inside the frame's document, as text of an attribute, never in the page.
    expect(page).not.toContain('<script>alert(1)</script>')
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(previewDocument('<p>x</p>')).toContain("default-src 'none'")
    // A made-up id is "not found", never a database error.
    expect((await harness.kernel.resolveAdminPage('/admin/mailer/log/nope', {}, user)).kind).toBe(
      'not-found',
    )
  })

  it('sends an email again as it was, and says why it can’t when the content wasn’t kept', async () => {
    const harness = await seeded()
    const { cookie } = await harness.signIn()
    const rows = (await listEmails(harness.db, { page: 1, perPage: 10 })).rows
    const welcome = rows.find((row) => row.subject === 'Welcome Bo')!
    expect((await act(harness, cookie, 'resend-email', { id: welcome.id })).flash).toEqual({
      kind: 'notice',
      message: 'Email sent again.',
    })
    const [again] = (await listEmails(harness.db, { page: 1, perPage: 1 })).rows
    expect(again).toMatchObject({
      subject: 'Welcome Bo',
      recipients: 'bo@example.com',
      resentFrom: welcome.id,
      textBody: 'one',
    })

    // Someone copied in secret stays hidden from the others when the email is sent again.
    const network = fakeFetch()
    const copied = await bootMailer({
      env: resend('main').env,
      fetch: network.fetch,
      connections: [resend('main').connection],
      settings: { 'mailer.log_content': true },
    })
    const service = copied.kernel.service('mailer')
    await service.send({ ...MESSAGE, cc: 'Cy <cy@example.com>', bcc: 'boss@example.com' })
    const original = (await listEmails(copied.db, { page: 1, perPage: 1 })).rows[0]!
    await service.resend(original.id)
    expect(network.calls[1]!.body).toMatchObject({
      to: ['bo@example.com'],
      cc: ['cy@example.com'],
      bcc: ['boss@example.com'],
    })

    await harness.db.insert(emails).values({
      status: 'sent',
      sender: 'a@example.com',
      recipients: 'b@example.com',
      subject: 'bare',
      attempts: [],
    })
    const bare = (await listEmails(harness.db, { page: 1, perPage: 10, search: 'bare' })).rows[0]!
    expect((await act(harness, cookie, 'resend-email', { id: bare.id })).flash?.message).toMatch(
      /content wasn’t kept/,
    )
    expect((await act(harness, cookie, 'resend-email', { id: 'nope' })).flash?.message).toBe(
      'That email is no longer in the log.',
    )
  })

  it('deletes the selected emails, or all of them', async () => {
    const harness = await seeded()
    const { cookie } = await harness.signIn()
    const rows = (await listEmails(harness.db, { page: 1, perPage: 10 })).rows
    expect((await act(harness, cookie, 'delete-emails', { what: 'selected' })).flash?.message).toBe(
      'Select the emails to delete.',
    )
    const two = new URLSearchParams([
      ['what', 'selected'],
      ['ids', rows[0]!.id],
      ['ids', rows[1]!.id],
      ['ids', "'; DROP TABLE mailer_emails; --"],
    ])
    expect((await act(harness, cookie, 'delete-emails', two)).flash?.message).toBe(
      '2 emails deleted.',
    )
    expect((await act(harness, cookie, 'delete-emails', { what: 'all' })).flash?.message).toBe(
      '1 email deleted.',
    )
    expect((await listEmails(harness.db, { page: 1, perPage: 10 })).total).toBe(0)
  })

  it('exports a CSV no spreadsheet runs as formulas, for those who may manage email only', async () => {
    const harness = await seeded()
    await harness.db.insert(emails).values({
      status: 'sent',
      sender: 'a@example.com',
      recipients: 'b@example.com',
      subject: '=HYPERLINK("http://evil.test")',
      attempts: [],
    })
    const admin = await harness.signIn()
    const response = await harness.request('GET', '/api/p/mailer/export?status=sent', {
      cookie: admin.cookie,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="email-log-\d{4}-\d\d-\d\d\.csv"$/,
    )
    const lines = (await response.text()).trim().split('\r\n')
    expect(lines[0]).toBe(
      '"Date","Status","From","To","Subject","Connection","Mailer","Message ID","Error"',
    )
    expect(lines).toHaveLength(4)
    expect(
      lines.filter((line) => line.includes(`"'=HYPERLINK(""http://evil.test"")"`)),
    ).toHaveLength(1)
    expect(lines.join('\n')).not.toContain('This will fail')
    expect(csvCell('+1')).toBe(`"'+1"`)
    expect(csvCell('-1')).toBe(`"'-1"`)
    expect(csvCell('@x')).toBe(`"'@x"`)
    expect(csvCell('plain "quoted"')).toBe('"plain ""quoted"""')

    const author = await harness.signIn('author')
    expect(
      (await harness.request('GET', '/api/p/mailer/export', { cookie: author.cookie })).status,
    ).toBe(403)
    const anonymous = await harness.request('GET', '/api/p/mailer/export')
    expect(anonymous.status).toBe(302)
  })
})

describe('who may use it', () => {
  it('keeps every screen and action from people who may not manage email delivery', async () => {
    const { connection, env } = resend('main')
    const harness = await bootMailer({ env, fetch: fakeFetch().fetch, connections: [connection] })
    const author = await harness.signIn('author')
    for (const path of [
      '/admin/mailer',
      '/admin/mailer/log',
      '/admin/mailer/tools',
      '/admin/mailer/routing',
      '/admin/mailer/reports',
      '/admin/mailer/settings',
      '/admin/mailer/connections/main',
    ]) {
      expect([path, (await harness.kernel.resolveAdminPage(path, {}, author.user)).kind]).toEqual([
        path,
        'forbidden',
      ])
    }
    for (const name of [
      'save-connection',
      'delete-connection',
      'set-role',
      'send-test',
      'add-route',
      'delete-route',
      'move-route',
      'resend-email',
      'delete-emails',
      'clear-events',
      'disconnect',
    ]) {
      const response = await harness.request('POST', `/api/p/mailer/actions/${name}`, {
        cookie: author.cookie,
        form: { id: 'main' },
      })
      expect([name, response.status]).toEqual([name, 403])
    }
    expect(await getConnection(harness.db, 'main')).not.toBeNull()
    expect(
      harness.kernel.adminMenu(author.user).some((section) => section.label === 'Mailer'),
    ).toBe(false)
    const admin = await harness.signIn()
    const menu = harness.kernel.adminMenu(admin.user).find((section) => section.label === 'Mailer')
    expect(menu?.items.map((item) => item.label)).toEqual([
      'Connections',
      'Smart Routing',
      'Email Log',
      'Reports',
      'Tools',
      'Settings',
    ])
  })

  it('refuses a form posted from another site', async () => {
    const harness = await bootMailer({ connections: [{ id: 'main', mailer: 'resend' }] })
    const { cookie } = await harness.signIn()
    const response = await harness.request('POST', '/api/p/mailer/actions/delete-connection', {
      cookie,
      form: { id: 'main' },
      headers: { origin: 'https://evil.test' },
    })
    expect(response.status).toBe(403)
    expect(await getConnection(harness.db, 'main')).not.toBeNull()
  })
})

describe('tools, reports and the dashboard', () => {
  it('sends a test through one connection, over real SMTP, and reports a failure in words', async () => {
    const received: { to: string[]; subject: string | undefined; html: string }[] = []
    const server = new SMTPServer({
      disabledCommands: ['STARTTLS', 'AUTH'],
      onData(stream, session, callback) {
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => {
          void simpleParser(Buffer.concat(chunks)).then((mail) => {
            received.push({
              to: session.envelope.rcptTo.map((r) => r.address),
              subject: mail.subject,
              html: mail.html || '',
            })
            callback()
          })
        })
      },
    })
    server.listen(0, '127.0.0.1')
    await once(server.server, 'listening')
    const port = (server.server.address() as AddressInfo).port
    try {
      const harness = await bootMailer({
        settings: { 'site.title': 'Shop & <Co>' },
        connections: [
          {
            id: 'main',
            mailer: 'smtp',
            name: 'Office',
            config: {
              host: '127.0.0.1',
              port,
              encryption: 'none',
              autoTls: false,
              verifyCertificate: true,
            },
          },
          {
            id: 'dead',
            mailer: 'smtp',
            config: {
              host: '127.0.0.1',
              port: 1,
              encryption: 'none',
              autoTls: false,
              verifyCertificate: true,
            },
          },
        ],
        backup: 'main',
      })
      const { cookie, user } = await harness.signIn()
      expect(
        (
          await act(harness, cookie, 'send-test', {
            to: 'me@example.com',
            connection: 'main',
            html: 'on',
          })
        ).flash,
      ).toEqual({
        kind: 'notice',
        message: 'Test email sent to me@example.com.',
      })
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({
        to: ['me@example.com'],
        subject: 'Test email from Shop & <Co>',
      })
      expect(received[0]!.html).toContain('Shop &#38; &#60;Co&#62;')

      // A test of a dead connection fails: it never goes to the backup instead.
      const failed = await act(harness, cookie, 'send-test', {
        to: 'me@example.com',
        connection: 'dead',
      })
      expect(failed.flash?.kind).toBe('error')
      expect(failed.flash?.message).toMatch(
        /^The test wasn’t sent\. Couldn't reach the SMTP server: /,
      )
      expect(received).toHaveLength(1)
      expect(
        (await act(harness, cookie, 'send-test', { to: 'nope', connection: 'main' })).flash
          ?.message,
      ).toBe('Enter the email address to send the test to.')

      const tools = await renderAdmin(harness, '/admin/mailer/tools', user)
      expect(tools).toContain(`value="${user.email}"`)
      expect(tools).toContain('Couldn&#x27;t reach the SMTP server')
      expect((await act(harness, cookie, 'clear-events', {})).flash?.message).toBe(
        'Events cleared.',
      )
      expect(await listEvents(harness.db, 5)).toEqual([])
      const bad = await renderAdmin(harness, '/admin/mailer/tools', user, {
        domain: 'not a domain',
      })
      expect(bad).toContain('isn&#x27;t a domain name')
    } finally {
      await new Promise((done) => server.close(() => done(null)))
    }
  })

  it('counts by day and by subject, and shows the week on the dashboard', async () => {
    const { connection, env } = resend('main')
    const harness = await bootMailer({
      env,
      fetch: fakeFetch((call) =>
        (call.body as { subject: string }).subject === 'Bad'
          ? Response.json({ message: 'no' }, { status: 422 })
          : Response.json({ id: 'ok' }),
      ).fetch,
      connections: [connection],
    })
    await harness.kernel.mail.send(MESSAGE)
    await harness.kernel.mail.send(MESSAGE)
    await harness.kernel.mail.send({ ...MESSAGE, subject: 'Bad' })
    await harness.db.insert(emails).values({
      status: 'sent',
      sender: 'a',
      recipients: 'b',
      subject: 'Old',
      attempts: [],
      createdAt: new Date(Date.now() - 10 * 86_400_000),
    })
    const { user } = await harness.signIn()
    const week = await renderAdmin(harness, '/admin/mailer/reports', user)
    expect(week).toContain('<b>3</b> emails')
    expect(week).toContain('<b>2</b> sent')
    expect(week).toContain('<b>1</b> failed')
    expect(week).toContain('<b>67%</b>')
    expect(week).not.toContain('Old')
    const fortnight = await renderAdmin(harness, '/admin/mailer/reports', user, { days: '14' })
    expect(fortnight).toContain('<b>4</b> emails')
    expect(fortnight).toContain('Old')
    // An unknown range falls back to the week.
    expect(await renderAdmin(harness, '/admin/mailer/reports', user, { days: '9999' })).toContain(
      '<b>3</b> emails',
    )
    expect(pageOf({ page: '3' })).toBe(3)
    expect(pageOf({ page: '-1' })).toBe(1)
    expect(pageOf({ page: ['2', '9'] })).toBe(2)
  })
})
