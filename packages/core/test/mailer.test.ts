import { describe, expect, it } from 'vitest'
import {
  createMailer,
  DeliveryError,
  matches,
  prepare,
  routeFor,
  type Condition,
  type Connection,
} from '../src/index.ts'
import { fakeFetch, FULL, json } from './helpers.ts'

const resend = (id: string): Connection => ({
  id,
  mailer: 'resend',
  config: { apiKey: `key-${id}` },
})
const keyOf = (call: { headers: Record<string, string> }) =>
  call.headers.authorization?.replace('Bearer key-', '')

describe('createMailer', () => {
  it('loads and checks nothing until an email is sent', async () => {
    const mailer = createMailer({ connections: [{ id: 'main', mailer: 'sendgrid', config: {} }] })
    await expect(mailer.send(FULL)).rejects.toMatchObject({ code: 'not-configured' })
  })

  it('sends through the primary connection, the first unless named', async () => {
    const { fetch, calls } = fakeFetch(json({ id: 'r1' }))
    await createMailer({ connections: [resend('a'), resend('b')], fetch }).send(FULL)
    await createMailer({ connections: [resend('a'), resend('b')], primary: 'b', fetch }).send(FULL)
    expect(calls.map(keyOf)).toEqual(['a', 'b'])
  })

  it('tries the backup when the first fails, and says so', async () => {
    const { fetch, calls } = fakeFetch(
      json({ message: 'down' }, { status: 503 }),
      json({ id: 'r2' }),
    )
    const delivery = await createMailer({
      connections: [resend('a'), resend('b')],
      backup: 'b',
      fetch,
    }).send(FULL)
    expect(calls.map(keyOf)).toEqual(['a', 'b'])
    expect(delivery).toMatchObject({ connection: 'b', providerId: 'r2' })
    expect(delivery.attempts).toMatchObject([
      { connection: 'a', ok: false, error: { code: 'unavailable', status: 503 } },
      { connection: 'b', ok: true, providerId: 'r2', error: null },
    ])
  })

  it('reports every try when the backup fails too', async () => {
    const { fetch } = fakeFetch(
      json({ message: 'down' }, { status: 503 }),
      json({ message: 'bad key' }, { status: 401 }),
    )
    const error = await createMailer({
      connections: [resend('a'), resend('b')],
      backup: 'b',
      fetch,
    })
      .send(FULL)
      .catch((caught: DeliveryError) => caught)
    expect(error).toBeInstanceOf(DeliveryError)
    expect(error).toMatchObject({ code: 'auth', status: 401 })
    expect((error as DeliveryError).message).toBe(
      'Resend refused the email (HTTP 503): down The backup connection failed too: Resend refused the email (HTTP 401): bad key',
    )
    expect((error as DeliveryError).attempts.map((attempt) => attempt.ok)).toEqual([false, false])
    expect((error as DeliveryError).email.subject).toBe(FULL.subject)
  })

  it('sends a test through one connection only: no rules, no backup', async () => {
    const { fetch, calls } = fakeFetch(json({ message: 'down' }, { status: 503 }))
    const mailer = createMailer({
      connections: [resend('a'), resend('b'), resend('c')],
      backup: 'b',
      routes: [
        {
          connection: 'c',
          conditions: [{ field: 'subject', operator: 'contains', value: 'order' }],
        },
      ],
      fetch,
    })
    await expect(mailer.send(FULL, { connection: 'a' })).rejects.toBeInstanceOf(DeliveryError)
    expect(calls.map(keyOf)).toEqual(['a'])
    await expect(mailer.send(FULL, { connection: 'nope' })).rejects.toThrow(
      'There is no connection "nope".',
    )
  })

  it('routes by rule, first match first, and falls back to the primary', async () => {
    const { fetch, calls } = fakeFetch(json({ id: 'r' }))
    const mailer = createMailer({
      connections: [resend('a'), resend('orders'), resend('news')],
      routes: [
        {
          connection: 'orders',
          conditions: [{ field: 'subject', operator: 'contains', value: 'ORDER' }],
        },
        {
          connection: 'news',
          conditions: [{ field: 'to', operator: 'endsWith', value: '@example.com' }],
        },
        { connection: 'gone', conditions: [{ field: 'subject', operator: 'is', value: 'hello' }] },
      ],
      fetch,
    })
    await mailer.send(FULL)
    await mailer.send({ ...FULL, subject: 'News' })
    await mailer.send({
      ...FULL,
      subject: 'News',
      to: 'x@other.test',
      cc: undefined,
      bcc: undefined,
    })
    // A rule naming a connection that's gone doesn't lose the email.
    await mailer.send({ ...FULL, subject: 'Hello', to: 'x@other.test' })
    expect(calls.map(keyOf)).toEqual(['orders', 'news', 'a', 'a'])
  })

  it('refuses a message that isn’t valid before any connection is tried', async () => {
    const { fetch, calls } = fakeFetch(json({ id: 'r' }))
    const mailer = createMailer({ connections: [resend('a')], backup: 'a', fetch })
    await expect(mailer.send({ ...FULL, to: 'nope' })).rejects.toMatchObject({
      code: 'invalid-message',
    })
    expect(calls).toEqual([])
  })

  it('says so when there is nothing to send through', async () => {
    await expect(createMailer({ connections: [] }).send(FULL)).rejects.toThrow(
      'No connection is set up to send email.',
    )
  })

  it('applies the default sender to every email', async () => {
    const { fetch, calls } = fakeFetch(json({ id: 'r' }))
    const mailer = createMailer({
      connections: [resend('a')],
      from: 'Site <site@example.com>',
      forceFromEmail: true,
      fetch,
    })
    await mailer.send(FULL)
    expect((calls[0]!.body as { from: string }).from).toBe('"Ada Admin" <site@example.com>')
  })

  it('stops when the caller gives up, without starting on the backup', async () => {
    const controller = new AbortController()
    const calls: string[] = []
    const mailer = createMailer({
      connections: [resend('a'), resend('b')],
      backup: 'b',
      fetch: (_input, init) => {
        calls.push('call')
        controller.abort()
        return Promise.reject(init!.signal!.reason)
      },
    })
    await expect(mailer.send(FULL, { signal: controller.signal })).rejects.toMatchObject({
      code: 'timeout',
    })
    expect(calls).toHaveLength(1)
  })
})

