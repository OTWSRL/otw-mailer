import type { Condition, ConditionField, ConditionOperator, Email, Route } from './types.ts'

/** The parts of an email a rule can test, with their names for a form. */
export const CONDITION_FIELDS: readonly { value: ConditionField; label: string }[] = [
  { value: 'subject', label: 'Subject' },
  { value: 'body', label: 'Message' },
  { value: 'to', label: 'To email' },
  { value: 'cc', label: 'Cc email' },
  { value: 'bcc', label: 'Bcc email' },
  { value: 'from', label: 'From email' },
  { value: 'fromName', label: 'From name' },
  { value: 'replyTo', label: 'Reply-To email' },
  { value: 'header', label: 'Header' },
]

/** The comparisons a rule can make, with their names for a form. */
export const CONDITION_OPERATORS: readonly { value: ConditionOperator; label: string }[] = [
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'is', label: 'is' },
  { value: 'isNot', label: 'is not' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
]

const NEGATIVE: ReadonlySet<ConditionOperator> = new Set(['notContains', 'isNot'])

function values(email: Email, condition: Condition): string[] {
  switch (condition.field) {
    case 'subject':
      return [email.subject]
    case 'body':
      return [email.text, email.html].filter((part): part is string => part !== null)
    case 'to':
      return email.to.map((address) => address.email)
    case 'cc':
      return email.cc.map((address) => address.email)
    case 'bcc':
      return email.bcc.map((address) => address.email)
    case 'from':
      return [email.from.email]
    case 'fromName':
      return [email.from.name]
    case 'replyTo':
      return email.replyTo.map((address) => address.email)
    case 'header': {
      const name = condition.header?.toLowerCase() ?? ''
      return email.headers
        .filter((header) => header.name.toLowerCase() === name)
        .map((header) => header.value)
    }
    default:
      return []
  }
}

function compare(text: string, operator: ConditionOperator, wanted: string): boolean {
  switch (operator) {
    case 'contains':
    case 'notContains':
      return text.includes(wanted)
    case 'is':
    case 'isNot':
      return text === wanted
    case 'startsWith':
      return text.startsWith(wanted)
    case 'endsWith':
      return text.endsWith(wanted)
    default:
      return false
  }
}

/**
 * Whether an email passes one test, whatever the letter case. With several values (recipients,
 * both bodies), "contains", "is" and the like pass when any value does; "does not contain" and
 * "is not" pass when none does. A test with nothing to compare against never passes, so an
 * unfinished rule can't catch every email.
 */
export function matches(email: Email, condition: Condition): boolean {
  const wanted = condition.value.trim().toLowerCase()
  if (!wanted) return false
  const found = values(email, condition).some((value) =>
    compare(value.toLowerCase(), condition.operator, wanted),
  )
  return NEGATIVE.has(condition.operator) ? !found : found
}

/** The connection of the first rule whose every condition the email passes, or `null`. */
export function routeFor(email: Email, routes: readonly Route[]): string | null {
  for (const route of routes) {
    if (
      route.conditions.length > 0 &&
      route.conditions.every((condition) => matches(email, condition))
    ) {
      return route.connection
    }
  }
  return null
}
