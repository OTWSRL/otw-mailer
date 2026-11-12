import { describe, expect, it } from 'vitest'
import { openState, sealState } from '../src/routes.ts'
import { getConnection, listEmails, listEvents, pluginSecret } from '../src/store.ts'
import { seal, unseal } from '../src/tokens.ts'
import { bootMailer, fakeFetch, MESSAGE, renderAdmin } from './fixtures.ts'

describe('stored tokens', () => {
  const tokens = { refreshToken: 'rt-1', accessToken: 'at-1', expiresAt: 1_900_000_000_000 }

  it('come back only with the client secret and the connection they were sealed for', () => {
    const sealed = seal(tokens, 'client-secret', 'google')
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+$/)
    expect(sealed).not.toContain('rt-1')
    expect(unseal(sealed, 'client-secret', 'google')).toEqual(tokens)
    expect(unseal(sealed, 'another-secret', 'google')).toBeNull()
    expect(unseal(sealed, 'client-secret', 'other')).toBeNull()
    // Two seals of the same tokens differ: each has its own nonce.
    expect(seal(tokens, 'client-secret', 'google')).not.toBe(sealed)
  })

  it('are refused when altered or malformed', () => {
    const sealed = seal(tokens, 'client-secret', 'google')
    const [version, iv, body] = sealed.split('.') as [string, string, string]
    const flipped = body.slice(0, -2) + (body.endsWith('AA') ? 'BB' : 'AA')
    expect(unseal(`${version}.${iv}.${flipped}`, 'client-secret', 'google')).toBeNull()
    for (const bad of ['', 'v1', 'v2.a.b', 'v1..', 'not sealed at all']) {
      expect(unseal(bad, 'client-secret', 'google')).toBeNull()
    }
  })
})

describe('the state of an account connection', () => {
  const state = { connection: 'google', user: 'u1', expires: 2_000 }

  it('opens only if this site signed it and it hasn’t run out', () => {
    const sealed = sealState(state, 'site-secret')
    expect(openState(sealed, 'site-secret', 1_000)).toEqual(state)
    expect(openState(sealed, 'site-secret', 2_000)).toBeNull()
    expect(openState(sealed, 'other-secret', 1_000)).toBeNull()
    const [payload, signature] = sealed.split('.') as [string, string]
    const forged = Buffer.from(JSON.stringify({ ...state, user: 'attacker' })).toString('base64url')
    expect(openState(`${forged}.${signature}`, 'site-secret', 1_000)).toBeNull()
    expect(openState(`${payload}.`, 'site-secret', 1_000)).toBeNull()
    expect(openState(null, 'site-secret', 1_000)).toBeNull()
    expect(openState('a.b.c', 'site-secret', 1_000)).toBeNull()
  })
})

