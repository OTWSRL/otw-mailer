import { describe, expect, it } from 'vitest'
import { formatAddress, isEmail, MailerError, parseAddress, prepare } from '../src/index.ts'
import { FULL } from './helpers.ts'

const invalid = (fn: () => unknown, words: RegExp) => {
  expect(fn).toThrow(MailerError)
  expect(fn).toThrow(words)
  try {
    fn()
  } catch (error) {
    expect((error as MailerError).code).toBe('invalid-message')
  }
}

describe('addresses', () => {
  it('reads an address on its own, with a name, and in parts', () => {
    expect(parseAddress(' ada@example.com ')).toEqual({ email: 'ada@example.com', name: '' })
    expect(parseAddress('Ada Admin <ada@example.com>')).toEqual({
      email: 'ada@example.com',
      name: 'Ada Admin',
    })
    expect(parseAddress('"Admin, Ada \\"A\\"" <ada@example.com>').name).toBe('Admin, Ada "A"')
    expect(parseAddress({ email: 'ada@example.com', name: ' Ada ' }).name).toBe('Ada')
  })

  it('refuses what isn’t an address, and anything that could start a header', () => {
    for (const bad of ['ada', 'ada@', '@example.com', 'ada@example', 'a b@example.com', '']) {
      invalid(() => parseAddress(bad), /isn't an email address/)
    }
    invalid(() => parseAddress('ada@example.com\r\nBcc: x@evil.test'), /isn't an email address/)
    invalid(
      () => parseAddress({ email: 'ada@example.com', name: 'Ada\r\nBcc: x@evil.test' }),
      /line break/,
    )
    invalid(() => parseAddress('Ada\nX <ada@example.com>'), /line break|isn't an email/)
    expect(isEmail(`${'a'.repeat(250)}@example.com`)).toBe(false)
  })

  it('writes an address so a comma or a quote in the name can’t be read as another', () => {
    expect(formatAddress({ email: 'ada@example.com', name: '' })).toBe('ada@example.com')
    expect(formatAddress({ email: 'ada@example.com', name: 'Admin, "Ada"' })).toBe(
      '"Admin, \\"Ada\\"" <ada@example.com>',
    )
  })
})

describe('prepare', () => {
  it('puts a message in one shape', () => {
    const email = prepare(FULL, { now: () => new Date('2026-11-12T10:20:30Z') })
    expect(email).toMatchObject({
      from: { email: 'ada@example.com', name: 'Ada Admin' },
      to: [
        { email: 'bo@example.com', name: 'Bo Reader' },
        { email: 'cy@example.com', name: '' },
      ],
      cc: [{ email: 'di@example.com', name: 'Di' }],
      bcc: [{ email: 'eve@example.com', name: '' }],
      replyTo: [{ email: 'help@example.com', name: 'Help Desk' }],
      subject: 'Your order №7 is ready',
      headers: [{ name: 'X-Campaign', value: 'welcome' }],
      returnPath: null,
    })
    expect(email.attachments.map((file) => [file.filename, file.contentType, file.cid])).toEqual([
      ['report.pdf', 'application/pdf', null],
      ['logo.png', 'image/png', 'logo'],
    ])
    expect(email.messageId).toMatch(/^<[0-9a-f]{32}@example\.com>$/)
    expect(email.date.toISOString()).toBe('2026-11-12T10:20:30.000Z')
  })

  it('sends nobody the same email twice', () => {
    const email = prepare({
      from: 'a@example.com',
      to: ['bo@example.com', 'BO@example.com'],
      cc: ['bo@example.com', 'cy@example.com'],
      bcc: ['cy@example.com', 'di@example.com'],
      subject: 's',
      text: 't',
    })
    expect(email.to.map((a) => a.email)).toEqual(['bo@example.com'])
    expect(email.cc.map((a) => a.email)).toEqual(['cy@example.com'])
    expect(email.bcc.map((a) => a.email)).toEqual(['di@example.com'])
  })

  it('uses the default sender, and forces it when asked', () => {
    const message = { to: 'bo@example.com', subject: 's', text: 't' }
    const site = { from: 'Site <site@example.com>' }
    expect(prepare(message, site).from).toEqual({ email: 'site@example.com', name: 'Site' })
    const own = { ...message, from: 'Shop <shop@example.com>' }
    expect(prepare(own, site).from).toEqual({ email: 'shop@example.com', name: 'Shop' })
    expect(prepare(own, { ...site, forceFromEmail: true }).from).toEqual({
      email: 'site@example.com',
      name: 'Shop',
    })
    expect(prepare(own, { ...site, forceFromName: true }).from).toEqual({
      email: 'shop@example.com',
      name: 'Site',
    })
    // A sender without a name takes the site's.
    expect(prepare({ ...message, from: 'shop@example.com' }, site).from.name).toBe('Site')
    invalid(() => prepare(message), /no sender/)
  })

  it('refuses a message that isn’t an email', () => {
    const base = { from: 'a@example.com', to: 'bo@example.com', subject: 's', text: 't' }
    invalid(() => prepare({ ...base, to: [] }), /no recipient/)
    invalid(() => prepare({ ...base, text: undefined }), /no body/)
    invalid(() => prepare({ ...base, subject: 'Hi\r\nBcc: x@evil.test' }), /line break/)
    invalid(() => prepare({ ...base, subject: 'x'.repeat(999) }), /longer than/)
    invalid(
      () => prepare({ ...base, to: Array.from({ length: 101 }, (_, i) => `u${i}@example.com`) }),
      /more than 100 recipients/,
    )
    invalid(() => prepare({ ...base, returnPath: 'nope' }), /return path/)
    invalid(() => prepare({ ...base, replyTo: 'nope' }), /reply-to/)
  })

  it('refuses headers that could forge the message, and keeps the rest on one line', () => {
    const base = { from: 'a@example.com', to: 'bo@example.com', subject: 's', text: 't' }
    for (const name of ['Bcc', 'from', 'Subject', 'Content-Type', 'Received', 'DKIM-Signature']) {
      invalid(() => prepare({ ...base, headers: { [name]: 'x' } }), /set from the message itself/)
    }
    invalid(() => prepare({ ...base, headers: { 'X-A': 'one\r\nBcc: x@evil.test' } }), /line break/)
    invalid(() => prepare({ ...base, headers: { 'X A': 'v' } }), /isn't a header name/)
    invalid(() => prepare({ ...base, headers: { 'X-A:': 'v' } }), /isn't a header name/)
    expect(
      prepare({ ...base, headers: { 'List-Unsubscribe': ' <https://x.test/u> ' } }).headers,
    ).toEqual([{ name: 'List-Unsubscribe', value: '<https://x.test/u>' }])
  })

  it('checks attachments: a plain file name, a real type, a size', () => {
    const base = { from: 'a@example.com', to: 'bo@example.com', subject: 's', text: 't' }
    const [file] = prepare({
      ...base,
      attachments: [{ filename: '../../etc/pass\r\nwd.txt', content: 'hello' }],
    }).attachments
    expect(file).toMatchObject({ filename: 'passwd.txt', contentType: 'text/plain', cid: null })
    expect(new TextDecoder().decode(file!.content)).toBe('hello')
    invalid(
      () =>
        prepare({
          ...base,
          attachments: [{ filename: 'a.bin', content: 'x', contentType: 'nope' }],
        }),
      /content type/,
    )
    invalid(
      () => prepare({ ...base, attachments: [{ filename: 'a.png', content: 'x', cid: 'a b>' }] }),
      /content id/,
    )
    invalid(
      () =>
        prepare({
          ...base,
          attachments: [{ filename: 'big', content: new Uint8Array(25_000_001) }],
        }),
      /larger than 25 MB/,
    )
    invalid(() => prepare({ ...base, attachments: [{ filename: '', content: 'x' }] }), /file name/)
  })
})
