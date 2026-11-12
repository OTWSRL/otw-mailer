import type { Attempt, Condition } from '@otwdesign/mailer'
import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// The plugin owns these tables. Keys and passwords are never in them: those come from the
// site's environment.

/** One way email leaves the site: a mailer and its settings, without its secrets. */
export const connections = pgTable('mailer_connections', {
  /** A short name, which the environment variables for its secrets are named after. */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  mailer: text('mailer').notNull(),
  config: jsonb('config').$type<Record<string, string | number | boolean>>().notNull(),
  /** OAuth tokens of the connected account, encrypted with a key made from the client secret. */
  auth: text('auth'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** What the plugin keeps besides: which connection is primary and backup, and the routing rules. */
export const options = pgTable('mailer_options', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** The email log: one row per email the site tried to send. */
export const emails = pgTable(
  'mailer_emails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: text('status').$type<'sent' | 'failed'>().notNull(),
    sender: text('sender').notNull(),
    /** Every recipient, separated by commas, for searching. */
    recipients: text('recipients').notNull(),
    /** Who was To, Cc and Bcc, so a resend copies the same people the same way. */
    addresses: jsonb('addresses').$type<Addresses>(),
    subject: text('subject').notNull(),
    /** Kept only while "Log email content" is on: bodies hold reset links and personal details. */
    textBody: text('text_body'),
    htmlBody: text('html_body'),
    replyTo: text('reply_to'),
    connection: text('connection'),
    mailer: text('mailer'),
    messageId: text('message_id'),
    providerId: text('provider_id'),
    error: text('error'),
    attempts: jsonb('attempts').$type<Attempt[]>().notNull(),
    /** The email this one is a resend of. */
    resentFrom: uuid('resent_from'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('mailer_emails_created_idx').on(table.createdAt),
    index('mailer_emails_status_idx').on(table.status, table.createdAt),
  ],
)

/** Debug events: what went wrong, and where, for whoever looks into it. */
export const events = pgTable(
  'mailer_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    level: text('level').$type<'error' | 'info'>().notNull(),
    message: text('message').notNull(),
    context: jsonb('context').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('mailer_events_created_idx').on(table.createdAt)],
)

/** An email's recipients by kind. */
export interface Addresses {
  to: string[]
  cc: string[]
  bcc: string[]
}

/** A routing rule as stored: the connection, and the conditions an email must all pass. */
export interface StoredRoute {
  id: string
  connection: string
  conditions: Condition[]
}
