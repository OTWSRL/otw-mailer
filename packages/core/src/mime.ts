import { base64, isAscii, randomHex, utf8 } from './encoding.ts'
import { splitAttachments } from './message.ts'
import type { Address, Email, EmailAttachment } from './types.ts'

const CRLF = '\r\n'
/** RFC 5322 asks for lines of at most 78 characters, where they can be had. */
const SOFT_LINE = 78
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

interface Part {
  headers: string[]
  body: string
}

const two = (n: number) => String(n).padStart(2, '0')

/** A date as headers carry it, in UTC: `Thu, 12 Nov 2026 10:20:30 +0000`. */
export function formatDate(date: Date): string {
  return (
    `${DAYS[date.getUTCDay()]}, ${two(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:` +
    `${two(date.getUTCSeconds())} +0000`
  )
}

/**
 * Text that isn't ASCII, as RFC 2047 encoded words a header can carry. Each word holds whole
 * characters and is short enough to share a line with a header's name.
 */
function encodedWords(text: string): string[] {
  const words: string[] = []
  let chunk = ''
  let size = 0
  for (const character of text) {
    const bytes = utf8(character).length
    if (size + bytes > 42) {
      words.push(chunk)
      chunk = ''
      size = 0
    }
    chunk += character
    size += bytes
  }
  if (chunk) words.push(chunk)
  return words.map((word) => `=?UTF-8?B?${base64(utf8(word))}?=`)
}

/** Breaks a long header line at its spaces, so each line stays within 78 characters. */
function fold(line: string): string {
  const lines: string[] = []
  let rest = line
  // Never break before the value starts: "Subject:" alone on a line confuses some readers.
  let floor = line.indexOf(':') + 2
  while (rest.length > SOFT_LINE) {
    let at = rest.lastIndexOf(' ', SOFT_LINE)
    if (at <= floor) at = rest.indexOf(' ', SOFT_LINE)
    if (at <= floor) break
    lines.push(rest.slice(0, at))
    rest = rest.slice(at)
    floor = 1
  }
  lines.push(rest)
  return lines.join(CRLF)
}

/** Pieces of a header that mustn't be split, laid out on lines of at most 78 characters. */
function layout(name: string, tokens: readonly string[]): string {
  let out = `${name}:`
  let width = out.length
  for (const token of tokens) {
    if (width + 1 + token.length > SOFT_LINE && width > name.length + 1) {
      out += `${CRLF} ${token}`
      width = 1 + token.length
    } else {
      out += ` ${token}`
      width += 1 + token.length
    }
  }
  return out
}

/** A header whose value is free text, such as Subject. */
function textHeader(name: string, value: string): string {
  return isAscii(value) ? fold(`${name}: ${value}`) : layout(name, encodedWords(value))
}

/** A display name: as it is, quoted when it has characters addresses use, or encoded. */
function phrase(name: string): string[] {
  if (!isAscii(name)) return encodedWords(name)
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name)) return [name]
  return [`"${name.replace(/[\\"]/g, '\\$&')}"`]
}

/** A header listing addresses. A line breaks between addresses, or between a name and its address. */
function addressHeader(name: string, addresses: readonly Address[]): string {
  const tokens = addresses.flatMap((address, index) => {
    const comma = index < addresses.length - 1 ? ',' : ''
    if (!address.name) return [`${address.email}${comma}`]
    const words = phrase(address.name)
    // A plain name stays with its address when the two fit on a line.
    if (words.length === 1 && words[0]!.length + address.email.length + 4 <= SOFT_LINE - 2) {
      return [`${words[0]} <${address.email}>${comma}`]
    }
    return [...words, `<${address.email}>${comma}`]
  })
  return layout(name, tokens)
}

/**
 * Text as quoted-printable: ASCII stays readable, everything else becomes `=XX`, and no line is
 * longer than 76 characters. Line breaks become CRLF.
 */
export function quotedPrintable(text: string): string {
  const bytes = utf8(text.replace(/\r\n|\r|\n/g, CRLF))
  let out = ''
  let line = ''
  const isBreak = (at: number) => bytes[at] === 13 && bytes[at + 1] === 10
  const startsFrom = (at: number) =>
    bytes[at + 1] === 114 && bytes[at + 2] === 111 && bytes[at + 3] === 109 && bytes[at + 4] === 32
  for (let at = 0; at < bytes.length; at++) {
    const byte = bytes[at]!
    if (isBreak(at)) {
      out += line + CRLF
      line = ''
      at++
      continue
    }
    const endsLine = at === bytes.length - 1 || isBreak(at + 1)
    let token: string
    if (byte === 61 || (byte < 32 && byte !== 9) || byte > 126) {
      token = `=${byte.toString(16).toUpperCase().padStart(2, '0')}`
    } else if ((byte === 32 || byte === 9) && endsLine) {
      // Mail servers strip trailing spaces, so one at a line's end is written out.
      token = byte === 32 ? '=20' : '=09'
    } else if (byte === 70 && line === '' && startsFrom(at)) {
      // "From " at a line's start is rewritten by mailbox files, so its F is written out.
      token = '=46'
    } else {
      token = String.fromCharCode(byte)
    }
    if (line.length + token.length > 75) {
      out += `${line}=${CRLF}`
      line = ''
    }
    line += token
  }
  return out + line
}

