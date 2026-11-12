// Packs the two packages as npm would publish them and checks what a user gets: the engine
// installed with npm into a plain Node project (imported, type-checked and used), the plugin's
// tarball for what it ships and depends on, and the plugin in an OTW CMS site made by
// create-otw-cms from npm (installed, type-checked, built, run and its admin opened).
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'otw-mailer-packed-'))
const run = (command, args, cwd, env = {}) =>
  execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  })
/** Runs a step whose own output is worth seeing, such as an install or a build. */
const show = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' })
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

function pack(name) {
  const into = join(work, 'tarballs')
  mkdirSync(into, { recursive: true })
  const before = new Set(readdirSync(into))
  run('pnpm', ['pack', '--pack-destination', into], join(root, 'packages', name))
  const file = readdirSync(into).find((entry) => !before.has(entry))
  if (!file) throw new Error(`Packing packages/${name} made no tarball`)
  return join(into, file)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** A port nothing listens on. */
function freePort() {
  return new Promise((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })
}

/** Waits for a server that is starting to answer, and fails if it stops instead. */
async function until(url, server, seconds = 120) {
  for (let waited = 0; waited < seconds; waited++) {
    if (server.exitCode !== null) throw new Error(`The site stopped (exit ${server.exitCode})`)
    // Refused until the server listens: that is what we're waiting out.
    const answered = await fetch(url).then(
      (response) => response.ok,
      () => false,
    )
    if (answered) return
    await sleep(1000)
  }
  throw new Error(`${url} didn't answer within ${seconds} s`)
}

try {
  run('pnpm', ['build'], root)
  const engine = pack('core')
  const plugin = pack('plugin')

  // ── The engine, in a plain Node project ────────────────────────────────────
  const app = join(work, 'app')
  mkdirSync(app)
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'app', private: true, type: 'module' }),
  )
  run('npm', ['install', '--no-audit', '--no-fund', engine], app)
  writeFileSync(
    join(app, 'use.ts'),
    `import { createMailer, MailerError, MAILERS, type Delivery } from '@otwdesign/mailer'
import { mailerInfo } from '@otwdesign/mailer/mailers'
import { authorizeUrl } from '@otwdesign/mailer/oauth'
import { checkDomain, type DomainCheck } from '@otwdesign/mailer/dns'

export const delivery: Promise<Delivery> = createMailer({
  connections: [{ id: 'main', mailer: 'resend', config: { apiKey: 'k' } }],
}).send({ from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't' })
export const info = mailerInfo('smtp')
export const url: string = authorizeUrl('google', { clientId: 'i', clientSecret: 's' }, { redirectUri: 'https://x.test/cb', state: 's' })
export const check: Promise<DomainCheck> = checkDomain('example.com')
export const count: number = MAILERS.length
export const isError = (error: unknown) => error instanceof MailerError
`,
  )
  // A user's own compiler settings: the package's types must stand without this repo's, and
  // without Node's types, which the services' mailers don't need.
  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'es2023',
        lib: ['es2023', 'dom'],
        types: [],
      },
      files: ['use.ts'],
    }),
  )
  run(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], app)
  writeFileSync(
    join(app, 'run.mjs'),
    `import { createMailer, MAILERS } from '@otwdesign/mailer'
import { mailerInfo } from '@otwdesign/mailer/mailers'

if (MAILERS.length !== 18 || !mailerInfo('ses')) throw new Error('The mailers are not all there')

// A service's mailer, through a fetch of our own.
const calls = []
const delivery = await createMailer({
  connections: [{ id: 'main', mailer: 'sendgrid', config: { apiKey: 'k' } }],
  fetch: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return new Response(null, { status: 202, headers: { 'x-message-id': 'id-1' } })
  },
}).send({ from: 'a@example.com', to: 'b@example.com', subject: 'Hello', text: 'Hi' })
if (delivery.providerId !== 'id-1' || calls[0].url !== 'https://api.sendgrid.com/v3/mail/send') {
  throw new Error('SendGrid was not called as expected')
}

// SMTP, which brings Nodemailer: a server that isn't there is a network error, not a missing module.
const error = await createMailer({
  connections: [{ id: 'main', mailer: 'smtp', config: { host: '127.0.0.1', port: 1, encryption: 'none' } }],
})
  .send({ from: 'a@example.com', to: 'b@example.com', subject: 'Hello', text: 'Hi' })
  .catch((caught) => caught)
if (error.code !== 'network') throw new Error('SMTP did not load: ' + error.message)
console.log('The packed engine sends.')
`,
  )
  process.stdout.write(run('node', ['run.mjs'], app))

  // ── The plugin's tarball ───────────────────────────────────────────────────
  const files = run('tar', ['-tzf', plugin], work).trim().split('\n')
  for (const needed of [
    'package/src/index.ts',
    'package/src/admin.tsx',
    'package/src/pipeline.ts',
    'package/LICENSE',
  ]) {
    assert(files.includes(needed), `The plugin's tarball has no ${needed}`)
  }
  assert(!files.some((file) => file.includes('/test/')), "The plugin's tarball ships its tests")
  run('tar', ['-xzf', plugin, '-C', work, 'package/package.json'], work)
  const manifest = JSON.parse(readFileSync(join(work, 'package/package.json'), 'utf8'))
  const engineVersion = JSON.parse(
    readFileSync(join(root, 'packages/core/package.json'), 'utf8'),
  ).version
  assert(
    manifest.dependencies['@otwdesign/mailer'] === engineVersion,
    `The plugin depends on @otwdesign/mailer ${manifest.dependencies['@otwdesign/mailer']}, not ${engineVersion}`,
  )
  const engineFiles = run('tar', ['-tzf', engine], work).trim().split('\n')
  assert(engineFiles.includes('package/dist/index.js'), "The engine's tarball has no build")
  assert(
    engineFiles.includes('package/dist/mailers/smtp.js'),
    "The engine's tarball has no mailers",
  )
  assert(
    !engineFiles.some((file) => file.includes('/test/')),
    "The engine's tarball ships its tests",
  )
  console.log('The packed plugin ships its source and depends on the released engine.')

  // ── The plugin, in an OTW CMS site from npm ────────────────────────────────
  // The plugin ships its TypeScript source, which a site type-checks and bundles with its own
  // compiler settings, as create-otw-cms wrote them: not this repo's. The site is made with the
  // oldest CMS the plugin's peer ranges allow.
  const cms = manifest.peerDependencies['@otwdesign/sdk'].replace(/^\^/, '')
  const site = join(work, 'site')
  run('npx', ['-y', `create-otw-cms@${cms}`, site, '--no-install'], work, {
    npm_config_user_agent: 'npm/11',
  })
  const siteManifest = readJson(join(site, 'package.json'))
  siteManifest.dependencies['@otwdesign/plugin-mailer'] = `file:${plugin}`
  siteManifest.overrides = { ...siteManifest.overrides, '@otwdesign/mailer': `file:${engine}` }
  writeJson(join(site, 'package.json'), siteManifest)
  const config = readJson(join(site, 'cms.config.json'))
  writeJson(join(site, 'cms.config.json'), {
    ...config,
    plugins: [...(config.plugins ?? []), '@otwdesign/plugin-mailer'],
  })
  show('npm', ['install', '--no-audit', '--no-fund'], site)
  show('npm', ['run', 'typecheck'], site)
  show('npm', ['run', 'build'], site)

  const port = await freePort()
  // In its own process group, so stopping it stops what npx started (next start).
  const server = spawn('npx', ['next', 'start', '-p', String(port)], {
    cwd: site,
    env: { ...process.env, CMS_DATA_DIR: join(work, 'site-data'), DATABASE_URL: '' },
    detached: true,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  try {
    // localhost, not 127.0.0.1: the admin's forms check the origin they're posted from.
    const base = `http://localhost:${port}`
    await until(base, server)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(`${base}/admin`)
      await page.waitForURL(/\/admin\/setup/)
      await page.getByLabel('Name').fill('Packed Admin')
      await page.getByLabel('Email').fill('packed@example.com')
      await page.getByLabel('Password').fill('a strong packed password')
      await page.getByRole('button', { name: 'Create administrator' }).click()
      await page.getByRole('status').filter({ hasText: 'Your site is ready.' }).waitFor()
      // The dashboard's box and the Mailer screens, which load on first use.
      await page.goto(`${base}/admin`)
      await page.getByRole('link', { name: 'Set up a connection' }).waitFor()
      await page.goto(`${base}/admin/mailer`)
      await page.getByText('No connection yet').waitFor()
      // A connection saved: the plugin's tables are there, and its forms post.
      await page.goto(`${base}/admin/mailer/connections/new`)
      await page.getByRole('link', { name: /^Other SMTP/ }).click()
      await page.getByLabel('Name', { exact: true }).fill('Packed')
      await page.getByLabel('ID', { exact: true }).fill('main')
      await page.getByLabel('SMTP host').fill('127.0.0.1')
      await page.getByRole('button', { name: 'Add Connection' }).click()
      await page.getByRole('status').filter({ hasText: 'Connection added.' }).waitFor()
    } finally {
      await browser.close()
    }
  } finally {
    process.kill(-server.pid, 'SIGTERM')
  }
  console.log(`The packed plugin type-checks, builds and runs in a create-otw-cms@${cms} site.`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
