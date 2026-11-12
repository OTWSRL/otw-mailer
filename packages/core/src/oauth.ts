import { MailerError } from './errors.ts'
import { clause, networkReason, textField } from './http.ts'
import type { OAuthTokens, TokenStore } from './types.ts'

/** The services that sign an account in for a mailer: Gmail, Microsoft 365 and Zoho Mail. */
export type OAuthProvider = 'google' | 'microsoft' | 'zoho'

/** An OAuth application, as registered with the service. */
export interface OAuthClient {
  clientId: string
  clientSecret: string
  /** Microsoft only: the directory (tenant) ID, or `common`. */
  tenant?: string
  /** Zoho only: the data center, such as `com` or `eu`. */
  region?: string
}

/** Zoho keeps each data center on its own domain; an unknown one is never made into a host. */
const ZOHO: Readonly<Record<string, { accounts: string; mail: string }>> = {
  com: { accounts: 'accounts.zoho.com', mail: 'mail.zoho.com' },
  eu: { accounts: 'accounts.zoho.eu', mail: 'mail.zoho.eu' },
  in: { accounts: 'accounts.zoho.in', mail: 'mail.zoho.in' },
  'com.au': { accounts: 'accounts.zoho.com.au', mail: 'mail.zoho.com.au' },
  jp: { accounts: 'accounts.zoho.jp', mail: 'mail.zoho.jp' },
  ca: { accounts: 'accounts.zohocloud.ca', mail: 'mail.zohocloud.ca' },
  sa: { accounts: 'accounts.zoho.sa', mail: 'mail.zoho.sa' },
  ae: { accounts: 'accounts.zoho.ae', mail: 'mail.zoho.ae' },
  'com.cn': { accounts: 'accounts.zoho.com.cn', mail: 'mail.zoho.com.cn' },
}

const LABELS: Record<OAuthProvider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  zoho: 'Zoho',
}

/** Zoho's hosts for a data center. */
export function zohoHosts(region: string | undefined): { accounts: string; mail: string } {
  const hosts = ZOHO[region ?? 'com']
  if (!hosts) throw new MailerError('not-configured', `Zoho has no data center "${region}".`)
  return hosts
}

interface Endpoints {
  authorize: string
  token: string
  scope: string
  /** What the service needs besides, to give a refresh token. */
  extra: Record<string, string>
}

function endpoints(provider: OAuthProvider, client: OAuthClient): Endpoints {
  if (provider === 'google') {
    return {
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/gmail.send',
      extra: { access_type: 'offline', prompt: 'consent' },
    }
  }
  if (provider === 'microsoft') {
    const tenant = client.tenant?.trim() || 'common'
    if (!/^[A-Za-z0-9.-]{1,100}$/.test(tenant)) {
      throw new MailerError('not-configured', 'The Microsoft tenant isn’t valid.')
    }
    const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`
    return {
      authorize: `${base}/authorize`,
      token: `${base}/token`,
      scope: 'offline_access https://graph.microsoft.com/Mail.Send',
      extra: { response_mode: 'query' },
    }
  }
  const { accounts } = zohoHosts(client.region)
  return {
    authorize: `https://${accounts}/oauth/v2/auth`,
    token: `https://${accounts}/oauth/v2/token`,
    scope: 'ZohoMail.messages.CREATE,ZohoMail.accounts.READ',
    extra: { access_type: 'offline', prompt: 'consent' },
  }
}

/**
 * Where to send a person to let the application send as their account. `state` comes back with
 * them: make it random, remember it, and refuse a return that doesn't carry it.
 */
export function authorizeUrl(
  provider: OAuthProvider,
  client: OAuthClient,
  options: { redirectUri: string; state: string },
): string {
  const { authorize, scope, extra } = endpoints(provider, client)
  const url = new URL(authorize)
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope,
    state: options.state,
    ...extra,
  }).toString()
  return url.toString()
}

async function tokenRequest(
  provider: OAuthProvider,
  client: OAuthClient,
  parameters: Record<string, string>,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number }> {
  const label = LABELS[provider]
  let response: Response
  let body: unknown
  try {
    response = await fetcher(endpoints(provider, client).token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        ...parameters,
      }),
      signal,
      redirect: 'error',
    })
    body = await response.json().catch(() => undefined)
  } catch (error) {
    if (signal?.aborted) {
      throw new MailerError('timeout', `${label} didn't answer the sign-in in time.`, {
        cause: error,
      })
    }
    throw new MailerError(
      'network',
      `Couldn't reach ${label} to sign in: ${networkReason(error)}`,
      {
        cause: error,
      },
    )
  }
  const accessToken = textField(body, 'access_token')
  // Zoho answers 200 with an `error` for a bad code or token.
  if (!response.ok || !accessToken) {
    const said = textField(body, 'error_description') ?? textField(body, 'error') ?? ''
    throw new MailerError(
      'auth',
      `${label} didn't accept the sign-in${said ? `: ${clause(said)}` : ''}. Connect the account again.`,
      { status: response.status },
    )
  }
  const seconds = Number(textField(body, 'expires_in') ?? 3600)
  return {
    accessToken,
    refreshToken: textField(body, 'refresh_token') ?? null,
    expiresAt: Date.now() + (Number.isFinite(seconds) ? seconds : 3600) * 1000,
  }
}

/** Trades the code a person came back with for the tokens that send as their account. */
export async function exchangeCode(
  provider: OAuthProvider,
  client: OAuthClient,
  options: { code: string; redirectUri: string; fetch?: typeof fetch; signal?: AbortSignal },
): Promise<OAuthTokens> {
  const tokens = await tokenRequest(
    provider,
    client,
    { grant_type: 'authorization_code', code: options.code, redirect_uri: options.redirectUri },
    options.fetch ?? fetch,
    options.signal,
  )
  if (!tokens.refreshToken) {
    throw new MailerError(
      'auth',
      `${LABELS[provider]} signed the account in without lasting access. Remove the application's access in the account's security settings, then connect again.`,
    )
  }
  return { ...tokens, refreshToken: tokens.refreshToken }
}

/**
 * A connection's access token, renewed when it's about to stop working, with one renewal at a
 * time however many emails ask. Renewed tokens go to the store: Microsoft replaces the refresh
 * token each time, and an access token kept there serves the next cold start.
 */
export function tokenSource(
  provider: OAuthProvider,
  client: OAuthClient,
  options: { fetch: typeof fetch; store?: TokenStore; refreshToken?: string },
): (signal: AbortSignal) => Promise<string> {
  let known: OAuthTokens | null = null
  let pending: Promise<string> | null = null

  const current = async (signal: AbortSignal): Promise<string> => {
    const tokens =
      known ??
      (await options.store?.read()) ??
      (options.refreshToken ? { refreshToken: options.refreshToken } : null)
    if (!tokens) {
      throw new MailerError(
        'not-configured',
        `No ${LABELS[provider]} account is connected yet. Connect one first.`,
      )
    }
    if (tokens.accessToken && tokens.expiresAt && tokens.expiresAt - 60_000 > Date.now()) {
      known = tokens
      return tokens.accessToken
    }
    const fresh = await tokenRequest(
      provider,
      client,
      { grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
      options.fetch,
      signal,
    )
    known = {
      refreshToken: fresh.refreshToken ?? tokens.refreshToken,
      accessToken: fresh.accessToken,
      expiresAt: fresh.expiresAt,
    }
    await options.store?.write(known)
    return fresh.accessToken
  }

  return (signal) =>
    (pending ??= current(signal).finally(() => {
      pending = null
    }))
}
