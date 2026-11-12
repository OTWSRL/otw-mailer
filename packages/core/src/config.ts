import { MailerError } from './errors.ts'
import type { MailerInfo } from './registry.ts'

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const TRUE = new Set(['1', 'true', 'yes', 'on'])
const FALSE = new Set(['0', 'false', 'no', 'off', ''])

function missing(mailer: MailerInfo, what: string): never {
  throw new MailerError('not-configured', `${mailer.label} isn't set up: ${what}.`, {
    mailer: mailer.label,
  })
}

/**
 * A mailer's settings, checked against its fields: text trimmed, numbers and switches read from
 * text too (as environment variables give them), defaults filled in. A missing required setting,
 * or one that isn't what its field takes, throws `not-configured`. Settings no field names are
 * dropped.
 */
export function checkConfig(
  mailer: MailerInfo,
  config: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean> {
  const checked: Record<string, string | number | boolean> = {}
  for (const item of mailer.fields) {
    let value = config[item.name]
    if (typeof value === 'string') value = value.trim()
    if (value === undefined || value === null || value === '') {
      if (item.default !== undefined) checked[item.name] = item.default
      else if (item.required) missing(mailer, `it needs its ${item.label.toLowerCase()}`)
      continue
    }
    switch (item.type) {
      case 'boolean': {
        const text = typeof value === 'boolean' ? String(value) : String(value).toLowerCase()
        if (!TRUE.has(text) && !FALSE.has(text)) missing(mailer, `${item.label} must be on or off`)
        checked[item.name] = TRUE.has(text)
        break
      }
      case 'number': {
        const number = typeof value === 'number' ? value : Number(value)
        if (!Number.isSafeInteger(number) || number < 0) {
          missing(mailer, `${item.label} must be a whole number`)
        }
        checked[item.name] = number
        break
      }
      case 'select':
        if (!item.options?.some((option) => option.value === value)) {
          missing(mailer, `${item.label} isn't one of its choices`)
        }
        checked[item.name] = value as string
        break
      default:
        // A line break here would end up in a request's headers or address.
        if (typeof value !== 'string' || CONTROL.test(value)) {
          missing(mailer, `${item.label} must be one line of text`)
        }
        checked[item.name] = value
    }
  }
  return checked
}
