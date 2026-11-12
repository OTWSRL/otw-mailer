// Packs the two packages as npm would publish them and checks what a user gets: the engine
// installed with npm into a plain Node project (imported, type-checked and used), and the
// plugin's tarball for what it ships and depends on.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'otw-mailer-packed-'))
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })

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
} finally {
  rmSync(work, { recursive: true, force: true })
}
