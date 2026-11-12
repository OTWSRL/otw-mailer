import { formatAddress } from '../address.ts'
import { base64 } from '../encoding.ts'
import { MailerError } from '../errors.ts'
import type { Address, Email, EmailAttachment } from '../types.ts'

/** An address as `{ email, name }`, the name left out when there's none. */
export function person(address: Address): { email: string; name?: string } {
  return address.name ? { email: address.email, name: address.name } : { email: address.email }
}

/** Addresses as texts, `"Ada" <ada@example.com>`. */
export function texts(addresses: readonly Address[]): string[] {
  return addresses.map(formatAddress)
}

/** The email's extra headers as an object. */
export function headerMap(email: Email): Record<string, string> {
  return Object.fromEntries(email.headers.map((header) => [header.name, header.value]))
}

/** A file's bytes as base64. */
export function encoded(file: EmailAttachment): string {
  return base64(file.content)
}

/** A list, or `undefined` when it's empty, so the property is left out of the request. */
export function some<T>(list: readonly T[]): readonly T[] | undefined {
  return list.length > 0 ? list : undefined
}

/** Text a hostname or a URL path may hold, or `not-configured`: settings never shape a URL. */
export function hostPart(value: string, what: string, mailer: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(value)) {
    throw new MailerError('not-configured', `${what} isn't valid.`, { mailer })
  }
  return value
}
