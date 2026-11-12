import { simpleParser } from 'mailparser'
import { describe, expect, it } from 'vitest'
import { prepare, toMime } from '../src/index.ts'
import { quotedPrintable } from '../src/mime.ts'
import { FULL } from './helpers.ts'

const NOW = { now: () => new Date('2026-11-12T10:20:30Z') }
// eslint-disable-next-line no-control-regex
const ASCII = /^[\x00-\x7f]*$/
// Every line the message has, to check their lengths.
const lines = (mime: string) => mime.split('\r\n')

describe('toMime', () => {
  it('writes a message a mail parser reads back as it was sent', async () => {
    const email = prepare(FULL, NOW)
    const mime = toMime(email)
    // ASCII only, CRLF line ends, and no line past RFC 5322's limit.
    expect(ASCII.test(mime)).toBe(true)
    expect(mime.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    expect(Math.max(...lines(mime).map((line) => line.length))).toBeLessThanOrEqual(78)

    const parsed = await simpleParser(mime)
    expect(parsed.from?.value).toEqual([{ address: 'ada@example.com', name: 'Ada Admin' }])
    expect(parsed.to).toMatchObject({
      value: [
        { address: 'bo@example.com', name: 'Bo Reader' },
        { address: 'cy@example.com', name: '' },
      ],
    })
    expect(parsed.cc).toMatchObject({ value: [{ address: 'di@example.com', name: 'Di' }] })
    expect(parsed.bcc).toBeUndefined()
    expect(parsed.replyTo?.value).toEqual([{ address: 'help@example.com', name: 'Help Desk' }])
    expect(parsed.subject).toBe('Your order №7 is ready')
    expect(parsed.messageId).toBe(email.messageId)
    expect(parsed.date?.toISOString()).toBe('2026-11-12T10:20:30.000Z')
    expect(parsed.headers.get('x-campaign')).toBe('welcome')
    expect(parsed.text?.trim()).toBe('Thanks for your order.')
    expect(parsed.html).toContain('<b>order</b>')
    expect(
      parsed.attachments.map((file) => [
        file.filename,
        file.contentType,
        file.contentDisposition,
        file.cid ?? null,
        [...file.content],
      ]),
    ).toEqual([
      ['logo.png', 'image/png', 'inline', 'logo', [1, 2, 3]],
      ['report.pdf', 'application/pdf', 'attachment', null, [37, 80, 68, 70]],
    ])
  })

  it('nests the parts: mixed > alternative > related', () => {
    const mime = toMime(prepare(FULL, NOW))
    const types = [...mime.matchAll(/^Content-Type: ([a-z]+\/[a-z]+)/gm)].map((match) => match[1])
    expect(types).toEqual([
      'multipart/mixed',
      'multipart/alternative',
      'text/plain',
      'multipart/related',
      'text/html',
      'image/png',
      'application/pdf',
    ])
  })

  it('sends a plain email as one part, and writes Bcc only when asked', () => {
    const email = prepare(
      {
        from: 'a@example.com',
        to: 'bo@example.com',
        bcc: 'eve@example.com',
        subject: 'Hi',
        text: 'Hello',
      },
      NOW,
    )
    const mime = toMime(email)
    expect(mime).toContain(
      'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit',
    )
    expect(mime).not.toContain('multipart')
    expect(mime).not.toMatch(/^Bcc:/m)
    expect(mime.endsWith('\r\n\r\nHello\r\n')).toBe(true)
    expect(toMime(email, { bcc: true })).toMatch(/^Bcc: eve@example\.com$/m)
  })

  it('carries any language in names, the subject, bodies and file names', async () => {
    const subject =
      'Ärger mit Größe: 日本語のお知らせ and a very long line that keeps going past any limit'
    const text = `Zażółć gęślą jaźń — ${'słowo '.repeat(40)}\n.leading dot\nFrom the start\ntrailing space \n`
    const mime = toMime(
      prepare(
        {
          from: { email: 'ada@example.com', name: 'Ünal, "Çağrı" Ödön' },
          to: { email: 'bo@example.com', name: '山田太郎' },
          subject,
          text,
          html: `<p>${text}</p>`,
          attachments: [{ filename: 'Füße über alles — отчёт.txt', content: 'x' }],
        },
        NOW,
      ),
    )
    expect(ASCII.test(mime)).toBe(true)
    expect(Math.max(...lines(mime).map((line) => line.length))).toBeLessThanOrEqual(78)
    const parsed = await simpleParser(mime)
    expect(parsed.subject).toBe(subject)
    expect(parsed.from?.value[0]).toEqual({
      address: 'ada@example.com',
      name: 'Ünal, "Çağrı" Ödön',
    })
    expect(parsed.to).toMatchObject({ value: [{ address: 'bo@example.com', name: '山田太郎' }] })
    expect(parsed.text).toBe(text)
    expect(parsed.attachments[0]?.filename).toBe('Füße über alles — отчёт.txt')
  })

  it('folds a long list of recipients and a long header', async () => {
    const to = Array.from({ length: 30 }, (_, i) => `Reader Number ${i} <reader${i}@example.com>`)
    const mime = toMime(
      prepare(
        {
          from: 'a@example.com',
          to,
          subject: 's',
          text: 't',
          headers: { 'X-Long': 'word '.repeat(60).trim() },
        },
        NOW,
      ),
    )
    expect(Math.max(...lines(mime).map((line) => line.length))).toBeLessThanOrEqual(78)
    const parsed = await simpleParser(mime)
    expect(Array.isArray(parsed.to) ? 0 : parsed.to?.value.length).toBe(30)
    expect(parsed.headers.get('x-long')).toBe('word '.repeat(60).trim())
  })
})

describe('quotedPrintable', () => {
  it('keeps ASCII readable and encodes the rest', () => {
    expect(quotedPrintable('a=b')).toBe('a=3Db')
    expect(quotedPrintable('é')).toBe('=C3=A9')
    expect(quotedPrintable('end \nnext\t')).toBe('end=20\r\nnext=09')
    expect(quotedPrintable('From here\nFrom there')).toBe('=46rom here\r\n=46rom there')
    expect(quotedPrintable('not From here')).toBe('not From here')
  })

  it('breaks long lines softly at 76 characters', () => {
    const encoded = quotedPrintable('x'.repeat(200))
    const parts = encoded.split('=\r\n')
    expect(parts.map((part) => part.length)).toEqual([75, 75, 50])
    expect(parts.join('')).toBe('x'.repeat(200))
  })
})
