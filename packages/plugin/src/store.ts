import type { Attempt, Condition, MailerId } from '@otwdesign/mailer'
import type { Database } from '@otwdesign/sdk'
import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql } from 'drizzle-orm'
import { connections, emails, events, options, type Addresses, type StoredRoute } from './schema.ts'

/** A connection as stored: a mailer and its settings, without its secrets. */
export interface StoredConnection {
  id: string
  name: string
  mailer: MailerId
  config: Record<string, string | number | boolean>
  /** Encrypted OAuth tokens, for a connected account. */
  auth: string | null
  updatedAt: Date
}

/** Everything that decides how an email leaves: the connections, who's first, and the rules. */
export interface Sending {
  connections: StoredConnection[]
  /** The connection email goes through: the one chosen, or the oldest. `null` with none. */
  primary: string | null
  backup: string | null
  routes: StoredRoute[]
}

/** An email in the log. */
export type LoggedEmail = typeof emails.$inferSelect

/** A new row of the log. */
export interface EmailRecord {
  status: 'sent' | 'failed'
  sender: string
  recipients: string
  /** `null` for a message refused before it was an email. */
  addresses: Addresses | null
  subject: string
  textBody: string | null
  htmlBody: string | null
  replyTo: string | null
  connection: string | null
  mailer: string | null
  messageId: string | null
  providerId: string | null
  error: string | null
  attempts: Attempt[]
  resentFrom: string | null
}

/** A debug event. */
export type LoggedEvent = typeof events.$inferSelect

const PRIMARY = 'primary'
const BACKUP = 'backup'
const ROUTES = 'routes'
const SECRET = 'secret'
const MAX_ROUTES = 50
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether text is a log entry's id, so a made-up one is "not found" and never a database error. */
export function isEmailId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/** Postgres text can't hold a NUL character; an email's body can. */
const clean = (text: string) => text.replaceAll('\u0000', '')
const cleanOrNull = (text: string | null) => (text === null ? null : clean(text))

// ── Connections ──────────────────────────────────────────────────────────────

const connectionColumns = {
  id: connections.id,
  name: connections.name,
  mailer: connections.mailer,
  config: connections.config,
  auth: connections.auth,
  updatedAt: connections.updatedAt,
}

/** Every connection, oldest first. */
export async function listConnections(db: Database): Promise<StoredConnection[]> {
  const rows = await db
    .select(connectionColumns)
    .from(connections)
    .orderBy(asc(connections.createdAt), asc(connections.id))
  return rows as StoredConnection[]
}

export async function getConnection(db: Database, id: string): Promise<StoredConnection | null> {
  const [row] = await db.select(connectionColumns).from(connections).where(eq(connections.id, id))
  return (row as StoredConnection | undefined) ?? null
}

/** Adds a connection. Returns `false` when its id is taken. */
export async function createConnection(
  db: Database,
  input: Pick<StoredConnection, 'id' | 'name' | 'mailer' | 'config'>,
): Promise<boolean> {
  const added = await db
    .insert(connections)
    .values(input)
    .onConflictDoNothing()
    .returning({ id: connections.id })
  return added.length > 0
}

/**
 * Changes a connection's name and settings. A connected account's tokens are dropped when the
 * settings that made their key or their account change, by the caller passing `auth: null`.
 */
export async function updateConnection(
  db: Database,
  id: string,
  changes: Pick<StoredConnection, 'name' | 'config'> & { auth?: null },
): Promise<void> {
  await db
    .update(connections)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(eq(connections.id, id))
}

/** Stores a connected account's encrypted tokens, or `null` to disconnect it. */
export async function setAuth(db: Database, id: string, auth: string | null): Promise<void> {
  await db
    .update(connections)
    .set({ auth, updatedAt: sql`now()` })
    .where(eq(connections.id, id))
}

