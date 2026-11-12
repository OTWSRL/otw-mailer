import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  isEmail,
  MailerError,
  type Condition,
} from '@otwdesign/mailer'
import type { DomainCheck } from '@otwdesign/mailer/dns'
import { mailerInfo, type MailerInfo } from '@otwdesign/mailer/mailers'
import {
  ActionError,
  defineAdmin,
  type AdminDefinition,
  type PluginContext,
  type PluginDefinition,
  type SearchParams,
} from '@otwdesign/sdk'
import { depsOf, type MailerDeps } from './deps.ts'
import mailer from './index.ts'
import { redirectUri } from './routes.ts'
import {
  ConnectionForm,
  ConnectionsScreen,
  CONDITION_ROWS,
  DashboardWidget,
  EmailScreen,
  LogScreen,
  MailerPicker,
  REPORT_RANGES,
  ReportsScreen,
  RoutingScreen,
  ToolsScreen,
  type ConnectionView,
} from './screens.tsx'
import { CONNECTION_ID, resolveConfig, secretStatus, storedFields } from './secrets.ts'
import {
  addRoute,
  clearEvents,
  createConnection,
  dailyStats,
  deleteConnection,
  deleteEmails,
  deleteRoute,
  getConnection,
  getEmail,
  isEmailId,
  listEmails,
  listEvents,
  loadSending,
  moveRoute,
  setAuth,
  setRole,
  topSubjects,
  updateConnection,
  weekSummary,
  type Sending,
  type StoredConnection,
} from './store.ts'
import { unseal } from './tokens.ts'

const CAPABILITY = 'mailer.manage'
const PER_PAGE = 25
const MAX_CONNECTIONS = 20
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,76}$/

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/** A page number from the query string: 1 unless it's a positive whole number. */
export function pageOf(searchParams: SearchParams): number {
  const page = Number(first(searchParams.page) ?? 1)
  return Number.isSafeInteger(page) && page > 0 ? page : 1
}

/**
 * A mailer's settings from the form, each checked as its field's type: only what the mailer
 * names, and never a secret, which the form doesn't have. Throws an `ActionError` for the first
 * that isn't right.
 */
export function parseConfig(mailer: MailerInfo, form: FormData): StoredConnection['config'] {
  const config: StoredConnection['config'] = {}
  for (const item of storedFields(mailer)) {
    const raw = field(form, `config.${item.name}`)
    if (item.type === 'boolean') {
      config[item.name] = form.get(`config.${item.name}`) !== null
      continue
    }
    if (raw === '') {
      if (item.required) throw new ActionError(`${item.label} is required.`)
      continue
    }
    if (raw.length > 500 || CONTROL.test(raw)) {
      throw new ActionError(`${item.label} must be one line of at most 500 characters.`)
    }
    if (item.type === 'number') {
      const number = Number(raw)
      if (!Number.isSafeInteger(number) || number < 1 || number > 65535) {
        throw new ActionError(`${item.label} must be a number from 1 to 65535.`)
      }
      config[item.name] = number
    } else if (item.type === 'select') {
      if (!item.options?.some((option) => option.value === raw)) {
        throw new ActionError(`${item.label}: choose one of the options.`)
      }
      config[item.name] = raw
    } else {
      config[item.name] = raw
    }
  }
  return config
}

/** A routing rule's conditions from the form: the rows that have a value. */
export function parseConditions(form: FormData): Condition[] {
  const conditions: Condition[] = []
  for (let row = 0; row < CONDITION_ROWS; row++) {
    const value = field(form, `value.${row}`)
    if (!value) continue
    const fieldName = field(form, `field.${row}`)
    const operator = field(form, `operator.${row}`)
    const header = field(form, `header.${row}`)
    const knownField = CONDITION_FIELDS.find((item) => item.value === fieldName)
    const knownOperator = CONDITION_OPERATORS.find((item) => item.value === operator)
    if (!knownField || !knownOperator) throw new ActionError('Choose what to compare, and how.')
    if (value.length > 300 || CONTROL.test(value)) {
      throw new ActionError('A condition’s value must be one line of at most 300 characters.')
    }
    if (knownField.value === 'header' && !HEADER_NAME.test(header)) {
      throw new ActionError('Name the header to compare, such as X-Mailer.')
    }
    conditions.push({
      field: knownField.value,
      operator: knownOperator.value,
      value,
      ...(knownField.value === 'header' ? { header } : {}),
    })
  }
  if (conditions.length === 0) throw new ActionError('Give the rule at least one condition.')
  return conditions
}

