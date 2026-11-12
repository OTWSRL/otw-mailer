import type { MailerId } from './registry.ts'

/** A mailbox: the address, and the name shown beside it (empty for none). */
export interface Address {
  email: string
  name: string
}

/** An address as text, `ada@example.com` or `Ada Admin <ada@example.com>`, or in parts. */
export type AddressInput = string | { email: string; name?: string }

/** One address or several. */
export type AddressList = AddressInput | readonly AddressInput[]

/** A file sent with an email. */
export interface Attachment {
  filename: string
  /** The file's bytes, or text, which is sent as UTF-8. */
  content: Uint8Array | string
  /** Such as `application/pdf`. Guessed from the file name when left out. */
  contentType?: string
  /** Shows the file inside the HTML body, as `<img src="cid:logo">` does for `logo`. */
  cid?: string
}

/** An email to send. It needs a recipient, and `text`, `html` or both. */
export interface Message {
  /** Defaults to the mailer's `from`. */
  from?: AddressInput
  to: AddressList
  cc?: AddressList
  bcc?: AddressList
  replyTo?: AddressList
  subject: string
  text?: string
  html?: string
  /** Extra headers, such as `List-Unsubscribe`. Those the email is built from can't be set here. */
  headers?: Readonly<Record<string, string>>
  attachments?: readonly Attachment[]
  /** Where bounces go, for mailers that let the sender choose (SMTP). */
  returnPath?: string
}

/** An extra header, as the email carries it. */
export interface Header {
  name: string
  value: string
}

/** An attachment as a transport receives it: bytes, with its type known. */
export interface EmailAttachment {
  filename: string
  content: Uint8Array
  contentType: string
  cid: string | null
}

/** A message checked and in one shape, as every transport receives it. */
export interface Email {
  from: Address
  /** No address appears twice across `to`, `cc` and `bcc`. */
  to: Address[]
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  subject: string
  text: string | null
  html: string | null
  headers: Header[]
  attachments: EmailAttachment[]
  returnPath: string | null
  /** Its `Message-ID`, angle brackets included. */
  messageId: string
  date: Date
}

/** What a service answered when it took an email. */
export interface Receipt {
  /** The service's own id for the message, when it gives one. */
  id: string | null
  /** The service's answer in words, such as an SMTP server's `250 OK`. */
  detail?: string
}

/** How one kind of mailer sends: built from its settings, once per connection. */
export interface Transport {
  /** Sends the email, or throws a `MailerError` saying why not. */
  send(email: Email, signal: AbortSignal): Promise<Receipt>
  /** Checks the settings without sending, where the service allows. */
  verify?(signal: AbortSignal): Promise<void>
}

/** OAuth tokens for mailers that send as a signed-in account: Gmail, Microsoft 365, Zoho. */
export interface OAuthTokens {
  refreshToken: string
  accessToken?: string
  /** When the access token stops working, in milliseconds since the epoch. */
  expiresAt?: number
}

/** Where a connection's OAuth tokens are kept between sends. Services may replace them. */
export interface TokenStore {
  read(): Promise<OAuthTokens | null>
  write(tokens: OAuthTokens): Promise<void>
}

/** What a transport is built with besides its settings. */
export interface TransportContext {
  /** The connection's id, for messages. */
  connection: string
  fetch: typeof fetch
  tokens?: TokenStore
}

/** A mailer module's export: its transport, built from checked settings. */
export type CreateTransport<C> = (config: C, context: TransportContext) => Transport

/** One way email leaves: a mailer and its settings. */
export interface Connection {
  /** Unique among the mailer's connections. */
  id: string
  mailer: MailerId
  /** The mailer's settings, by field name: see `MAILERS` for each mailer's fields. */
  config: Readonly<Record<string, unknown>>
  tokens?: TokenStore
}

/** The parts of an email a routing rule can look at. */
export type ConditionField =
  'subject' | 'body' | 'to' | 'cc' | 'bcc' | 'from' | 'fromName' | 'replyTo' | 'header'

/** How a routing rule compares. Letter case never matters. */
export type ConditionOperator =
  'contains' | 'notContains' | 'is' | 'isNot' | 'startsWith' | 'endsWith'

/** One test of a routing rule. */
export interface Condition {
  field: ConditionField
  /** The header's name, when `field` is `header`. */
  header?: string
  operator: ConditionOperator
  value: string
}

/** Sends the emails that pass every condition through another connection. */
export interface Route {
  connection: string
  conditions: readonly Condition[]
}

/** One try at sending an email through one connection. */
export interface Attempt {
  connection: string
  mailer: MailerId
  ok: boolean
  /** The service's id for the message, when it took it and gave one. */
  providerId: string | null
  detail: string | null
  /** Why it failed. */
  error: { code: string; message: string; status: number | null } | null
  durationMs: number
}

/** An email that was sent: through which connection, after which tries. */
export interface Delivery {
  email: Email
  connection: string
  mailer: MailerId
  providerId: string | null
  /** Every try, the failed ones before the one that worked. */
  attempts: Attempt[]
}
