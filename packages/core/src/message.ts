import { domainOf, isEmail, parseAddress, parseAddresses } from './address.ts'
import { randomHex, utf8 } from './encoding.ts'
import { invalid } from './errors.ts'
import type {
  Address,
  AddressInput,
  Attachment,
  Email,
  EmailAttachment,
  Header,
  Message,
} from './types.ts'

/** RFC 5322's limit for one header line. */
const MAX_LINE = 998
const MAX_RECIPIENTS = 100
const MAX_BODY_BYTES = 5_000_000
const MAX_ATTACHMENTS = 50
const MAX_ATTACHMENT_BYTES = 25_000_000
const MAX_HEADERS = 50
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const LINE_BREAK = /[\r\n]/
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,76}$/
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/
const CONTENT_ID = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.@-]{1,120}$/

/**
 * Headers the email is built from, or that say how it travelled. Setting one through `headers`
 * could contradict the message or forge its path, so they are refused.
 */
const RESERVED = new Set([
  'from',
  'sender',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'content-disposition',
  'content-id',
  'return-path',
  'received',
  'dkim-signature',
  'authentication-results',
])

/** Common file types by extension, for attachments that don't say theirs. */
const TYPES: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  ics: 'text/calendar',
  json: 'application/json',
  xml: 'application/xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
}

/** What every email gets unless it says otherwise, and what it gets whatever it says. */
export interface Defaults {
  /** The sender, for messages without one. */
  from?: AddressInput
  /** Sends every email from `from`'s address, whatever the message asks for. */
  forceFromEmail?: boolean
  /** Sends every email under `from`'s name, whatever the message asks for. */
  forceFromName?: boolean
  /** Where bounces go, for messages that don't say. */
  returnPath?: string
  /** The clock, for the `Date` header. */
  now?: () => Date
}

function body(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') invalid(`${what} must be text`)
  if (value.length > MAX_BODY_BYTES || utf8(value).length > MAX_BODY_BYTES) {
    invalid(`${what} is larger than ${MAX_BODY_BYTES / 1_000_000} MB`)
  }
  return value
}

function sender(message: Message, defaults: Defaults): Address {
  const own = message.from === undefined ? null : parseAddress(message.from, 'The sender')
  const site =
    defaults.from === undefined ? null : parseAddress(defaults.from, 'The default sender')
  const email = defaults.forceFromEmail && site ? site.email : (own?.email ?? site?.email)
  if (!email) invalid('it has no sender. Give the message a `from`, or the mailer a default one')
  const name = defaults.forceFromName && site ? site.name : own?.name || site?.name || ''
  return { email, name }
}

function header(name: unknown, value: unknown): Header {
  if (typeof name !== 'string' || !HEADER_NAME.test(name)) {
    invalid(`"${String(name).slice(0, 80)}" isn't a header name`)
  }
  if (RESERVED.has(name.toLowerCase())) {
    invalid(`the ${name} header is set from the message itself, not from \`headers\``)
  }
  if (typeof value !== 'string') invalid(`the ${name} header must be text`)
  const text = value.trim()
  if (LINE_BREAK.test(text) || CONTROL.test(text)) {
    invalid(`the ${name} header has a line break or a control character`)
  }
  if (name.length + text.length + 2 > MAX_LINE) invalid(`the ${name} header is too long`)
  return { name, value: text }
}