function register(cms: PluginContext, deps: MailerDeps): void {
  const url = {
    connections: () => cms.admin.url('mailer.connections'),
    connection: (id: string) => cms.admin.url('mailer.connection', { id }),
    newConnection: () => cms.admin.url('mailer.connection-new'),
    log: () => cms.admin.url('mailer.log'),
    email: (id: string) => cms.admin.url('mailer.email', { id }),
    tools: () => cms.admin.url('mailer.tools'),
    reports: () => cms.admin.url('mailer.reports'),
    routing: () => cms.admin.url('mailer.routing'),
  }

  const viewOf = (connection: StoredConnection, sending: Sending): ConnectionView => {
    const secrets = secretStatus(connection, deps.env)
    const oauth = mailerInfo(connection.mailer)?.oauth
    const config = resolveConfig(connection, deps.env)
    const secret = config.clientSecret
    const connected = !oauth
      ? null
      : Boolean(config.refreshToken) ||
        (connection.auth !== null &&
          typeof secret === 'string' &&
          unseal(connection.auth, secret, connection.id) !== null)
    return {
      connection,
      secrets,
      connected,
      role:
        sending.primary === connection.id
          ? 'primary'
          : sending.backup === connection.id
            ? 'backup'
            : null,
    }
  }

  // ── Screens ────────────────────────────────────────────────────────────────

  cms.admin.page({
    name: 'connections',
    path: '/',
    title: 'Connections',
    capability: CAPABILITY,
    menu: { label: 'Connections', order: 10 },
    load: () => loadSending(cms.db),
    titleAction: () => ({ label: 'Add Connection', url: url.newConnection() }),
    component: ({ data }) => (
      <ConnectionsScreen
        views={data.connections.map((connection) => viewOf(connection, data))}
        hasSender={Boolean(cms.settings.get('mail.from'))}
        doNotSend={cms.settings.get('mailer.do_not_send') === true}
        urls={{
          add: url.newConnection(),
          edit: url.connection,
          test: (id) => `${url.tools()}?connection=${id}#test`,
          setRole: cms.admin.actionUrl('set-role'),
          remove: cms.admin.actionUrl('delete-connection'),
          // Settings › General is core's own page, beside this plugin's section.
          general: cms.admin.url('/').replace(/\/mailer\/?$/, '/settings'),
        }}
      />
    ),
  })

  cms.admin.page({
    name: 'connection-new',
    path: '/connections/new',
    title: 'Add Connection',
    capability: CAPABILITY,
    load: async ({ searchParams }) => ({
      mailer: mailerInfo(first(searchParams.mailer) ?? '') ?? null,
      taken: (await loadSending(cms.db)).connections.map((connection) => connection.id),
    }),
    component: ({ data }) =>
      data.mailer ? (
        <ConnectionForm
          mailer={data.mailer}
          suggestedId={
            data.taken.length === 0
              ? 'main'
              : data.taken.includes(data.mailer.id)
                ? ''
                : data.mailer.id
          }
          urls={{ save: cms.admin.actionUrl('save-connection'), list: url.connections() }}
        />
      ) : (
        <MailerPicker url={(id) => `${url.newConnection()}?mailer=${id}`} />
      ),
  })

  cms.admin.page({
    name: 'connection',
    path: '/connections/:id',
    capability: CAPABILITY,
    load: async ({ params, searchParams }) => {
      const sending = await loadSending(cms.db)
      const connection = sending.connections.find((item) => item.id === params.id)
      const info = connection && mailerInfo(connection.mailer)
      if (!connection || !info) return null
      return { view: viewOf(connection, sending), info, oauth: first(searchParams.oauth) }
    },
    title: ({ data }) => data.view.connection.name,
    component: ({ data }) => {
      const { view, info } = data
      const id = view.connection.id
      const config = resolveConfig(view.connection, deps.env)
      const canConnect = Boolean(config.clientId && config.clientSecret)
      const notice =
        data.oauth === 'connected'
          ? ({ type: 'success', message: 'Account connected.' } as const)
          : data.oauth === 'refused'
            ? ({
                type: 'error',
                message: 'The account wasn’t connected. Tools › Debug events has the reason.',
              } as const)
            : data.oauth === 'not-ready'
              ? ({
                  type: 'error',
                  message: 'Save the client ID and set the client secret before connecting.',
                } as const)
              : undefined
      return (
        <ConnectionForm
          mailer={info}
          view={view}
          notice={notice}
          urls={{
            save: cms.admin.actionUrl('save-connection'),
            list: url.connections(),
            test: `${url.tools()}?connection=${id}#test`,
            connect: canConnect
              ? `${cms.routes.apiUrl('/oauth/start')}?connection=${id}`
              : undefined,
            disconnect: cms.admin.actionUrl('disconnect'),
            redirectUri: info.oauth ? redirectUri(cms) : undefined,
          }}
        />
      )
    },
  })

  cms.admin.page({
    name: 'routing',
    path: '/routing',
    title: 'Smart Routing',
    capability: CAPABILITY,
    menu: { label: 'Smart Routing', order: 20 },
    load: () => loadSending(cms.db),
    component: ({ data }) => (
      <RoutingScreen
        sending={data}
        urls={{
          add: cms.admin.actionUrl('add-route'),
          remove: cms.admin.actionUrl('delete-route'),
          move: cms.admin.actionUrl('move-route'),
          connections: url.newConnection(),
        }}
      />
    ),
  })

  cms.admin.page({
    name: 'log',
    path: '/log',
    title: 'Email Log',
    capability: CAPABILITY,
    menu: { label: 'Email Log', order: 30 },
    load: async ({ searchParams }) => {
      const status = first(searchParams.status)
      const query = {
        status: status === 'sent' || status === 'failed' ? status : undefined,
        search: (first(searchParams.s) ?? '').slice(0, 200),
        page: pageOf(searchParams),
      } as const
      return { ...(await listEmails(cms.db, { ...query, perPage: PER_PAGE })), ...query }
    },
    component: ({ data }) => {
      const link = (query: { status?: string; s?: string; page?: number }, base = url.log()) => {
        const params = new URLSearchParams()
        if (query.status) params.set('status', query.status)
        if (query.s) params.set('s', query.s)
        if (query.page && query.page > 1) params.set('page', String(query.page))
        const search = params.toString()
        return search ? `${base}?${search}` : base
      }
      return (
        <LogScreen
          rows={data.rows}
          total={data.total}
          counts={data.counts}
          status={data.status}
          search={data.search}
          page={data.page}
          pages={Math.max(1, Math.ceil(data.total / PER_PAGE))}
          logging={cms.settings.get('mailer.log') !== false}
          urls={{
            list: link,
            listPath: url.log(),
            email: url.email,
            remove: cms.admin.actionUrl('delete-emails'),
            exportCsv: link({ status: data.status, s: data.search }, cms.routes.apiUrl('/export')),
          }}
        />
      )
    },
  })

  cms.admin.page({
    name: 'email',
    path: '/log/:id',
    capability: CAPABILITY,
    load: ({ params }) => getEmail(cms.db, params.id ?? ''),
    title: ({ data }) => data.subject || '(no subject)',
    component: ({ data }) => (
      <EmailScreen
        email={data}
        urls={{
          list: url.log(),
          resend: cms.admin.actionUrl('resend-email'),
          remove: cms.admin.actionUrl('delete-emails'),
          original: data.resentFrom ? url.email(data.resentFrom) : undefined,
        }}
      />
    ),
  })

  cms.admin.page({
    name: 'reports',
    path: '/reports',
    title: 'Email Reports',
    capability: CAPABILITY,
    menu: { label: 'Reports', order: 40 },
    load: async ({ searchParams }) => {
      const asked = Number(first(searchParams.days))
      const days = REPORT_RANGES.find((range) => range === asked) ?? REPORT_RANGES[0]
      return {
        days,
        stats: await dailyStats(cms.db, days),
        subjects: await topSubjects(cms.db, days, 10),
      }
    },
    component: ({ data }) => (
      <ReportsScreen {...data} url={(days) => `${url.reports()}?days=${days}`} />
    ),
  })

  cms.admin.page({
    name: 'tools',
    path: '/tools',
    title: 'Tools',
    capability: CAPABILITY,
    menu: { label: 'Tools', order: 50 },
    load: async ({ searchParams }) => {
      const domain = (first(searchParams.domain) ?? '').trim().slice(0, 253)
      const selector = (first(searchParams.selector) ?? '').trim().slice(0, 63)
      let check: DomainCheck | null = null
      let checkError: string | null = null
      if (domain) {
        try {
          // Loaded only when a domain is checked.
          const { checkDomain } = await import('@otwdesign/mailer/dns')
          check = await checkDomain(domain, { dkimSelector: selector || undefined })
        } catch (error) {
          checkError =
            error instanceof TypeError ? `${error.message}.` : 'The domain couldn’t be checked.'
        }
      }
      return {
        connections: (await loadSending(cms.db)).connections,
        selected: first(searchParams.connection),
        events: await listEvents(cms.db, 50),
        domain,
        selector,
        check,
        checkError,
      }
    },
    component: ({ data, user }) => (
      <ToolsScreen
        {...data}
        defaultTo={user.email}
        urls={{
          test: cms.admin.actionUrl('send-test'),
          tools: url.tools(),
          clearEvents: cms.admin.actionUrl('clear-events'),
          connections: url.newConnection(),
        }}
      />
    ),
  })

  // ── Settings ───────────────────────────────────────────────────────────────

  cms.admin.settingsPage({
    name: 'settings',
    path: '/settings',
    title: 'Mailer Settings',
    capability: CAPABILITY,
    menu: { label: 'Settings', parent: 'mailer', order: 60 },
  })
  cms.admin.settingsSection({
    name: 'sender',
    page: 'mailer.settings',
    title: 'Sender',
    description: 'The site’s sender is “Send email from” in Settings › General.',
    fields: ['mailer.force_from_email', 'mailer.force_from_name'],
  })
  cms.admin.settingsSection({
    name: 'log',
    page: 'mailer.settings',
    title: 'Email log',
    order: 20,
    fields: ['mailer.log', 'mailer.log_content', 'mailer.log_retention'],
  })
  cms.admin.settingsSection({
    name: 'alerts',
    page: 'mailer.settings',
    title: 'Alerts',
    description:
      'Who to tell when an email fails to send. Webhook addresses are secrets: set them in the site’s environment.',
    order: 30,
    fields: [
      'mailer.alert_email',
      'mailer.alert_slack',
      'mailer.alert_discord',
      'mailer.alert_teams',
      'mailer.alert_webhook',
      'mailer.alert_twilio_sid',
      'mailer.alert_twilio_token',
      'mailer.alert_twilio_from',
      'mailer.alert_twilio_to',
    ],
  })
  cms.admin.settingsSection({
    name: 'sending',
    page: 'mailer.settings',
    title: 'Sending',
    order: 40,
    fields: ['mailer.do_not_send'],
  })

  // ── Dashboard ──────────────────────────────────────────────────────────────

  cms.slots.fill('admin.dashboard', {
    async component({ user }) {
      if (!cms.auth.can(user, CAPABILITY)) return null
      const summary = await weekSummary(cms.db)
      return (
        <DashboardWidget
          sent={summary.sent}
          failed={summary.failed}
          ready={summary.connections > 0}
          urls={{ log: url.log(), connections: url.connections() }}
        />
      )
    },
  })

  // ── Actions ────────────────────────────────────────────────────────────────

  cms.admin.action({
    name: 'save-connection',
    capability: CAPABILITY,
    async handler({ form }) {
      const info = mailerInfo(field(form, 'mailer'))
      if (!info) throw new ActionError('Choose a mailer.')
      const name = field(form, 'name')
      if (!name || name.length > 80 || CONTROL.test(name)) {
        throw new ActionError('Give the connection a name of at most 80 characters.')
      }
      const config = parseConfig(info, form)
      const id = field(form, 'id')
      if (id) {
        const existing = await getConnection(cms.db, id)
        if (!existing || existing.mailer !== info.id) {
          throw new ActionError('That connection no longer exists.')
        }
        // A connected account belongs to the application and tenant it signed in to.
        const moved = ['clientId', 'tenant', 'region'].some(
          (key) => existing.config[key] !== config[key],
        )
        await updateConnection(cms.db, id, {
          name,
          config,
          ...(info.oauth && moved ? { auth: null } : {}),
        })
        return { notice: 'Connection saved.' }
      }
      const newId = field(form, 'new_id')
      if (!CONNECTION_ID.test(newId)) {
        throw new ActionError(
          'The ID must start with a letter and use only lowercase letters, digits and underscores, 24 at most.',
        )
      }
      const { connections } = await loadSending(cms.db)
      if (connections.length >= MAX_CONNECTIONS) {
        throw new ActionError(`A site can have ${MAX_CONNECTIONS} connections at most.`)
      }
      if (!(await createConnection(cms.db, { id: newId, name, mailer: info.id, config }))) {
        throw new ActionError(`There is already a connection with the ID “${newId}”.`)
      }
      return { notice: 'Connection added.', redirect: url.connection(newId) }
    },
  })

  cms.admin.action({
    name: 'delete-connection',
    capability: CAPABILITY,
    async handler({ form }) {
      await cms.transaction((db) => deleteConnection(db, field(form, 'id')))
      return { notice: 'Connection deleted.', redirect: url.connections() }
    },
  })

  cms.admin.action({
    name: 'set-role',
    capability: CAPABILITY,
    async handler({ form }) {
      const role = field(form, 'role')
      const connection = await getConnection(cms.db, field(form, 'id'))
      if (!connection) throw new ActionError('That connection no longer exists.')
      if (role === 'primary') {
        await cms.transaction((db) => setRole(db, 'primary', connection.id))
        return { notice: `${connection.name} is now the primary connection.` }
      }
      if (role === 'backup') {
        const { primary } = await loadSending(cms.db)
        if (primary === connection.id) {
          throw new ActionError('The primary connection can’t be its own backup.')
        }
        await setRole(cms.db, 'backup', connection.id)
        return { notice: `${connection.name} is now the backup connection.` }
      }
      await setRole(cms.db, 'backup', null)
      return { notice: 'No backup connection now.' }
    },
  })

  cms.admin.action({
    name: 'disconnect',
    capability: CAPABILITY,
    async handler({ form }) {
      await setAuth(cms.db, field(form, 'id'), null)
      return { notice: 'Account disconnected.' }
    },
  })

  cms.admin.action({
    name: 'send-test',
    capability: CAPABILITY,
    async handler({ form }) {
      const to = field(form, 'to')
      if (!isEmail(to)) throw new ActionError('Enter the email address to send the test to.')
      const connection = await getConnection(cms.db, field(form, 'connection'))
      if (!connection) throw new ActionError('Choose a connection.')
      const site = cms.settings.get('site.title') || 'your site'
      const text = `This is a test email from ${site}, sent through the “${connection.name}” connection.\n\nIf you're reading it, that connection works.`
      try {
        await cms.services.get('mailer').send(
          {
            to,
            subject: `Test email from ${site}`,
            text,
            html:
              form.get('html') === null
                ? undefined
                : `<p>This is a test email from <strong>${escapeHtml(site)}</strong>, sent through the “${escapeHtml(connection.name)}” connection.</p><p>If you're reading it, that connection works.</p>`,
          },
          { connection: connection.id },
        )
      } catch (error) {
        if (error instanceof MailerError)
          throw new ActionError(`The test wasn’t sent. ${error.message}`)
        throw error
      }
      return { notice: `Test email sent to ${to}.` }
    },
  })

  cms.admin.action({
    name: 'add-route',
    capability: CAPABILITY,
    async handler({ form }) {
      const conditions = parseConditions(form)
      const connection = await getConnection(cms.db, field(form, 'connection'))
      if (!connection) throw new ActionError('Choose the connection to send through.')
      if (!(await addRoute(cms.db, { connection: connection.id, conditions }))) {
        throw new ActionError('That’s as many rules as a site can have. Delete one first.')
      }
      return { notice: 'Rule added.' }
    },
  })

  cms.admin.action({
    name: 'delete-route',
    capability: CAPABILITY,
    async handler({ form }) {
      await deleteRoute(cms.db, field(form, 'id'))
      return { notice: 'Rule deleted.' }
    },
  })

  cms.admin.action({
    name: 'move-route',
    capability: CAPABILITY,
    async handler({ form }) {
      await moveRoute(cms.db, field(form, 'id'), field(form, 'direction') === 'up' ? 'up' : 'down')
      return { notice: 'Rule moved.' }
    },
  })

  cms.admin.action({
    name: 'resend-email',
    capability: CAPABILITY,
    async handler({ form }) {
      const id = field(form, 'id')
      if (!isEmailId(id)) throw new ActionError('That email is no longer in the log.')
      try {
        await cms.services.get('mailer').resend(id)
      } catch (error) {
        if (error instanceof MailerError) throw new ActionError(error.message)
        throw error
      }
      return { notice: 'Email sent again.' }
    },
  })

  cms.admin.action({
    name: 'delete-emails',
    capability: CAPABILITY,
    async handler({ form }) {
      const all = form.get('what') === 'all'
      const ids = form.getAll('ids').filter((id): id is string => typeof id === 'string')
      if (!all && ids.length === 0) throw new ActionError('Select the emails to delete.')
      const deleted = await deleteEmails(cms.db, all ? 'all' : ids)
      return {
        notice: `${deleted} ${deleted === 1 ? 'email' : 'emails'} deleted.`,
        ...(form.get('back') === 'list' ? { redirect: url.log() } : {}),
      }
    },
  })

  cms.admin.action({
    name: 'clear-events',
    capability: CAPABILITY,
    async handler() {
      await clearEvents(cms.db)
      return { notice: 'Events cleared.' }
    },
  })
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)
}

/** The admin entry for a Mailer plugin made with `createMailerPlugin()`, for tests. */
export function createMailerAdmin(plugin: PluginDefinition): AdminDefinition {
  return defineAdmin(plugin, (cms) => register(cms, depsOf(plugin)))
}

/** The Mailer plugin's admin entry: its screens, actions and settings page. */
export default createMailerAdmin(mailer)
