import { createHmac, timingSafeEqual } from 'node:crypto'
import { mailerInfo } from '@otwdesign/mailer/mailers'
import { authorizeUrl, exchangeCode, type OAuthClient } from '@otwdesign/mailer/oauth'
import type { ApiContext, PluginContext, User } from '@otwdesign/sdk'
import type { MailerDeps } from './deps'
import { redirectUri } from './redirect'
import { resolveConfig } from './secrets'
import {
  addEvent,
  exportEmails,
  getConnection,
  pluginSecret,
  setAuth,
  type StoredConnection,
} from './store'
import { seal } from './tokens'

const EXPORT_LIMIT = 10_000
/** How long a person has to finish signing in at the service. */
const STATE_TTL = 10 * 60_000

const text = (status: number, message: string) =>
  new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } })

/**
 * A spreadsheet cell: quoted, and never read as a formula. A subject that starts with `=`, `+`,
 * `-` or `@` would otherwise run in whoever opens the export (CSV injection).
 */
export function csvCell(value: string | null): string {
  const cell = value ?? ''
  const safe = /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell
  return `"${safe.replaceAll('"', '""')}"`
}

async function exportLog(cms: PluginContext, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const status = params.get('status')
  const rows = await exportEmails(
    cms.db,
    {
      status: status === 'sent' || status === 'failed' ? status : undefined,
      search: params.get('s') ?? undefined,
    },
    EXPORT_LIMIT,
  )
  const header = [
    'Date',
    'Status',
    'From',
    'To',
    'Subject',
    'Connection',
    'Mailer',
    'Message ID',
    'Error',
  ]
  const lines = rows.map((row) =>
    [
      row.createdAt.toISOString(),
      row.status,
      row.sender,
      row.recipients,
      row.subject,
      row.connection,
      row.mailer,
      row.messageId,
      row.error,
    ]
      .map(csvCell)
      .join(','),
  )
  return new Response([header.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="email-log-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  })
}

interface State {
  connection: string
  user: string
  expires: number
}

function sign(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

/** The `state` sent to the service: who started connecting which connection, signed. */
export function sealState(state: State, secret: string): string {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url')
  return `${payload}.${sign(payload, secret).toString('base64url')}`
}

/**
 * The state that came back, if this site signed it and it hasn't run out. Anything else is
 * `null`: a made-up return can't attach somebody else's account to a connection.
 */
export function openState(value: string | null, secret: string, now = Date.now()): State | null {
  const [payload, signature] = (value ?? '').split('.')
  if (!payload || !signature) return null
  const given = Buffer.from(signature, 'base64url')
  const expected = sign(payload, secret)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as State
    return typeof state.connection === 'string' &&
      typeof state.user === 'string' &&
      typeof state.expires === 'number' &&
      state.expires > now
      ? state
      : null
  } catch {
    return null
  }
}

function oauthClient(
  connection: StoredConnection,
  deps: MailerDeps,
): { provider: 'google' | 'microsoft' | 'zoho'; client: OAuthClient } | null {
  const provider = mailerInfo(connection.mailer)?.oauth
  const config = resolveConfig(connection, deps.env)
  if (!provider || typeof config.clientId !== 'string' || typeof config.clientSecret !== 'string') {
    return null
  }
  return {
    provider,
    client: {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      tenant: typeof config.tenant === 'string' ? config.tenant : undefined,
      region: typeof config.region === 'string' ? config.region : undefined,
    },
  }
}

const connectionPage = (cms: PluginContext, id: string, result: string) =>
  `${cms.admin.url('/connections/:id', { id })}?oauth=${result}`

async function oauthStart(
  cms: PluginContext,
  deps: MailerDeps,
  request: Request,
  user: User,
): Promise<Response> {
  const id = new URL(request.url).searchParams.get('connection') ?? ''
  const connection = await getConnection(cms.db, id)
  const oauth = connection && oauthClient(connection, deps)
  if (!connection || !oauth) return redirect(connectionPage(cms, id, 'not-ready'))
  const state = sealState(
    { connection: connection.id, user: user.id, expires: Date.now() + STATE_TTL },
    await pluginSecret(cms.db),
  )
  return redirect(
    authorizeUrl(oauth.provider, oauth.client, { redirectUri: redirectUri(cms, request), state }),
  )
}

async function oauthCallback(
  cms: PluginContext,
  deps: MailerDeps,
  request: Request,
  user: User,
): Promise<Response> {
  const params = new URL(request.url).searchParams
  const state = openState(params.get('state'), await pluginSecret(cms.db))
  // The person who comes back must be the one who left: the state names them.
  if (!state || state.user !== user.id)
    return text(400, 'This sign-in link is not valid any more. Start again from the connection.')
  const connection = await getConnection(cms.db, state.connection)
  const oauth = connection && oauthClient(connection, deps)
  const code = params.get('code')
  if (!connection || !oauth || !code) {
    const said = params.get('error_description') ?? params.get('error')
    await addEvent(cms.db, 'error', `No sign-in came back${said ? `: ${said}` : '.'}`, {
      connection: state.connection,
    })
    return redirect(connectionPage(cms, state.connection, 'refused'))
  }
  try {
    const tokens = await exchangeCode(oauth.provider, oauth.client, {
      code,
      redirectUri: redirectUri(cms, request),
      fetch: deps.fetch,
      signal: AbortSignal.timeout(15_000),
    })
    await setAuth(cms.db, connection.id, seal(tokens, oauth.client.clientSecret, connection.id))
    return redirect(connectionPage(cms, connection.id, 'connected'))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await addEvent(cms.db, 'error', reason, { connection: connection.id })
    return redirect(connectionPage(cms, connection.id, 'refused'))
  }
}

/**
 * The plugin's API routes: the log's export, and the two ends of connecting an account. Each is
 * for a signed-in person who may manage email delivery; nothing here is public.
 */
export async function handle(
  cms: PluginContext,
  deps: MailerDeps,
  path: string,
  request: Request,
  context: ApiContext,
): Promise<Response> {
  const user = await context.user()
  if (!user) return redirect(cms.routes.signInUrl(cms.admin.url('/')))
  if (!cms.auth.can(user, 'mailer.manage')) return text(403, 'You may not manage email delivery.')
  switch (path) {
    case '/export':
      return exportLog(cms, request)
    case '/oauth/start':
      return oauthStart(cms, deps, request, user)
    case '/oauth/callback':
      return oauthCallback(cms, deps, request, user)
    default:
      return text(404, 'Not found')
  }
}
