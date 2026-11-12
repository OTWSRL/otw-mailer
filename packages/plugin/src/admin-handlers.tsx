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
  type AdminActionContext,
  type AdminPageContext,
  type PluginContext,
  type SearchParams,
  type User,
} from '@otwdesign/sdk'
import type { MailerDeps } from './deps.ts'
import { redirectUri } from './redirect.ts'
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
  lastEventFor,
  listEvents,
  loadSending,
  moveRoute,
  setAuth,
  setRole,
  topSubjects,
  updateConnection,
  weekSummary,
  type DayStats,
  type LoggedEmail,
  type LoggedEvent,
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

type Form = Pick<AdminActionContext, 'form'>

/** What the connection screen shows. */
interface ConnectionData {
  view: ConnectionView
  info: MailerInfo
  oauth: string | undefined
  /** Why the account didn't connect, when the person just came back without it. */
  reason: string | undefined
}

/**
 * The admin's screens and actions, bound to the site. Loaded the first time someone opens a Mailer
 * screen, posts one of its forms or views the dashboard: never when the server starts.
 */
export function bind(cms: PluginContext, deps: MailerDeps) {
  const url = {
    connections: () => cms.admin.url('mailer.connections'),
    connection: (id: string) => cms.admin.url('mailer.connection', { id }),
    newConnection: () => cms.admin.url('mailer.connection-new'),
    log: () => cms.admin.url('mailer.log'),
    email: (id: string) => cms.admin.url('mailer.email', { id }),
    tools: () => cms.admin.url('mailer.tools'),
    reports: () => cms.admin.url('mailer.reports'),
    // Settings › General is core's own page, beside this plugin's section.
    general: () => cms.admin.url('/').replace(/\/mailer\/?$/, '/settings'),
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

  const logQuery = (searchParams: SearchParams) => {
    const status = first(searchParams.status)
    return {
      status: status === 'sent' || status === 'failed' ? status : undefined,
      search: (first(searchParams.s) ?? '').slice(0, 200),
      page: pageOf(searchParams),
    } as const
  }
  type LogData = Awaited<ReturnType<typeof listEmails>> & ReturnType<typeof logQuery>

  const sendTest = async ({ form }: Form) => {
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
      if (error instanceof MailerError) {
        throw new ActionError(`The test wasn’t sent. ${error.message}`)
      }
      throw error
    }
    return { notice: `Test email sent to ${to}.` }
  }

  return {
    connections: {
      load: () => loadSending(cms.db),
      component: (data: Sending) => (
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
            general: url.general(),
          }}
        />
      ),
    },

    newConnection: {
      load: async ({ searchParams }: AdminPageContext) => ({
        mailer: mailerInfo(first(searchParams.mailer) ?? '') ?? null,
        taken: (await loadSending(cms.db)).connections.map((connection) => connection.id),
      }),
      component: (data: { mailer: MailerInfo | null; taken: string[] }) =>
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
    },

    connection: {
      load: async ({ params, searchParams }: AdminPageContext): Promise<ConnectionData | null> => {
        const sending = await loadSending(cms.db)
        const connection = sending.connections.find((item) => item.id === params.id)
        const info = connection && mailerInfo(connection.mailer)
        if (!connection || !info) return null
        const oauth = first(searchParams.oauth)
        const reason =
          oauth === 'refused' ? (await lastEventFor(cms.db, connection.id))?.message : undefined
        return { view: viewOf(connection, sending), info, oauth, reason }
      },
      component: (data: ConnectionData) => {
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
                  message: data.reason
                    ? `The account wasn’t connected. ${/[.!?]$/.test(data.reason) ? data.reason : `${data.reason}.`}`
                    : 'The account wasn’t connected. Tools › Debug events has the reason.',
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
              siteAddress: cms.settings.get('site.url') ? undefined : url.general(),
            }}
          />
        )
      },
    },

    routing: {
      load: () => loadSending(cms.db),
      component: (data: Sending) => (
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
    },

    log: {
      load: async ({ searchParams }: AdminPageContext): Promise<LogData> => {
        const query = logQuery(searchParams)
        return { ...(await listEmails(cms.db, { ...query, perPage: PER_PAGE })), ...query }
      },
      component: (data: LogData) => {
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
              exportCsv: link(
                { status: data.status, s: data.search },
                cms.routes.apiUrl('/export'),
              ),
            }}
          />
        )
      },
    },

    email: {
      load: ({ params }: AdminPageContext) => getEmail(cms.db, params.id ?? ''),
      component: (data: LoggedEmail) => (
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
    },

    reports: {
      load: async ({ searchParams }: AdminPageContext) => {
        const asked = Number(first(searchParams.days))
        const days = REPORT_RANGES.find((range) => range === asked) ?? REPORT_RANGES[0]
        return {
          days: days as number,
          stats: await dailyStats(cms.db, days),
          subjects: await topSubjects(cms.db, days, 10),
        }
      },
      component: (data: {
        days: number
        stats: DayStats[]
        subjects: { subject: string; sent: number; failed: number }[]
      }) => <ReportsScreen {...data} url={(days) => `${url.reports()}?days=${days}`} />,
    },

    tools: {
      load: async ({ searchParams }: AdminPageContext) => {
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
      component: (data: ToolsData, user: User) => (
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
    },

    async dashboard(user: User) {
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

    actions: {
      async saveConnection({ form }: Form) {
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

      async deleteConnection({ form }: Form) {
        await cms.transaction((db) => deleteConnection(db, field(form, 'id')))
        return { notice: 'Connection deleted.', redirect: url.connections() }
      },

      async setRole({ form }: Form) {
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

      async disconnect({ form }: Form) {
        await setAuth(cms.db, field(form, 'id'), null)
        return { notice: 'Account disconnected.' }
      },

      sendTest,

      async addRoute({ form }: Form) {
        const conditions = parseConditions(form)
        const connection = await getConnection(cms.db, field(form, 'connection'))
        if (!connection) throw new ActionError('Choose the connection to send through.')
        if (!(await addRoute(cms.db, { connection: connection.id, conditions }))) {
          throw new ActionError('That’s as many rules as a site can have. Delete one first.')
        }
        return { notice: 'Rule added.' }
      },

      async deleteRoute({ form }: Form) {
        await deleteRoute(cms.db, field(form, 'id'))
        return { notice: 'Rule deleted.' }
      },

      async moveRoute({ form }: Form) {
        await moveRoute(
          cms.db,
          field(form, 'id'),
          field(form, 'direction') === 'up' ? 'up' : 'down',
        )
        return { notice: 'Rule moved.' }
      },

      async resendEmail({ form }: Form) {
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

      async deleteEmails({ form }: Form) {
        const all = form.get('what') === 'all'
        const ids = form.getAll('ids').filter((id): id is string => typeof id === 'string')
        if (!all && ids.length === 0) throw new ActionError('Select the emails to delete.')
        const deleted = await deleteEmails(cms.db, all ? 'all' : ids)
        return {
          notice: `${deleted} ${deleted === 1 ? 'email' : 'emails'} deleted.`,
          ...(form.get('back') === 'list' ? { redirect: url.log() } : {}),
        }
      },

      async clearEvents() {
        await clearEvents(cms.db)
        return { notice: 'Events cleared.' }
      },
    },
  }
}

/** What the Tools screen shows. */
interface ToolsData {
  connections: StoredConnection[]
  selected: string | undefined
  events: LoggedEvent[]
  domain: string
  selector: string
  check: DomainCheck | null
  checkError: string | null
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)
}
