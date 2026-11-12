import { describe, expect, it } from 'vitest'
import { authorizeUrl, exchangeCode, tokenSource } from '../src/oauth.ts'
import type { OAuthTokens } from '../src/index.ts'
import { fakeFetch, json } from './helpers.ts'

const client = { clientId: 'id', clientSecret: 'shh' }
const never = new AbortController().signal

describe('authorizeUrl', () => {
  const options = { redirectUri: 'https://site.test/api/p/mailer/oauth', state: 'st4te' }

  it('asks Google for offline access to send only', () => {
    const url = new URL(authorizeUrl('google', client, options))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'id',
      redirect_uri: options.redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.send',
      state: 'st4te',
      access_type: 'offline',
      prompt: 'consent',
    })
  })

  it('asks Microsoft in the tenant named, and Zoho in its data center', () => {
    const microsoft = new URL(
      authorizeUrl('microsoft', { ...client, tenant: 'contoso.onmicrosoft.com' }, options),
    )
    expect(microsoft.origin + microsoft.pathname).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize',
    )
    expect(microsoft.searchParams.get('scope')).toBe(
      'offline_access https://graph.microsoft.com/Mail.Send',
    )
    expect(new URL(authorizeUrl('microsoft', client, options)).pathname).toBe(
      '/common/oauth2/v2.0/authorize',
    )
    const zoho = new URL(authorizeUrl('zoho', { ...client, region: 'in' }, options))
    expect(zoho.origin + zoho.pathname).toBe('https://accounts.zoho.in/oauth/v2/auth')
    expect(zoho.searchParams.get('scope')).toBe('ZohoMail.messages.CREATE,ZohoMail.accounts.READ')
  })

  it('never builds a host from a setting it doesn’t know', () => {
    expect(() => authorizeUrl('zoho', { ...client, region: 'evil.test/x' }, options)).toThrow(
      /no data center/,
    )
    expect(() => authorizeUrl('microsoft', { ...client, tenant: 'a/b?c' }, options)).toThrow(
      /tenant isn’t valid/,
    )
  })
})

describe('exchangeCode', () => {
  it('trades the code for tokens', async () => {
    const { fetch, calls } = fakeFetch(
      json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    )
    const tokens = await exchangeCode('google', client, {
      code: 'c0de',
      redirectUri: 'https://site.test/cb',
      fetch,
    })
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt' })
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 3_500_000)
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token')
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body as string))).toEqual({
      client_id: 'id',
      client_secret: 'shh',
      grant_type: 'authorization_code',
      code: 'c0de',
      redirect_uri: 'https://site.test/cb',
    })
  })

  it('refuses a sign-in without lasting access, and a service’s refusal', async () => {
    const noRefresh = fakeFetch(json({ access_token: 'at', expires_in: 3600 }))
    await expect(
      exchangeCode('google', client, {
        code: 'c',
        redirectUri: 'https://site.test/cb',
        fetch: noRefresh.fetch,
      }),
    ).rejects.toThrow(/without lasting access/)
    // Zoho answers 200 with an error.
    const zoho = fakeFetch(json({ error: 'invalid_code' }))
    await expect(
      exchangeCode('zoho', client, {
        code: 'c',
        redirectUri: 'https://site.test/cb',
        fetch: zoho.fetch,
      }),
    ).rejects.toMatchObject({
      code: 'auth',
      message: "Zoho didn't accept the sign-in: invalid_code. Connect the account again.",
    })
    const error = await exchangeCode('microsoft', client, {
      code: 'c',
      redirectUri: 'https://site.test/cb',
      fetch: fakeFetch(
        json(
          { error: 'invalid_grant', error_description: 'AADSTS70008: expired' },
          { status: 400 },
        ),
      ).fetch,
    }).then(
      () => new Error('expected the exchange to fail'),
      (caught: Error) => caught,
    )
    expect(error.message).toContain('AADSTS70008: expired')
    expect(error.message).not.toContain('shh')
  })
})

describe('tokenSource', () => {
  it('renews once for many emails, and reuses the token until it’s about to end', async () => {
    const { fetch, calls } = fakeFetch(json({ access_token: 'at-1', expires_in: 3600 }))
    const token = tokenSource('google', client, { fetch, refreshToken: 'rt' })
    expect(await Promise.all([token(never), token(never), token(never)])).toEqual([
      'at-1',
      'at-1',
      'at-1',
    ])
    expect(await token(never)).toBe('at-1')
    expect(calls).toHaveLength(1)
  })

  it('keeps renewed tokens in the store, the new refresh token included', async () => {
    let stored: OAuthTokens | null = {
      refreshToken: 'rt-1',
      accessToken: 'old',
      expiresAt: Date.now() + 5_000,
    }
    const store = {
      read: async () => stored,
      write: async (tokens: OAuthTokens) => {
        stored = tokens
      },
    }
    const { fetch, calls } = fakeFetch(
      json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }),
    )
    // About to end within the minute: renewed.
    expect(await tokenSource('microsoft', client, { fetch, store })(never)).toBe('at-2')
    expect(stored).toMatchObject({ refreshToken: 'rt-2', accessToken: 'at-2' })
    expect(new URLSearchParams(calls[0]!.body as string).get('refresh_token')).toBe('rt-1')
    // A new process reads the stored token and doesn't renew.
    expect(await tokenSource('microsoft', client, { fetch, store })(never)).toBe('at-2')
    expect(calls).toHaveLength(1)
  })

  it('says to connect an account when there are no tokens, or they stopped working', async () => {
    const { fetch } = fakeFetch(
      json(
        { error: 'invalid_grant', error_description: 'Token has been revoked.' },
        { status: 400 },
      ),
    )
    await expect(tokenSource('google', client, { fetch })(never)).rejects.toMatchObject({
      code: 'not-configured',
      message: 'No Google account is connected yet. Connect one first.',
    })
    await expect(
      tokenSource('google', client, { fetch, refreshToken: 'rt' })(never),
    ).rejects.toMatchObject({
      code: 'auth',
      message:
        "Google didn't accept the sign-in: Token has been revoked.. Connect the account again.",
    })
  })
})