/** Removes a connection, its roles, and the rules that sent through it. */
export async function deleteConnection(db: Database, id: string): Promise<void> {
  await db.delete(connections).where(eq(connections.id, id))
  const roles = await db
    .select()
    .from(options)
    .where(inArray(options.key, [PRIMARY, BACKUP, ROUTES]))
  for (const row of roles) {
    if (row.key === ROUTES) {
      const kept = (row.value as StoredRoute[]).filter((route) => route.connection !== id)
      await setOption(db, ROUTES, kept)
    } else if (roleId(row.value) === id) {
      await db.delete(options).where(eq(options.key, row.key))
    }
  }
}

// ── Options ──────────────────────────────────────────────────────────────────

/*
 * Every option's value is an object or a list, never bare text. The database driver reads a
 * stored JSON string back through JSON.parse, so a connection called "true" would come back as a
 * boolean and a secret of digits as a number.
 */

/** The connection a role's option names. */
function roleId(value: unknown): string | null {
  const id = (value as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : null
}

async function setOption(db: Database, key: string, value: unknown): Promise<void> {
  await db
    .insert(options)
    .values({ key, value })
    .onConflictDoUpdate({ target: options.key, set: { value, updatedAt: sql`now()` } })
}

/** Makes a connection the primary or the backup; `null` clears the role. One can't be both. */
export async function setRole(
  db: Database,
  role: 'primary' | 'backup',
  id: string | null,
): Promise<void> {
  if (id === null) {
    await db.delete(options).where(eq(options.key, role))
    return
  }
  await setOption(db, role, { id })
  // The connection it replaces as primary isn't made the backup, and the other way round.
  const other = role === PRIMARY ? BACKUP : PRIMARY
  await db.delete(options).where(and(eq(options.key, other), sql`${options.value}->>'id' = ${id}`))
}

/** Adds a routing rule at the end. Returns `false` when there are already as many as allowed. */
export async function addRoute(db: Database, route: Omit<StoredRoute, 'id'>): Promise<boolean> {
  const { routes } = await loadSending(db)
  if (routes.length >= MAX_ROUTES) return false
  await setOption(db, ROUTES, [...routes, { ...route, id: crypto.randomUUID() }])
  return true
}

export async function deleteRoute(db: Database, id: string): Promise<void> {
  const { routes } = await loadSending(db)
  await setOption(
    db,
    ROUTES,
    routes.filter((route) => route.id !== id),
  )
}

/** Moves a rule one place up or down: rules are tried in order. */
export async function moveRoute(db: Database, id: string, direction: 'up' | 'down'): Promise<void> {
  const { routes } = await loadSending(db)
  const from = routes.findIndex((route) => route.id === id)
  const to = direction === 'up' ? from - 1 : from + 1
  if (from < 0 || to < 0 || to >= routes.length) return
  const moved = [...routes]
  ;[moved[from], moved[to]] = [moved[to]!, moved[from]!]
  await setOption(db, ROUTES, moved)
}

function isCondition(value: unknown): value is Condition {
  const condition = value as Condition | null
  return (
    typeof condition === 'object' &&
    condition !== null &&
    typeof condition.field === 'string' &&
    typeof condition.operator === 'string' &&
    typeof condition.value === 'string'
  )
}

function readRoutes(value: unknown): StoredRoute[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (route): route is StoredRoute =>
      typeof route === 'object' &&
      route !== null &&
      typeof (route as StoredRoute).id === 'string' &&
      typeof (route as StoredRoute).connection === 'string' &&
      Array.isArray((route as StoredRoute).conditions) &&
      (route as StoredRoute).conditions.every(isCondition),
  )
}

/** What an email needs to be sent, in two queries: the connections, and who does what. */
export async function loadSending(db: Database): Promise<Sending> {
  const list = await listConnections(db)
  const rows = await db
    .select()
    .from(options)
    .where(inArray(options.key, [PRIMARY, BACKUP, ROUTES]))
  const stored = new Map(rows.map((row) => [row.key, row.value]))
  const known = (value: unknown) => {
    const id = roleId(value)
    return id !== null && list.some((connection) => connection.id === id) ? id : null
  }
  const primary = known(stored.get(PRIMARY)) ?? list[0]?.id ?? null
  const backup = known(stored.get(BACKUP))
  return {
    connections: list,
    primary,
    backup: backup === primary ? null : backup,
    routes: readRoutes(stored.get(ROUTES)),
  }
}

