import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { simpleParser, type ParsedMail } from 'mailparser'
import { SMTPServer, type SMTPServerOptions } from 'smtp-server'
import { afterEach, describe, expect, it } from 'vitest'
import { createMailer, type MailerError, type MailerOptions } from '../src/index.ts'
import { FULL } from './helpers.ts'

interface Received {
  from: string
  to: string[]
  raw: string
  mail: ParsedMail
  secure: boolean
  user: string | null
}

const servers: SMTPServer[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((done) => server.close(() => done(null)))),
  )
})

/** A real SMTP server on a free local port, which keeps what it receives. */
async function smtpServer(options: SMTPServerOptions = {}) {
  const received: Received[] = []
  const server = new SMTPServer({
    disabledCommands: ['STARTTLS', 'AUTH'],
    ...options,
    onData(stream, session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        void simpleParser(raw).then((mail) => {
          received.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            to: session.envelope.rcptTo.map((recipient) => recipient.address),
            raw,
            mail,
            secure: session.secure,
            user: typeof session.user === 'string' ? session.user : null,
          })
          callback()
        })
      })
    },
  })
  servers.push(server)
  server.on('error', () => {})
  server.listen(0, '127.0.0.1')
  await once(server.server, 'listening')
  return { port: (server.server.address() as AddressInfo).port, received }
}

function mailer(
  port: number,
  config: Record<string, unknown> = {},
  options: Partial<MailerOptions> = {},
) {
  return createMailer({
    connections: [
      {
        id: 'main',
        mailer: 'smtp',
        config: { host: '127.0.0.1', port, encryption: 'none', ...config },
      },
    ],
    ...options,
  })
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected the send to fail')
    },
    (error: MailerError) => error,
  )

describe('SMTP, against a real server', () => {
  it('delivers the whole email, with Bcc in the envelope only', async () => {
    const { port, received } = await smtpServer()
    const delivery = await mailer(port).send(FULL)
    expect(delivery).toMatchObject({ connection: 'main', mailer: 'smtp' })
    expect(delivery.attempts[0]?.detail).toMatch(/^250 /)
    expect(received).toHaveLength(1)
    const [message] = received
    expect(message!.from).toBe('ada@example.com')
    expect(message!.to).toEqual([
      'bo@example.com',
      'cy@example.com',
      'di@example.com',
      'eve@example.com',
    ])
    expect(message!.raw).not.toMatch(/eve@example\.com/)
    expect(message!.mail.subject).toBe(FULL.subject)
    expect(message!.mail.messageId).toBe(delivery.email.messageId)
    expect(message!.mail.text?.trim()).toBe(FULL.text)
    expect(message!.mail.attachments.map((file) => file.filename).sort()).toEqual([
      'logo.png',
      'report.pdf',
    ])
  })

  it('keeps lines that start with a dot, and bounces go to the return path', async () => {
    const { port, received } = await smtpServer()
    const text = '.one dot\n..two dots\n.\nFrom the start\nlast'
    await mailer(port).send({
      from: 'a@example.com',
      to: 'bo@example.com',
      subject: 's',
      text,
      returnPath: 'bounces@example.com',
    })
    expect(received[0]!.mail.text).toBe(`${text}\n`)
    expect(received[0]!.from).toBe('bounces@example.com')
  })

  it('signs in, and reports a refused sign-in as one to fix', async () => {
    const { port, received } = await smtpServer({
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      onAuth(auth, _session, callback) {
        if (auth.username === 'site' && auth.password === 'right')
          return callback(null, { user: 'site' })
        callback(new Error('Invalid username or password'))
      },
    })
    await mailer(port, { username: 'site', password: 'right' }).send(FULL)
    expect(received[0]!.user).toBe('site')

    const error = await failure(
      mailer(port, { username: 'site', password: 'wrong-password' }).send(FULL),
    )
    expect(error).toMatchObject({ code: 'auth', retryable: false })
    expect(error.message).toMatch(/^The SMTP server refused the sign-in: /)
    expect(error.message).not.toContain('wrong-password')
    expect(received).toHaveLength(1)
  })

  it('refuses to send without encryption when TLS is asked for', async () => {
    const { port, received } = await smtpServer()
    const error = await failure(mailer(port, { encryption: 'tls' }).send(FULL))
    expect(error).toMatchObject({ code: 'rejected', retryable: false })
    expect(error.message).toMatch(/^Couldn't make an encrypted connection to the SMTP server: /)
    expect(received).toEqual([])
  })

  it('encrypts with STARTTLS, and checks the certificate unless told not to', async () => {
    // smtp-server brings a self-signed certificate for localhost.
    const { port, received } = await smtpServer({ disabledCommands: ['AUTH'] })
    const refused = await failure(mailer(port, { encryption: 'tls' }).send(FULL))
    expect(refused).toMatchObject({ code: 'rejected', retryable: false })
    expect(refused.message).toMatch(/certificate/)
    expect(received).toEqual([])
    await mailer(port, { encryption: 'tls', verifyCertificate: false }).send(FULL)
    expect(received[0]!.secure).toBe(true)
  })

  it('reports a recipient the server refuses, and a server that is not there', async () => {
    const { port } = await smtpServer({
      onRcptTo(address, _session, callback) {
        callback(
          address.address.startsWith('bo@')
            ? Object.assign(new Error('No such user here'), { responseCode: 550 })
            : null,
        )
      },
    })
    const refused = await failure(
      mailer(port).send({ from: 'a@example.com', to: 'bo@example.com', subject: 's', text: 't' }),
    )
    expect(refused).toMatchObject({ code: 'rejected', status: 550 })
    expect(refused.message).toContain('No such user here')

    const gone = await failure(mailer(1).send(FULL))
    expect(gone).toMatchObject({ code: 'network', retryable: true })
    expect(gone.message).toMatch(/^Couldn't reach the SMTP server: /)
  })

  it('checks the settings without sending', async () => {
    const { port, received } = await smtpServer()
    await expect(mailer(port).verify()).resolves.toBeUndefined()
    await expect(mailer(1).verify()).rejects.toMatchObject({ code: 'network' })
    expect(received).toEqual([])
  })

  it('falls back to the backup connection when the first is down', async () => {
    const { port, received } = await smtpServer()
    const delivery = await createMailer({
      connections: [
        { id: 'main', mailer: 'smtp', config: { host: '127.0.0.1', port: 1, encryption: 'none' } },
        { id: 'spare', mailer: 'smtp', config: { host: '127.0.0.1', port, encryption: 'none' } },
      ],
      backup: 'spare',
    }).send(FULL)
    expect(delivery.connection).toBe('spare')
    expect(delivery.attempts.map((attempt) => [attempt.connection, attempt.ok])).toEqual([
      ['main', false],
      ['spare', true],
    ])
    expect(received).toHaveLength(1)
  })
})
