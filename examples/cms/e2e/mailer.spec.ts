import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { simpleParser, type ParsedMail } from 'mailparser'
import { SMTPServer } from 'smtp-server'

// The Mailer plugin in a CMS site, sending to a real SMTP server this file runs. One site and
// one inbox, set up by the first test.
test.describe.configure({ mode: 'serial' })

const ADMIN = { name: 'Ada Admin', email: 'ada@example.com', password: 'a strong e2e password' }
const SMTP_PORT = 3481
/** A port nothing listens on, for a connection that fails. */
const DEAD_PORT = 3482

const inbox: { to: string[]; mail: ParsedMail }[] = []
let server: SMTPServer

test.beforeAll(async () => {
  server = new SMTPServer({
    disabledCommands: ['STARTTLS', 'AUTH'],
    onData(stream, session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        void simpleParser(Buffer.concat(chunks)).then((mail) => {
          inbox.push({ to: session.envelope.rcptTo.map((recipient) => recipient.address), mail })
          callback()
        })
      })
    },
  })
  server.listen(SMTP_PORT, '127.0.0.1')
  await once(server.server, 'listening')
})

test.afterAll(async () => {
  await new Promise((done) => server.close(() => done(null)))
})

async function signIn(page: Page) {
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/admin\/login\?next=/)
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Log In' }).click()
  await expect(page).not.toHaveURL(/\/admin\/login/)
}

const notice = (page: Page, message: string | RegExp) =>
  expect(page.getByRole('status').filter({ hasText: message })).toBeVisible()

/** The message of a form that was refused. */
const problem = (page: Page, message: string | RegExp) =>
  expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible()

const menu = (page: Page, label: string) =>
  page
    .getByRole('navigation', { name: 'Main menu' })
    .getByRole('link', { name: label, exact: true })

/** One of Mailer's own pages, in its submenu: the CMS has a Tools section of its own too. */
const submenu = (page: Page, label: string) =>
  page
    .getByRole('navigation', { name: 'Main menu' })
    .getByRole('list', { name: 'Mailer' })
    .getByRole('link', { name: label, exact: true })

/** The next email to arrive after `action`. */
async function arrives(action: () => Promise<unknown>) {
  const before = inbox.length
  await action()
  await expect.poll(() => inbox.length, { timeout: 15_000 }).toBeGreaterThan(before)
  return inbox.at(-1)!
}