function fileName(value: unknown): string {
  if (typeof value !== 'string') invalid('an attachment needs a file name')
  // A name only: no folders, and nothing a header could misread.
  const name = value
    .replace(/^.*[\\/]/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (!name || name.length > 255) invalid('an attachment needs a file name of 1 to 255 characters')
  return name
}

function attachment(input: Attachment): EmailAttachment {
  if (!input || typeof input !== 'object') invalid('an attachment must be an object')
  const filename = fileName(input.filename)
  const content = typeof input.content === 'string' ? utf8(input.content) : input.content
  if (!(content instanceof Uint8Array)) invalid(`the attachment "${filename}" has no content`)
  const extension = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase() ?? ''
  const contentType = (input.contentType ?? TYPES[extension] ?? 'application/octet-stream')
    .trim()
    .toLowerCase()
  if (!CONTENT_TYPE.test(contentType)) {
    invalid(`the attachment "${filename}" has an invalid content type`)
  }
  const cid = input.cid ?? null
  if (cid !== null && !CONTENT_ID.test(cid)) {
    invalid(`the attachment "${filename}" has an invalid content id`)
  }
  return { filename, content, contentType, cid }
}

/** Drops addresses already seen, whatever their letter case, so nobody gets the email twice. */
function unseen(addresses: Address[], seen: Set<string>): Address[] {
  return addresses.filter((address) => {
    const key = address.email.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Checks a message and puts it in the one shape transports receive. Throws a `MailerError` with
 * code `invalid-message` for anything that isn't an email: an address that isn't one, a line
 * break in the subject or a header, a header the email is built from, no body.
 */
export function prepare(message: Message, defaults: Defaults = {}): Email {
  if (!message || typeof message !== 'object') invalid('pass a message')
  const from = sender(message, defaults)

  const seen = new Set<string>()
  const to = unseen(parseAddresses(message.to, 'A recipient'), seen)
  const cc = unseen(parseAddresses(message.cc, 'A Cc recipient'), seen)
  const bcc = unseen(parseAddresses(message.bcc, 'A Bcc recipient'), seen)
  if (to.length === 0) invalid('it has no recipient')
  if (seen.size > MAX_RECIPIENTS) invalid(`it has more than ${MAX_RECIPIENTS} recipients`)

  if (typeof message.subject !== 'string') invalid('the subject must be text')
  const subject = message.subject.trim()
  if (LINE_BREAK.test(subject) || CONTROL.test(subject)) {
    invalid('the subject has a line break or a control character')
  }
  if (subject.length > MAX_LINE) invalid(`the subject is longer than ${MAX_LINE} characters`)

  const text = body(message.text, 'The text')
  const html = body(message.html, 'The HTML')
  if (text === null && html === null) invalid('it has no body. Give it `text`, `html` or both')

  const headers = Object.entries(message.headers ?? {}).map(([name, value]) => header(name, value))
  if (headers.length > MAX_HEADERS) invalid(`it has more than ${MAX_HEADERS} extra headers`)

  const attachments = (message.attachments ?? []).map(attachment)
  if (attachments.length > MAX_ATTACHMENTS) {
    invalid(`it has more than ${MAX_ATTACHMENTS} attachments`)
  }
  const size = attachments.reduce((sum, file) => sum + file.content.length, 0)
  if (size > MAX_ATTACHMENT_BYTES) {
    invalid(`its attachments are larger than ${MAX_ATTACHMENT_BYTES / 1_000_000} MB together`)
  }

  const returnPath = message.returnPath ?? defaults.returnPath ?? null
  if (returnPath !== null && !isEmail(returnPath)) {
    invalid(`the return path isn't an email address`)
  }

  return {
    from,
    to,
    cc,
    bcc,
    replyTo: unseen(parseAddresses(message.replyTo, 'The reply-to'), new Set()),
    subject,
    text,
    html,
    headers,
    attachments,
    returnPath,
    messageId: `<${randomHex(16)}@${domainOf(from.email)}>`,
    date: (defaults.now ?? (() => new Date()))(),
  }
}

/** Everyone the email goes to: `to`, `cc` and `bcc`. */
export function recipients(email: Email): Address[] {
  return [...email.to, ...email.cc, ...email.bcc]
}

/** The attachments shown in the HTML body, and those beside it. */
export function splitAttachments(email: Email): {
  inline: EmailAttachment[]
  files: EmailAttachment[]
} {
  // Without HTML nothing can show an inline file, so it goes as an ordinary attachment.
  const inline = email.html === null ? [] : email.attachments.filter((file) => file.cid !== null)
  return { inline, files: email.attachments.filter((file) => !inline.includes(file)) }
}
