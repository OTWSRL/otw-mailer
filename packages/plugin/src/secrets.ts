import { mailerInfo, type MailerField, type MailerInfo } from '@otwdesign/mailer/mailers'

/** The site's environment variables. */
export type Env = Readonly<Record<string, string | undefined>>

/** What a connection is called: lowercase, as the variables for its secrets are named after it. */
export const CONNECTION_ID = /^[a-z][a-z0-9_]{0,23}$/

/**
 * The environment variable that holds a connection's secret: `MAILER_MAIN_API_KEY` for the `main`
 * connection's `apiKey`. Secrets are read from the environment only, never stored or shown, as
 * every secret setting of the CMS is.
 */
export function envName(connection: string, field: string): string {
  const suffix = field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()
  return `MAILER_${connection.toUpperCase()}_${suffix}`
}

/** A mailer's settings that are keys or passwords. */
export function secretFields(mailer: MailerInfo): MailerField[] {
  return mailer.fields.filter((field) => field.type === 'secret')
}

/** A mailer's settings the admin stores: everything but its secrets. */
export function storedFields(mailer: MailerInfo): MailerField[] {
  return mailer.fields.filter((field) => field.type !== 'secret')
}

/** A connection's settings as its mailer takes them: the stored ones, and its secrets from the environment. */
export function resolveConfig(
  connection: { id: string; mailer: string; config: Readonly<Record<string, unknown>> },
  env: Env,
): Record<string, unknown> {
  const info = mailerInfo(connection.mailer)
  const config: Record<string, unknown> = { ...connection.config }
  for (const field of info ? secretFields(info) : []) {
    const value = env[envName(connection.id, field.name)]?.trim()
    if (value) config[field.name] = value
    else delete config[field.name]
  }
  return config
}

/** One of a connection's secrets: the variable that holds it, and whether it's set. */
export interface SecretStatus {
  field: MailerField
  env: string
  set: boolean
}

/** Each secret a connection's mailer takes, with its variable's name and whether it's set. */
export function secretStatus(connection: { id: string; mailer: string }, env: Env): SecretStatus[] {
  const info = mailerInfo(connection.mailer)
  return (info ? secretFields(info) : []).map((field) => {
    const name = envName(connection.id, field.name)
    return { field, env: name, set: Boolean(env[name]?.trim()) }
  })
}

/** The variables a connection still needs before it can send. */
export function missingSecrets(connection: { id: string; mailer: string }, env: Env): string[] {
  return secretStatus(connection, env)
    .filter((secret) => secret.field.required && !secret.set)
    .map((secret) => secret.env)
}
