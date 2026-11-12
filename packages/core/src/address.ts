import { invalid } from './errors.ts'
import type { Address, AddressInput, AddressList } from './types.ts'

// Deliberately narrower than RFC 5322: no quoted local parts, comments or bare domains. What
// people's addresses look like, and nothing a header or an API's JSON could misread.
const EMAIL = /^[^\s@<>",;:()[\]\\]+@[^\s@<>",;:()[\]\\]+\.[^\s@<>",;:()[\]\\]+$/
// Control characters, which include the line breaks that would start a header of their own.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const MAX_EMAIL = 254
const MAX_NAME = 200

/** Whether text is an email address, such as `ada@example.com`. */
export function isEmail(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_EMAIL &&
    !CONTROL.test(value) &&
    EMAIL.test(value)
  )
}

function unquote(name: string): string {
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(name)
  return quoted ? quoted[1]!.replace(/\\(.)/g, '$1') : name
}

/**
 * An address from text or parts, checked: `what` names it in the error. A name can't hold a line
 * break or a control character, which would let it add headers of its own (header injection).
 */
export function parseAddress(input: AddressInput, what = 'An address'): Address {
  let email: unknown
  let name: unknown = ''
  if (typeof input === 'string') {
    const text = input.trim()
    const named = /^(.*?)\s*<([^<>]*)>$/.exec(text)
    email = named ? named[2]!.trim() : text
    if (named) name = unquote(named[1]!.trim())
  } else if (input && typeof input === 'object') {
    email = typeof input.email === 'string' ? input.email.trim() : input.email
    name = input.name === undefined ? '' : input.name
  }
  if (!isEmail(email)) {
    const shown = typeof email === 'string' ? email.slice(0, 80) : String(email)
    invalid(`${what} isn't an email address: "${shown.replace(CONTROL, ' ')}"`)
  }
  if (typeof name !== 'string') invalid(`${what}'s name must be text`)
  const trimmed = name.trim()
  if (trimmed.length > MAX_NAME) invalid(`${what}'s name is longer than ${MAX_NAME} characters`)
  if (CONTROL.test(trimmed)) invalid(`${what}'s name has a line break or a control character`)
  return { email, name: trimmed }
}

/** A list of addresses from one or several, each checked. */
export function parseAddresses(input: AddressList | undefined, what: string): Address[] {
  if (input === undefined || input === null) return []
  const list = typeof input === 'string' || !Array.isArray(input) ? [input] : input
  return (list as readonly AddressInput[]).map((item) => parseAddress(item, what))
}

/**
 * An address as one text, `"Ada Admin" <ada@example.com>`, for services that take it that way.
 * The name is quoted, so a comma or a bracket in it can't be read as another address.
 */
export function formatAddress(address: Address): string {
  if (!address.name) return address.email
  return `"${address.name.replace(/[\\"]/g, '\\$&')}" <${address.email}>`
}

/** The part after the @. */
export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase()
}