async function addSmtp(page: Page, id: string, name: string, port: number) {
  await page.goto('/admin/mailer/connections/new')
  await page.getByRole('link', { name: /^Other SMTP/ }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('ID', { exact: true }).fill(id)
  await page.getByLabel('SMTP host').fill('127.0.0.1')
  await page.getByLabel('Encryption').selectOption('none')
  await page.getByLabel('SMTP port').fill(String(port))
  await page.getByLabel('Auto TLS').uncheck()
  await page.getByRole('button', { name: 'Add Connection' }).click()
  await notice(page, 'Connection added.')
  await expect(page).toHaveURL(new RegExp(`/admin/mailer/connections/${id}(\\?|$)`))
}

async function sendTest(page: Page, connection: string) {
  await page.goto('/admin/mailer/tools')
  await page.getByLabel('Send to').fill('reader@example.com')
  await page.getByLabel('Through').selectOption({ label: connection })
  await page.getByRole('button', { name: 'Send Test Email' }).click()
}

async function lostPassword(page: Page) {
  await page.goto('/account/lost-password')
  await page.getByLabel('Email address').fill(ADMIN.email)
  await page.getByRole('button', { name: 'Get a new password' }).click()
  await expect(page.getByRole('status')).toContainText('we’ve emailed it a link')
}

test('the first visit sets up the administrator', async ({ page }) => {
  await page.goto('/admin')
  await expect(page).toHaveURL('/admin/setup')
  await page.getByLabel('Name').fill(ADMIN.name)
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Create administrator' }).click()
  await notice(page, 'Your site is ready.')
})

test('Mailer says what’s missing until a connection is added', async ({ page }) => {
  await signIn(page)
  await menu(page, 'Mailer').click()
  await expect(page).toHaveURL('/admin/mailer')
  await expect(page.getByText('No connection yet')).toBeVisible()
  await submenu(page, 'Tools').click()
  await expect(page.getByRole('link', { name: 'Add a connection' })).toBeVisible()
  // The dashboard points here too.
  await page.goto('/admin')
  await expect(page.getByRole('link', { name: 'Set up a connection' })).toBeVisible()
})

test('an SMTP connection is added from the mailer picker, and is the primary one', async ({
  page,
}) => {
  await signIn(page)
  await page.goto('/admin/mailer')
  await page.getByRole('link', { name: 'Add a connection' }).click()
  await expect(page.locator('.mailer-card')).toHaveCount(18)
  await addSmtp(page, 'main', 'Office server', SMTP_PORT)
  await page.getByRole('link', { name: '← Back to connections' }).click()
  const row = page.getByRole('row', { name: /Office server/ })
  await expect(row).toContainText('Primary')
  await expect(row).toContainText('Other SMTP')
  await expect(row).toContainText('Ready')
  await expect(page.getByText('The site has no sender yet')).toBeVisible()
})

test('a test email arrives once the site has a sender', async ({ page }) => {
  await signIn(page)
  await sendTest(page, 'Office server')
  await problem(
    page,
    'The test wasn’t sent. The site has no sender. Set “Send email from” in Settings › General.',
  )

  await page.goto('/admin/settings')
  await page.getByLabel('Send email from').fill('E2E Site <site@example.com>')
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await notice(page, 'Settings saved.')

  const { to, mail } = await arrives(() => sendTest(page, 'Office server'))
  await notice(page, 'Test email sent to reader@example.com.')
  expect(to).toEqual(['reader@example.com'])
  expect(mail.from?.value).toEqual([{ address: 'site@example.com', name: 'E2E Site' }])
  expect(mail.subject).toMatch(/^Test email from /)
  expect(mail.text).toContain('that connection works')
  expect(mail.html).toContain('<strong>')
})

test('the site’s own email goes out through the plugin, and its link works', async ({ page }) => {
  const { to, mail } = await arrives(() => lostPassword(page))
  expect(to).toEqual([ADMIN.email])
  expect(mail.subject).toContain('Password reset')
  const link = /https?:\/\/\S+/.exec(mail.text ?? '')?.[0]
  expect(link).toBeTruthy()
  await page.goto(new URL(link!).pathname + new URL(link!).search)
  await page.getByLabel('New password').fill('a second e2e password')
  await page.getByRole('button', { name: 'Set password' }).click()
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()
  ADMIN.password = 'a second e2e password'
})

test('the log lists every email, without its content unless that’s kept', async ({ page }) => {
  await signIn(page)
  await menu(page, 'Mailer').click()
  await submenu(page, 'Email Log').click()
  const table = page.getByRole('table')
  await expect(table.getByRole('link', { name: /Password reset/ })).toBeVisible()
  await expect(table.getByRole('row').filter({ hasText: 'Test email from' })).toHaveCount(2)
  await page.getByRole('link', { name: /^Failed/ }).click()
  await expect(table.getByRole('row').filter({ hasText: 'Test email from' })).toHaveCount(1)
  await page.getByRole('link', { name: /^Sent/ }).click()
  await page.getByRole('searchbox').fill('password')
  await page.getByRole('button', { name: 'Search Emails' }).click()
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await table
    .getByRole('link', { name: /Password reset/ })
    .first()
    .click()
  await expect(page.getByText('This email’s content wasn’t kept.')).toBeVisible()
  await expect(page.locator('#mailer-email-details')).toContainText(ADMIN.email)
  await expect(page.getByRole('button', { name: 'Resend' })).toHaveCount(0)
})

test('with content kept, an email shows in a sandboxed frame and can be sent again', async ({
  page,
}) => {
  await signIn(page)
  await page.goto('/admin/mailer/settings')
  await page.getByLabel('Log email content').check()
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await notice(page, 'Settings saved.')

  await arrives(() => sendTest(page, 'Office server'))
  await page.goto('/admin/mailer/log')
  await page
    .getByRole('table')
    .getByRole('link', { name: /^Test email from/ })
    .first()
    .click()
  const frame = page.locator('iframe.mailer-preview')
  await expect(frame).toHaveAttribute('sandbox', '')
  await expect(frame.contentFrame().getByText('that connection works')).toBeVisible()
  await expect(page.locator('pre.mailer-pre')).toContainText('that connection works')

  const again = await arrives(() => page.getByRole('button', { name: 'Resend' }).click())
  await notice(page, 'Email sent again.')
  expect(again.to).toEqual(['reader@example.com'])
  expect(again.mail.subject).toMatch(/^Test email from /)
})

test('a service’s key is read from the environment, and never shown', async ({ page }) => {
  await signIn(page)
  await page.goto('/admin/mailer/connections/new')
  await page.getByRole('link', { name: /^Resend/ }).click()
  await expect(page.getByText('Set in the site’s environment, never stored here.')).toBeVisible()
  await page.getByLabel('ID', { exact: true }).fill('service')
  await page.getByRole('button', { name: 'Add Connection' }).click()
  await notice(page, 'Connection added.')
  await expect(page.getByText('MAILER_SERVICE_API_KEY')).toBeVisible()
  await expect(page.locator('.mailer-mark.ok', { hasText: 'Set' })).toBeVisible()
  expect(await page.content()).not.toContain('re_e2e_secret_key')
  // Deleted again: this run must not call a real service.
  await page.goto('/admin/mailer')
  await page.getByRole('row', { name: /Resend/ }).hover()
  await page
    .getByRole('row', { name: /Resend/ })
    .getByRole('button', { name: 'Delete' })
    .click()
  await notice(page, 'Connection deleted.')
})

test('when the primary connection fails, the backup sends, and the failure is on record', async ({
  page,
}) => {
  await signIn(page)
  await addSmtp(page, 'dead', 'Dead server', DEAD_PORT)
  await page.goto('/admin/mailer')
  const dead = page.getByRole('row', { name: /Dead server/ })
  await dead.hover()
  await dead.getByRole('button', { name: 'Make primary' }).click()
  await notice(page, 'Dead server is now the primary connection.')
  const office = page.getByRole('row', { name: /Office server/ })
  await office.hover()
  await office.getByRole('button', { name: 'Use as backup' }).click()
  await notice(page, 'Office server is now the backup connection.')
  await expect(office).toContainText('Backup')

  const { mail } = await arrives(() => lostPassword(page))
  expect(mail.subject).toContain('Password reset')

  await page.goto('/admin/mailer/log')
  await page
    .getByRole('table')
    .getByRole('link', { name: /Password reset/ })
    .first()
    .click()
  const delivery = page.locator('#mailer-email-attempts')
  await expect(delivery.getByRole('row')).toHaveCount(3)
  await expect(delivery).toContainText("Couldn't reach the SMTP server")
  await expect(delivery).toContainText('Sent')

  // A test goes through the connection named only: it fails, and never reaches the backup.
  const before = inbox.length
  await sendTest(page, 'Dead server')
  await problem(page, /The test wasn’t sent\. Couldn't reach the SMTP server/)
  expect(inbox.length).toBe(before)
  await expect(page.locator('#events ~ table').first()).toContainText(
    "Couldn't reach the SMTP server",
  )
})

test('a routing rule sends matching email through another connection', async ({ page }) => {
  await signIn(page)
  await page.goto('/admin/mailer/routing')
  await page.getByLabel('Condition 1: what to look at').selectOption('subject')
  await page.getByLabel('Condition 1: comparison').selectOption('contains')
  await page.getByLabel('Condition 1: value').fill('password reset')
  await page.getByLabel('Send through').selectOption({ label: 'Office server' })
  await page.getByRole('button', { name: 'Add Rule' }).click()
  await notice(page, 'Rule added.')
  await expect(page.getByRole('table')).toContainText('Subject contains “password reset”')

  await arrives(() => lostPassword(page))
  await page.goto('/admin/mailer/log')
  await page
    .getByRole('table')
    .getByRole('link', { name: /Password reset/ })
    .first()
    .click()
  // Straight through the rule's connection: one try, not a failure and a fallback.
  await expect(page.locator('#mailer-email-attempts').getByRole('row')).toHaveCount(2)
})

test('reports count the emails, and the log exports as CSV', async ({ page }) => {
  await signIn(page)
  await page.goto('/admin/mailer/reports')
  const totals = page.locator('.mailer-totals')
  await expect(totals).toContainText(`${inbox.length} sent`)
  await expect(totals).toContainText('2 failed')
  await expect(page.getByRole('table', { name: 'Most sent subjects' })).toContainText(
    'Password reset',
  )

  await page.goto('/admin')
  await expect(page.locator('#mailer-widget')).toContainText(`${inbox.length} sent`)
  await expect(page.locator('#mailer-widget')).toContainText('2 failed')

  await page.goto('/admin/mailer/log')
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Export CSV' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^email-log-\d{4}-\d\d-\d\d\.csv$/)
  const csv = readFileSync(await file.path(), 'utf8')
  expect(csv.split('\r\n')[0]).toBe(
    '"Date","Status","From","To","Subject","Connection","Mailer","Message ID","Error"',
  )
  expect(csv).toContain('"failed"')
  expect(csv.trim().split('\r\n')).toHaveLength(inbox.length + 2 + 1)
})

test('"Do not send" stops every email, and deleting clears the log', async ({ page }) => {
  await signIn(page)
  await page.goto('/admin/mailer/settings')
  await page.getByLabel('Do not send').check()
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await notice(page, 'Settings saved.')
  const before = inbox.length
  await sendTest(page, 'Office server')
  await problem(page, /Sending is turned off/)
  expect(inbox.length).toBe(before)
  await page.goto('/admin/mailer')
  await expect(page.getByText('“Do not send” is on')).toBeVisible()

  await page.goto('/admin/mailer/log')
  await page.getByRole('button', { name: 'Delete all' }).click()
  await notice(page, /emails deleted\./)
  await expect(page.getByText('No emails yet.')).toBeVisible()
})
