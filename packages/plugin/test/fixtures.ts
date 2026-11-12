import type { KernelOptions } from '@otwdesign/core'
import type { PluginDefinition, User } from '@otwdesign/sdk'
import { createTestKernel, TEST_ORIGIN, type TestKernel } from '@otwdesign/testing'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach } from 'vitest'
import { createMailerAdmin } from '../src/admin.tsx'
import { createMailerPlugin } from '../src/index.ts'
import { createConnection, setRole, type StoredConnection } from '../src/store.ts'

let open: TestKernel[] = []

afterEach(async () => {
  await Promise.all(open.map((harness) => harness.close()))
  open = []
})

/** One call a fake `fetch` received. */
export interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** A `fetch` that records its calls and answers with `answer`, per call. */
export function fakeFetch(
  answer: (call: Call) => Response = () => Response.json({ id: 'sent-1' }),
) {
  const calls: Call[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input as string, init)
    const raw = await request.text()
    const type = request.headers.get('content-type') ?? ''
    const call = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: type.includes('json') ? JSON.parse(raw) : raw,
    }
    calls.push(call)
    return answer(call)
  }
  return { fetch: fetcher, calls }
}

type Seed = Pick<StoredConnection, 'id' | 'mailer'> &
  Partial<Pick<StoredConnection, 'name' | 'config'>>

/** A site with the Mailer plugin, its environment and network replaced. */
export async function bootMailer(
  options: {
    env?: Record<string, string>
    fetch?: typeof fetch
    settings?: KernelOptions['settings']
    connections?: Seed[]
    backup?: string
    /** Other plugins on the site. */
    plugins?: PluginDefinition[]
  } = {},
) {
  const env = options.env ?? {}
  const plugin = createMailerPlugin({ env, fetch: options.fetch })
  const harness = await createTestKernel({
    plugins: [plugin, ...(options.plugins ?? [])],
    admin: [createMailerAdmin(plugin)],
    env,
    settings: { 'mail.from': 'Site <site@example.com>', ...options.settings },
  })
  open.push(harness)
  for (const seed of options.connections ?? []) {
    await createConnection(harness.db, { name: seed.id, config: {}, ...seed })
  }
  if (options.backup) await setRole(harness.db, 'backup', options.backup)
  return harness
}

/** A Resend connection and the variable that holds its key. */
export const resend = (id: string): { connection: Seed; env: Record<string, string> } => ({
  connection: { id, mailer: 'resend' },
  env: { [`MAILER_${id.toUpperCase()}_API_KEY`]: `key-${id}` },
})

/** Posts an admin form, and reads where it sent the user and what it told them. */
export async function act(
  harness: TestKernel,
  cookie: string,
  name: string,
  form: Record<string, string> | URLSearchParams,
) {
  const response = await harness.request('POST', `/api/p/mailer/actions/${name}`, {
    cookie,
    ...(form instanceof URLSearchParams
      ? { body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } }
      : { form }),
  })
  const location = response.headers.get('location')
  if (!location) return { status: response.status, path: null, flash: null }
  const url = new URL(location, TEST_ORIGIN)
  const flash = harness.kernel.readFlash(url.searchParams.get('flash') ?? undefined)
  url.searchParams.delete('flash')
  return { status: response.status, path: url.pathname + url.search, flash }
}

/** Renders an admin screen as the app does, for assertions on its markup. */
export async function renderAdmin(
  harness: TestKernel,
  path: string,
  user: User,
  searchParams: Record<string, string> = {},
) {
  const page = await harness.kernel.resolveAdminPage(path, searchParams, user)
  if (page.kind !== 'page') throw new Error(`Expected a page at ${path}, got ${page.kind}`)
  return renderToStaticMarkup((await page.Component(page.props)) as ReactElement)
}

export const MESSAGE = { to: 'bo@example.com', subject: 'Welcome', text: 'Hello Bo' }