/**
 * The plugin's own secret, made on first use: it signs the `state` of an account connection, so a
 * return from the service can't be forged. Not used to encrypt anything.
 */
export async function pluginSecret(db: Database): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const fresh = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  await db
    .insert(options)
    .values({ key: SECRET, value: { value: fresh } })
    .onConflictDoNothing()
  const [row] = await db.select().from(options).where(eq(options.key, SECRET))
  return (row!.value as { value: string }).value
}

// ── The email log ────────────────────────────────────────────────────────────

/** Which emails the log lists. */
export interface EmailQuery {
  status?: 'sent' | 'failed'
  /** Words in the subject or a recipient's address. */
  search?: string
  page: number
  perPage: number
}

/** `%` and `_` mean themselves in a search, not "anything". */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`

function emailFilter(query: Pick<EmailQuery, 'status' | 'search'>) {
  const search = query.search?.trim()
  return and(
    query.status ? eq(emails.status, query.status) : undefined,
    search
      ? or(
          ilike(emails.subject, likePattern(search)),
          ilike(emails.recipients, likePattern(search)),
        )
      : undefined,
  )
}

export async function logEmail(db: Database, record: EmailRecord): Promise<string> {
  const [row] = await db
    .insert(emails)
    .values({
      ...record,
      sender: clean(record.sender),
      recipients: clean(record.recipients),
      subject: clean(record.subject),
      textBody: cleanOrNull(record.textBody),
      htmlBody: cleanOrNull(record.htmlBody),
      error: cleanOrNull(record.error),
    })
    .returning({ id: emails.id })
  return row!.id
}

/** A page of the log, newest first, with how many match and how many there are of each status. */
export async function listEmails(
  db: Database,
  query: EmailQuery,
): Promise<{
  rows: LoggedEmail[]
  total: number
  counts: { all: number; sent: number; failed: number }
}> {
  const rows = await db
    .select()
    .from(emails)
    .where(emailFilter(query))
    .orderBy(desc(emails.createdAt), desc(emails.id))
    .limit(query.perPage)
    .offset((query.page - 1) * query.perPage)
  // The counts ignore the status filter, as the links above a list do.
  const byStatus = await db
    .select({ status: emails.status, count: sql<number>`count(*)::int` })
    .from(emails)
    .where(emailFilter({ search: query.search }))
    .groupBy(emails.status)
  const count = (status: string) => byStatus.find((row) => row.status === status)?.count ?? 0
  const counts = {
    all: count('sent') + count('failed'),
    sent: count('sent'),
    failed: count('failed'),
  }
  return { rows, total: query.status ? counts[query.status] : counts.all, counts }
}

/** Up to `limit` emails for an export, newest first, without their bodies. */
export async function exportEmails(
  db: Database,
  query: Pick<EmailQuery, 'status' | 'search'>,
  limit: number,
): Promise<Omit<LoggedEmail, 'textBody' | 'htmlBody' | 'attempts'>[]> {
  return db
    .select({
      id: emails.id,
      status: emails.status,
      sender: emails.sender,
      recipients: emails.recipients,
      addresses: emails.addresses,
      subject: emails.subject,
      replyTo: emails.replyTo,
      connection: emails.connection,
      mailer: emails.mailer,
      messageId: emails.messageId,
      providerId: emails.providerId,
      error: emails.error,
      resentFrom: emails.resentFrom,
      createdAt: emails.createdAt,
    })
    .from(emails)
    .where(emailFilter(query))
    .orderBy(desc(emails.createdAt), desc(emails.id))
    .limit(limit)
}

export async function getEmail(db: Database, id: string): Promise<LoggedEmail | null> {
  if (!isEmailId(id)) return null
  const [row] = await db.select().from(emails).where(eq(emails.id, id))
  return row ?? null
}

/** Deletes the emails named, or the whole log. Returns how many went. */
export async function deleteEmails(db: Database, ids: readonly string[] | 'all'): Promise<number> {
  const valid = ids === 'all' ? [] : ids.filter(isEmailId)
  if (ids !== 'all' && valid.length === 0) return 0
  const deleted = await db
    .delete(emails)
    .where(ids === 'all' ? undefined : inArray(emails.id, valid))
    .returning({ id: emails.id })
  return deleted.length
}

/** Deletes emails logged more than `days` days ago, and events older than a month. */
export async function prune(db: Database, days: number): Promise<void> {
  if (days > 0) {
    await db.delete(emails).where(lt(emails.createdAt, sql`now() - make_interval(days => ${days})`))
  }
  await db.delete(events).where(lt(events.createdAt, sql`now() - interval '30 days'`))
}

/** One day's emails. */
export interface DayStats {
  /** `YYYY-MM-DD`, in UTC. */
  day: string
  sent: number
  failed: number
}

/** Sent and failed emails per day, for the last `days` days, today included, oldest first. */
export async function dailyStats(db: Database, days: number): Promise<DayStats[]> {
  const day = sql<string>`to_char(${emails.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
  const rows = await db
    .select({ day, status: emails.status, count: sql<number>`count(*)::int` })
    .from(emails)
    .where(
      gte(
        emails.createdAt,
        sql`date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - make_interval(days => ${days - 1})`,
      ),
    )
    .groupBy(day, emails.status)
  const today = new Date()
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() - (days - 1 - index),
      ),
    )
    const key = date.toISOString().slice(0, 10)
    const count = (status: string) =>
      rows.find((row) => row.day === key && row.status === status)?.count ?? 0
    return { day: key, sent: count('sent'), failed: count('failed') }
  })
}