describe('connecting a Google account', () => {
  const env = { MAILER_GOOGLE_CLIENT_SECRET: 'client-secret' }
  const boot = (fetch?: typeof globalThis.fetch) =>
    bootMailer({
      env,
      fetch,
      settings: { 'site.url': 'https://site.test' },
      connections: [{ id: 'google', mailer: 'gmail', config: { clientId: 'cid' } }],
    })

  it('sends the administrator to Google with a signed state, and stores the tokens sealed', async () => {
    const network = fakeFetch((call) =>
      call.url === 'https://oauth2.googleapis.com/token'
        ? Response.json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })
        : Response.json({ id: 'gm-1' }),
    )
    const harness = await boot(network.fetch)
    const { cookie, user } = await harness.signIn()

    const before = await renderAdmin(harness, '/admin/mailer/connections/google', user)
    expect(before).toContain('Not connected')
    expect(before).toContain('<code>https://site.test/api/p/mailer/oauth/callback</code>')
    expect(before).toContain('href="/api/p/mailer/oauth/start?connection=google"')

    const start = await harness.request('GET', '/api/p/mailer/oauth/start?connection=google', {
      cookie,
    })
    expect(start.status).toBe(302)
    const consent = new URL(start.headers.get('location')!)
    expect(consent.origin + consent.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(consent.searchParams.get('redirect_uri')).toBe(
      'https://site.test/api/p/mailer/oauth/callback',
    )
    expect(consent.searchParams.get('client_id')).toBe('cid')
    const state = consent.searchParams.get('state')!
    expect(openState(state, await pluginSecret(harness.db))).toMatchObject({
      connection: 'google',
      user: user.id,
    })

    const back = await harness.request(
      'GET',
      `/api/p/mailer/oauth/callback?code=c0de&state=${encodeURIComponent(state)}`,
      { cookie },
    )
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('/admin/mailer/connections/google?oauth=connected')
    expect(Object.fromEntries(new URLSearchParams(network.calls[0]!.body as string))).toMatchObject(
      {
        code: 'c0de',
        client_secret: 'client-secret',
        redirect_uri: 'https://site.test/api/p/mailer/oauth/callback',
      },
    )
    const stored = (await getConnection(harness.db, 'google'))!.auth!
    expect(stored).not.toContain('rt-1')
    expect(unseal(stored, 'client-secret', 'google')).toMatchObject({
      refreshToken: 'rt-1',
      accessToken: 'at-1',
    })
    expect(
      await renderAdmin(harness, '/admin/mailer/connections/google', user, { oauth: 'connected' }),
    ).toContain('Account connected.')

    // Email now goes out as that account, with the stored token.
    expect(await harness.kernel.mail.send(MESSAGE)).toBe(true)
    const send = network.calls.at(-1)!
    expect(send.url).toContain(
      'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send',
    )
    expect(send.headers.authorization).toBe('Bearer at-1')
    expect((await listEmails(harness.db, { page: 1, perPage: 1 })).rows[0]).toMatchObject({
      status: 'sent',
      providerId: 'gm-1',
    })
  })

  it('refuses a return that another person started, was forged, or names a refusal', async () => {
    const network = fakeFetch(() => Response.json({ error: 'invalid_grant' }, { status: 400 }))
    const harness = await boot(network.fetch)
    const admin = await harness.signIn()
    const other = await harness.signIn()
    const start = await harness.request('GET', '/api/p/mailer/oauth/start?connection=google', {
      cookie: admin.cookie,
    })
    const state = encodeURIComponent(
      new URL(start.headers.get('location')!).searchParams.get('state')!,
    )

    const stolen = await harness.request(
      'GET',
      `/api/p/mailer/oauth/callback?code=x&state=${state}`,
      { cookie: other.cookie },
    )
    expect(stolen.status).toBe(400)
    const forged = await harness.request(
      'GET',
      '/api/p/mailer/oauth/callback?code=x&state=abc.def',
      { cookie: admin.cookie },
    )
    expect(forged.status).toBe(400)
    expect(network.calls).toEqual([])

    const denied = await harness.request(
      'GET',
      `/api/p/mailer/oauth/callback?error=access_denied&state=${state}`,
      { cookie: admin.cookie },
    )
    expect(denied.headers.get('location')).toBe('/admin/mailer/connections/google?oauth=refused')
    const refused = await harness.request(
      'GET',
      `/api/p/mailer/oauth/callback?code=x&state=${state}`,
      { cookie: admin.cookie },
    )
    expect(refused.headers.get('location')).toBe('/admin/mailer/connections/google?oauth=refused')
    expect((await getConnection(harness.db, 'google'))!.auth).toBeNull()
    expect((await listEvents(harness.db, 5)).map((event) => event.message)).toEqual([
      "Google didn't accept the sign-in: invalid_grant. Connect the account again.",
      "The account wasn't connected: access_denied",
    ])

    const author = await harness.signIn('author')
    expect(
      (
        await harness.request('GET', '/api/p/mailer/oauth/start?connection=google', {
          cookie: author.cookie,
        })
      ).status,
    ).toBe(403)
    expect(
      (await harness.request('GET', '/api/p/mailer/oauth/start?connection=google')).status,
    ).toBe(302)
  })

  it('won’t start without the client secret, and drops the account when the application changes', async () => {
    const bare = await bootMailer({
      connections: [{ id: 'google', mailer: 'gmail', config: { clientId: 'cid' } }],
    })
    const first = await bare.signIn()
    const start = await bare.request('GET', '/api/p/mailer/oauth/start?connection=google', {
      cookie: first.cookie,
    })
    expect(start.headers.get('location')).toBe('/admin/mailer/connections/google?oauth=not-ready')

    const harness = await boot()
    const { cookie, user } = await harness.signIn()
    const { setAuth } = await import('../src/store.ts')
    await setAuth(harness.db, 'google', seal({ refreshToken: 'rt' }, 'client-secret', 'google'))
    expect(await renderAdmin(harness, '/admin/mailer/connections/google', user)).toContain(
      'mailer-mark ok">Connected',
    )
    const { act } = await import('./fixtures.ts')
    await act(harness, cookie, 'save-connection', {
      id: 'google',
      mailer: 'gmail',
      name: 'Google',
      'config.clientId': 'another-app',
    })
    expect((await getConnection(harness.db, 'google'))!.auth).toBeNull()
    await setAuth(harness.db, 'google', seal({ refreshToken: 'rt' }, 'client-secret', 'google'))
    await act(harness, cookie, 'disconnect', { id: 'google' })
    expect((await getConnection(harness.db, 'google'))!.auth).toBeNull()
  })
})