/** Base64 in lines of 76 characters, as MIME bodies carry it. */
function wrap(encoded: string): string {
  return encoded.replace(/.{76}(?=.)/g, `$&${CRLF}`)
}

function textPart(subtype: 'plain' | 'html', content: string): Part {
  const normal = content.replace(/\r\n|\r|\n/g, CRLF)
  const plain =
    isAscii(normal.replace(/\r\n/g, '')) && normal.split(CRLF).every((l) => l.length <= 76)
  return {
    headers: [
      `Content-Type: text/${subtype}; charset=utf-8`,
      `Content-Transfer-Encoding: ${plain ? '7bit' : 'quoted-printable'}`,
    ],
    body: plain ? normal : quotedPrintable(normal),
  }
}

/**
 * A file name as a header parameter. ASCII goes in quotes. Any other name is written twice: in
 * ASCII for old readers, and in full as RFC 2231 has it, in pieces when it's long. Each piece is
 * a line of its own.
 */
function nameParameter(parameter: string, filename: string): string[] {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_')
  if (isAscii(filename)) return [`${parameter}="${ascii}"`]
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  // Whole %XX triplets only, 16 to a piece, so a piece is at most 48 characters.
  const pieces = encoded.match(/(?:%[0-9A-F]{2}|[^%]){1,16}/g) ?? [encoded]
  if (pieces.length === 1) return [`${parameter}="${ascii}"`, `${parameter}*=UTF-8''${encoded}`]
  return [
    `${parameter}="${ascii}"`,
    ...pieces.map(
      (piece, index) => `${parameter}*${index}*=${index === 0 ? "UTF-8''" : ''}${piece}`,
    ),
  ]
}

/** A header with parameters, one per line. */
function parameters(header: string, list: readonly string[]): string {
  return [header, ...list].join(`;${CRLF} `)
}

function filePart(file: EmailAttachment, inline: boolean): Part {
  const headers = [
    parameters(`Content-Type: ${file.contentType}`, nameParameter('name', file.filename)),
    'Content-Transfer-Encoding: base64',
    parameters(
      `Content-Disposition: ${inline ? 'inline' : 'attachment'}`,
      nameParameter('filename', file.filename),
    ),
  ]
  if (file.cid !== null) headers.push(`Content-ID: <${file.cid}>`)
  return { headers, body: wrap(base64(file.content)) }
}

function multipart(subtype: string, parts: readonly Part[]): Part {
  const boundary = `=_otw_${randomHex(12)}`
  const body = parts
    .map(
      (part) => `--${boundary}${CRLF}${part.headers.join(CRLF)}${CRLF}${CRLF}${part.body}${CRLF}`,
    )
    .join('')
  return {
    headers: [`Content-Type: multipart/${subtype};${CRLF} boundary="${boundary}"`],
    body: `${body}--${boundary}--`,
  }
}

function content(email: Email): Part {
  const { inline, files } = splitAttachments(email)
  const text = email.text === null ? null : textPart('plain', email.text)
  let html = email.html === null ? null : textPart('html', email.html)
  if (html && inline.length > 0) {
    html = multipart('related', [html, ...inline.map((file) => filePart(file, true))])
  }
  const shown = text && html ? multipart('alternative', [text, html]) : (html ?? text!)
  if (files.length === 0) return shown
  return multipart('mixed', [shown, ...files.map((file) => filePart(file, false))])
}

/**
 * The email as an RFC 5322 message: what an SMTP server, Amazon SES, Gmail and Microsoft Graph
 * take. Every byte is ASCII, so it can be sent as text. `Bcc` is written only when asked for:
 * services that read recipients from the headers need it, and remove it themselves.
 */
export function toMime(email: Email, options: { bcc?: boolean } = {}): string {
  const root = content(email)
  const headers = [
    `Date: ${formatDate(email.date)}`,
    addressHeader('From', [email.from]),
    addressHeader('To', email.to),
    ...(email.cc.length > 0 ? [addressHeader('Cc', email.cc)] : []),
    ...(options.bcc && email.bcc.length > 0 ? [addressHeader('Bcc', email.bcc)] : []),
    ...(email.replyTo.length > 0 ? [addressHeader('Reply-To', email.replyTo)] : []),
    textHeader('Subject', email.subject),
    `Message-ID: ${email.messageId}`,
    'MIME-Version: 1.0',
    ...email.headers.map((header) => textHeader(header.name, header.value)),
    ...root.headers,
  ]
  return `${headers.join(CRLF)}${CRLF}${CRLF}${root.body}${CRLF}`
}