/** The subjects sent most in the last `days` days, with how many of each were sent and failed. */
export async function topSubjects(
  db: Database,
  days: number,
  limit: number,
): Promise<{ subject: string; sent: number; failed: number }[]> {
  const total = sql<number>`count(*)::int`
  return db
    .select({
      subject: emails.subject,
      sent: sql<number>`(count(*) FILTER (WHERE ${emails.status} = 'sent'))::int`,
      failed: sql<number>`(count(*) FILTER (WHERE ${emails.status} = 'failed'))::int`,
    })
    .from(emails)
    .where(gte(emails.createdAt, sql`now() - make_interval(days => ${days})`))
    .groupBy(emails.subject)
    .orderBy(desc(total), asc(emails.subject))
    .limit(limit)
}

// ── Debug events ─────────────────────────────────────────────────────────────

export async function addEvent(
  db: Database,
  level: 'error' | 'info',
  message: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(events).values({ level, message: clean(message).slice(0, 2000), context })
}

/** The latest events, newest first. */
export async function listEvents(db: Database, limit: number): Promise<LoggedEvent[]> {
  return db.select().from(events).orderBy(desc(events.id)).limit(limit)
}

/** A connection's latest event: why its account didn't connect, when someone just tried. */
export async function lastEventFor(db: Database, connection: string): Promise<LoggedEvent | null> {
  const [event] = await db
    .select()
    .from(events)
    .where(sql`${events.context}->>'connection' = ${connection}`)
    .orderBy(desc(events.id))
    .limit(1)
  return event ?? null
}

export async function clearEvents(db: Database): Promise<void> {
  await db.delete(events)
}

/** The dashboard's numbers, in one query: the last 7 days' emails, and how many connections there are. */
export async function weekSummary(
  db: Database,
): Promise<{ sent: number; failed: number; connections: number }> {
  const [row] = await db
    .select({
      sent: sql<number>`(count(*) FILTER (WHERE ${emails.status} = 'sent'))::int`,
      failed: sql<number>`(count(*) FILTER (WHERE ${emails.status} = 'failed'))::int`,
      connections: sql<number>`(SELECT count(*) FROM mailer_connections)::int`,
    })
    .from(emails)
    .where(gte(emails.createdAt, sql`now() - interval '7 days'`))
  return row ?? { sent: 0, failed: 0, connections: 0 }
}
