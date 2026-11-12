import type { Migration } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'

// Hand-written to match schema.ts; the tests run every query against this schema.
export const migrations: Migration[] = [
  {
    id: '0001_create_tables',
    up: async (db) => {
      await db.execute(sql`
        CREATE TABLE mailer_connections (
          id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{0,23}$'),
          name text NOT NULL,
          mailer text NOT NULL,
          config jsonb NOT NULL DEFAULT '{}',
          auth text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`
        CREATE TABLE mailer_options (
          key text PRIMARY KEY,
          value jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`
        CREATE TABLE mailer_emails (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          status text NOT NULL CHECK (status IN ('sent', 'failed')),
          sender text NOT NULL,
          recipients text NOT NULL,
          addresses jsonb,
          subject text NOT NULL,
          text_body text,
          html_body text,
          reply_to text,
          connection text,
          mailer text,
          message_id text,
          provider_id text,
          error text,
          attempts jsonb NOT NULL DEFAULT '[]',
          resent_from uuid,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`CREATE INDEX mailer_emails_created_idx ON mailer_emails (created_at)`)
      await db.execute(
        sql`CREATE INDEX mailer_emails_status_idx ON mailer_emails (status, created_at)`,
      )
      await db.execute(sql`
        CREATE TABLE mailer_events (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          level text NOT NULL CHECK (level IN ('error', 'info')),
          message text NOT NULL,
          context jsonb NOT NULL DEFAULT '{}',
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`CREATE INDEX mailer_events_created_idx ON mailer_events (created_at)`)
    },
  },
]