describe('routing rules', () => {
  const email = prepare({ ...FULL, headers: { 'X-Kind': 'Invoice' } })
  const test = (
    field: Condition['field'],
    operator: Condition['operator'],
    value: string,
    header?: string,
  ) => matches(email, { field, operator, value, header })

  it('compare without regard to letter case', () => {
    expect(test('subject', 'contains', 'ORDER')).toBe(true)
    expect(test('subject', 'is', 'your order №7 is ready')).toBe(true)
    expect(test('subject', 'startsWith', 'your')).toBe(true)
    expect(test('subject', 'endsWith', 'READY')).toBe(true)
    expect(test('subject', 'notContains', 'invoice')).toBe(true)
    expect(test('subject', 'isNot', 'Your order №7 is ready')).toBe(false)
  })

  it('look at every part of the email', () => {
    expect(test('body', 'contains', '<b>order</b>')).toBe(true)
    expect(test('body', 'contains', 'thanks for your order.')).toBe(true)
    expect(test('to', 'is', 'cy@example.com')).toBe(true)
    expect(test('cc', 'is', 'di@example.com')).toBe(true)
    expect(test('bcc', 'contains', 'eve@')).toBe(true)
    expect(test('from', 'endsWith', '@example.com')).toBe(true)
    expect(test('fromName', 'is', 'ada admin')).toBe(true)
    expect(test('replyTo', 'startsWith', 'help@')).toBe(true)
    expect(test('header', 'is', 'invoice', 'x-kind')).toBe(true)
    expect(test('header', 'is', 'invoice', 'X-Other')).toBe(false)
  })

  it('with several values: "is" passes on any, "is not" only when none is', () => {
    expect(test('to', 'is', 'bo@example.com')).toBe(true)
    expect(test('to', 'isNot', 'bo@example.com')).toBe(false)
    expect(test('to', 'isNot', 'zed@example.com')).toBe(true)
    expect(test('to', 'notContains', 'example.com')).toBe(false)
  })

  it('never match on an empty value, and a rule without conditions matches nothing', () => {
    expect(test('subject', 'contains', '  ')).toBe(false)
    expect(test('subject', 'notContains', '')).toBe(false)
    expect(routeFor(email, [{ connection: 'x', conditions: [] }])).toBeNull()
    expect(
      routeFor(email, [
        {
          connection: 'both',
          conditions: [
            { field: 'subject', operator: 'contains', value: 'order' },
            { field: 'to', operator: 'is', value: 'nobody@example.com' },
          ],
        },
        {
          connection: 'one',
          conditions: [{ field: 'subject', operator: 'contains', value: 'order' }],
        },
      ]),
    ).toBe('one')
  })
})
