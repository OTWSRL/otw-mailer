import {
  defineAdmin,
  type AdminActionContext,
  type AdminActionResult,
  type AdminDefinition,
  type PluginContext,
  type PluginDefinition,
} from '@otwdesign/sdk'
import type * as Handlers from './admin-handlers.tsx'
import { depsOf, type MailerDeps } from './deps.ts'
import mailer from './index.ts'

const CAPABILITY = 'mailer.manage'

type Bound = ReturnType<typeof Handlers.bind>

/**
 * Registers the admin's screens, actions and settings page by name, path and menu only. Next.js
 * loads every route's code when the server starts, the admin's included, so the screens, the
 * database code and the mailer list are in a module of their own, loaded the first time someone
 * opens a Mailer screen, posts one of its forms or views the dashboard.
 */
function register(cms: PluginContext, deps: MailerDeps): void {
  let bound: Promise<Bound> | undefined
  const impl = () =>
    (bound ??= import('./admin-handlers.tsx').then((module) => module.bind(cms, deps)))
  const action = (
    name: string,
    run: (bound: Bound, context: AdminActionContext) => Promise<AdminActionResult | void>,
  ) =>
    cms.admin.action({
      name,
      capability: CAPABILITY,
      handler: async (context) => run(await impl(), context),
    })

  // ── Screens ────────────────────────────────────────────────────────────────

  cms.admin.page({
    name: 'connections',
    path: '/',
    title: 'Connections',
    capability: CAPABILITY,
    menu: { label: 'Connections', order: 10 },
    load: async () => (await impl()).connections.load(),
    titleAction: () => ({ label: 'Add Connection', url: cms.admin.url('mailer.connection-new') }),
    component: async ({ data }) => (await impl()).connections.component(data),
  })

  cms.admin.page({
    name: 'connection-new',
    path: '/connections/new',
    title: 'Add Connection',
    capability: CAPABILITY,
    load: async (context) => (await impl()).newConnection.load(context),
    component: async ({ data }) => (await impl()).newConnection.component(data),
  })

  cms.admin.page({
    name: 'connection',
    path: '/connections/:id',
    capability: CAPABILITY,
    load: async (context) => (await impl()).connection.load(context),
    title: ({ data }) => data.view.connection.name,
    component: async ({ data }) => (await impl()).connection.component(data),
  })

  cms.admin.page({
    name: 'routing',
    path: '/routing',
    title: 'Smart Routing',
    capability: CAPABILITY,
    menu: { label: 'Smart Routing', order: 20 },
    load: async () => (await impl()).routing.load(),
    component: async ({ data }) => (await impl()).routing.component(data),
  })

  cms.admin.page({
    name: 'log',
    path: '/log',
    title: 'Email Log',
    capability: CAPABILITY,
    menu: { label: 'Email Log', order: 30 },
    load: async (context) => (await impl()).log.load(context),
    component: async ({ data }) => (await impl()).log.component(data),
  })

  cms.admin.page({
    name: 'email',
    path: '/log/:id',
    capability: CAPABILITY,
    load: async (context) => (await impl()).email.load(context),
    title: ({ data }) => data.subject || '(no subject)',
    component: async ({ data }) => (await impl()).email.component(data),
  })

  cms.admin.page({
    name: 'reports',
    path: '/reports',
    title: 'Email Reports',
    capability: CAPABILITY,
    menu: { label: 'Reports', order: 40 },
    load: async (context) => (await impl()).reports.load(context),
    component: async ({ data }) => (await impl()).reports.component(data),
  })

  cms.admin.page({
    name: 'tools',
    path: '/tools',
    title: 'Tools',
    capability: CAPABILITY,
    menu: { label: 'Tools', order: 50 },
    load: async (context) => (await impl()).tools.load(context),
    component: async ({ data, user }) => (await impl()).tools.component(data, user),
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
    // Checked here, so a dashboard viewer who may not manage email never loads the screens.
    component: async ({ user }) =>
      cms.auth.can(user, CAPABILITY) ? (await impl()).dashboard(user) : null,
  })

  // ── Actions ────────────────────────────────────────────────────────────────

  action('save-connection', (bound, context) => bound.actions.saveConnection(context))
  action('delete-connection', (bound, context) => bound.actions.deleteConnection(context))
  action('set-role', (bound, context) => bound.actions.setRole(context))
  action('disconnect', (bound, context) => bound.actions.disconnect(context))
  action('send-test', (bound, context) => bound.actions.sendTest(context))
  action('add-route', (bound, context) => bound.actions.addRoute(context))
  action('delete-route', (bound, context) => bound.actions.deleteRoute(context))
  action('move-route', (bound, context) => bound.actions.moveRoute(context))
  action('resend-email', (bound, context) => bound.actions.resendEmail(context))
  action('delete-emails', (bound, context) => bound.actions.deleteEmails(context))
  action('clear-events', (bound) => bound.actions.clearEvents())
}

/** The admin entry for a Mailer plugin made with `createMailerPlugin()`, for tests. */
export function createMailerAdmin(plugin: PluginDefinition): AdminDefinition {
  return defineAdmin(plugin, (cms) => register(cms, depsOf(plugin)))
}

/** The Mailer plugin's admin entry: its screens, actions and settings page. */
export default createMailerAdmin(mailer)
