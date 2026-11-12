import {
  ButtonLink,
  EditColumns,
  FormButton,
  FormField,
  FormTable,
  ListTable,
  Notice,
  Postbox,
  SubmitButton,
  TableNav,
  Views,
} from '@otwdesign/admin-ui'
import type { Attempt } from '@otwdesign/mailer'
import type { DomainCheck, Finding } from '@otwdesign/mailer/dns'
import { CONDITION_FIELDS, CONDITION_OPERATORS } from '@otwdesign/mailer'
import { MAILERS, mailerInfo, type MailerField, type MailerInfo } from '@otwdesign/mailer/mailers'
import type { ReactNode } from 'react'
import type { StoredRoute } from './schema.ts'
import { storedFields, type SecretStatus } from './secrets.ts'
import type { DayStats, LoggedEmail, LoggedEvent, Sending, StoredConnection } from './store.ts'
import { STYLES } from './styles.ts'

/** The plugin's own styles, once per screen. */
export function Styles() {
  return <style>{STYLES}</style>
}

/** A connection, and whether it can send as it is. */
export interface ConnectionView {
  connection: StoredConnection
  secrets: SecretStatus[]
  /** For mailers that send as an account: whether one is connected. `null` for the others. */
  connected: boolean | null
  role: 'primary' | 'backup' | null
}

/** What stands between a connection and sending, or `null` when it's ready. */
export function blocker(view: ConnectionView): string | null {
  const missing = view.secrets.filter((secret) => secret.field.required && !secret.set)
  if (missing.length > 0) return `Set ${missing.map((secret) => secret.env).join(', ')}`
  if (view.connected === false) return 'Connect the account'
  return null
}

function Mark({ kind, children }: { kind?: 'ok' | 'bad' | 'warn' | 'role'; children: ReactNode }) {
  return <span className={`mailer-mark${kind ? ` ${kind}` : ''}`}>{children}</span>
}

const mailerLabel = (id: string | null) => (id ? (mailerInfo(id)?.label ?? id) : '—')

const dateTime = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
})
/** A time as the log shows it, in UTC so the server's and the reader's zones can't disagree. */
const when = (date: Date) => `${dateTime.format(date)} UTC`

// ── Connections ──────────────────────────────────────────────────────────────

export function ConnectionsScreen({
  views,
  hasSender,
  doNotSend,
  urls,
}: {
  views: ConnectionView[]
  hasSender: boolean
  doNotSend: boolean
  urls: {
    add: string
    edit(id: string): string
    test(id: string): string
    setRole: string
    remove: string
    general: string
  }
}) {
  return (
    <>
      <Styles />
      {doNotSend && (
        <Notice type="warning" inline>
          “Do not send” is on: no email leaves this site.
        </Notice>
      )}
      {!hasSender && views.length > 0 && (
        <Notice type="warning" inline>
          <p>
            The site has no sender yet, so emails that don’t name one can’t be sent. Set{' '}
            <a href={urls.general}>Send email from</a> in Settings › General.
          </p>
        </Notice>
      )}
      {views.length === 0 ? (
        <Notice type="info" inline title="No connection yet">
          <p>
            A connection is how email leaves the site: an SMTP server, or an email service. Until
            you add one, the site can’t send email.
          </p>
          <p>
            <ButtonLink variant="primary" href={urls.add}>
              Add a connection
            </ButtonLink>
          </p>
        </Notice>
      ) : (
        <ListTable
          caption="Connections"
          rows={views}
          rowKey={(view) => view.connection.id}
          empty="No connections."
          rowActions={(view) => [
            <a key="edit" href={urls.edit(view.connection.id)}>
              Edit
            </a>,
            <a key="test" href={urls.test(view.connection.id)}>
              Send a test
            </a>,
            ...(view.role === 'primary'
              ? []
              : [
                  <FormButton
                    key="primary"
                    variant="link"
                    action={urls.setRole}
                    fields={{ id: view.connection.id, role: 'primary' }}
                  >
                    Make primary
                  </FormButton>,
                  view.role === 'backup' ? (
                    <FormButton
                      key="backup"
                      variant="link"
                      action={urls.setRole}
                      fields={{ id: view.connection.id, role: 'none' }}
                    >
                      Stop using as backup
                    </FormButton>
                  ) : (
                    <FormButton
                      key="backup"
                      variant="link"
                      action={urls.setRole}
                      fields={{ id: view.connection.id, role: 'backup' }}
                    >
                      Use as backup
                    </FormButton>
                  ),
                ]),
            <FormButton
              key="delete"
              variant="delete"
              action={urls.remove}
              fields={{ id: view.connection.id }}
            >
              Delete
            </FormButton>,
          ]}
          columns={[
            {
              key: 'name',
              label: 'Name',
              render: (view) => (
                <>
                  <strong>
                    <a href={urls.edit(view.connection.id)}>{view.connection.name}</a>
                  </strong>{' '}
                  {view.role === 'primary' && <Mark kind="role">Primary</Mark>}
                  {view.role === 'backup' && <Mark kind="role">Backup</Mark>}
                </>
              ),
            },
            {
              key: 'mailer',
              label: 'Mailer',
              render: (view) => mailerLabel(view.connection.mailer),
            },
            { key: 'id', label: 'ID', render: (view) => <code>{view.connection.id}</code> },
            {
              key: 'status',
              label: 'Status',
              render: (view) => {
                const problem = blocker(view)
                return problem ? <Mark kind="bad">{problem}</Mark> : <Mark kind="ok">Ready</Mark>
              },
            },
          ]}
        />
      )}
      {views.length > 0 && (
        <p className="description">
          Email goes through the primary connection. If it fails there, the backup connection sends
          it.
        </p>
      )}
    </>
  )
}

export function MailerPicker({ url }: { url(mailer: string): string }) {
  return (
    <>
      <Styles />
      <p>Choose how this connection sends email.</p>
      <ul className="mailer-grid">
        {MAILERS.map((mailer) => (
          <li key={mailer.id}>
            <a className="mailer-card" href={url(mailer.id)}>
              <strong>{mailer.label}</strong>
              <span>{mailer.description}</span>
            </a>
          </li>
        ))}
      </ul>
    </>
  )
}

function ConfigField({
  field,
  value,
}: {
  field: MailerField
  value: string | number | boolean | undefined
}) {
  const id = `config-${field.name}`
  const name = `config.${field.name}`
  const current = value ?? field.default
  if (field.type === 'boolean') {
    return (
      <FormField label={field.label} htmlFor={id} description={field.help}>
        <input id={id} type="checkbox" name={name} defaultChecked={current === true} />
      </FormField>
    )
  }
  if (field.type === 'select') {
    return (
      <FormField label={field.label} htmlFor={id} description={field.help}>
        <select id={id} name={name} defaultValue={String(current ?? '')}>
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </FormField>
    )
  }
  return (
    <FormField label={field.label} htmlFor={id} description={field.help}>
      <input
        id={id}
        name={name}
        className={field.type === 'number' ? 'small-text' : 'regular-text'}
        type={field.type === 'number' ? 'number' : 'text'}
        min={field.type === 'number' ? 1 : undefined}
        max={field.type === 'number' ? 65535 : undefined}
        required={field.required}
        maxLength={500}
        placeholder={field.placeholder}
        defaultValue={current === undefined ? '' : String(current)}
        autoComplete="off"
        spellCheck={false}
      />
    </FormField>
  )
}

function SecretRow({ secret }: { secret: SecretStatus }) {
  return (
    <FormField
      label={secret.field.label}
      description={
        <>
          {secret.field.help} Set it in the site’s environment as <code>{secret.env}</code>. It is
          never stored in the database or shown here.
        </>
      }
    >
      <span className="field-value">
        {secret.set ? (
          <Mark kind="ok">Set</Mark>
        ) : secret.field.required ? (
          <Mark kind="bad">Not set</Mark>
        ) : (
          <Mark>Not set</Mark>
        )}
      </span>
    </FormField>
  )
}

export function ConnectionForm({
  mailer,
  view,
  suggestedId,
  notice,
  urls,
}: {
  mailer: MailerInfo
  /** The connection being edited; left out for a new one. */
  view?: ConnectionView
  suggestedId?: string
  notice?: { type: 'success' | 'error'; message: string }
  urls: {
    save: string
    list: string
    test?: string
    connect?: string
    disconnect?: string
    redirectUri?: string
  }
}) {
  const connection = view?.connection
  return (
    <>
      <Styles />
      {notice && (
        <Notice type={notice.type} inline role="status">
          {notice.message}
        </Notice>
      )}
      <form method="post" action={urls.save}>
        <input type="hidden" name="mailer" value={mailer.id} />
        {connection && <input type="hidden" name="id" value={connection.id} />}
        <FormTable>
          <FormField label="Mailer">
            <span className="field-value">
              <strong>{mailer.label}</strong>
            </span>
          </FormField>
          <FormField label="Name" htmlFor="connection-name" description="What you call it.">
            <input
              id="connection-name"
              name="name"
              className="regular-text"
              required
              maxLength={80}
              defaultValue={connection?.name ?? mailer.label}
            />
          </FormField>
          {connection ? (
            <FormField label="ID">
              <span className="field-value">
                <code>{connection.id}</code>
              </span>
            </FormField>
          ) : (
            <FormField
              label="ID"
              htmlFor="connection-id"
              description="Lowercase letters, digits and underscores. The environment variables for this connection’s secrets are named after it, so it can’t change later."
            >
              <input
                id="connection-id"
                name="new_id"
                className="regular-text"
                required
                pattern="[a-z][a-z0-9_]{0,23}"
                maxLength={24}
                defaultValue={suggestedId}
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
          )}
          {storedFields(mailer).map((field) => (
            <ConfigField key={field.name} field={field} value={connection?.config[field.name]} />
          ))}
          {view
            ? view.secrets
                .filter((secret) => secret.field.name !== 'refreshToken')
                .map((secret) => <SecretRow key={secret.env} secret={secret} />)
            : mailer.fields
                .filter((field) => field.type === 'secret' && field.name !== 'refreshToken')
                .map((field) => (
                  <FormField key={field.name} label={field.label} description={field.help}>
                    <span className="field-value">
                      Set in the site’s environment, never stored here. You’ll see the variable’s
                      name once the connection is saved.
                    </span>
                  </FormField>
                ))}
        </FormTable>
        <SubmitButton>{connection ? 'Save Connection' : 'Add Connection'}</SubmitButton>
      </form>

      {view && view.connected !== null && (
        <Postbox id="mailer-account" title="Account">
          <p>
            {view.connected ? (
              <Mark kind="ok">Connected</Mark>
            ) : (
              <Mark kind="bad">Not connected</Mark>
            )}{' '}
            {mailer.label} sends as an account you sign in to.
          </p>
          {urls.redirectUri && (
            <p>
              Register this address as the redirect URI of your application:{' '}
              <code>{urls.redirectUri}</code>
            </p>
          )}
          <p>
            {urls.connect ? (
              <ButtonLink variant={view.connected ? 'secondary' : 'primary'} href={urls.connect}>
                {view.connected ? 'Connect another account' : 'Connect account'}
              </ButtonLink>
            ) : (
              <em>Save the client ID and set the client secret first.</em>
            )}{' '}
            {view.connected && urls.disconnect && (
              <FormButton
                variant="delete"
                action={urls.disconnect}
                fields={{ id: view.connection.id }}
              >
                Disconnect
              </FormButton>
            )}
          </p>
        </Postbox>
      )}
      <p>
        <a href={urls.list}>← Back to connections</a>
        {urls.test && (
          <>
            {' | '}
            <a href={urls.test}>Send a test email</a>
          </>
        )}
      </p>
    </>
  )
}

// ── Smart routing ────────────────────────────────────────────────────────────

const label = <T extends string>(list: readonly { value: T; label: string }[], value: string) =>
  list.find((item) => item.value === value)?.label ?? value

/** How many conditions the form offers for one rule. */
export const CONDITION_ROWS = 3

export function RoutingScreen({
  sending,
  urls,
}: {
  sending: Sending
  urls: { add: string; remove: string; move: string; connections: string }
}) {
  const name = (id: string) =>
    sending.connections.find((c) => c.id === id)?.name ?? `${id} (deleted)`
  if (sending.connections.length < 2) {
    return (
      <Notice type="info" inline>
        <p>
          Routing sends some emails through another connection, so it needs at least two.{' '}
          <a href={urls.connections}>Add a connection</a>.
        </p>
      </Notice>
    )
  }
  return (
    <>
      <Styles />
      <p>
        Emails that match a rule go through its connection instead of the primary one. Rules are
        tried from the top, and the first match wins.
      </p>
      <ListTable<StoredRoute & { index: number }>
        caption="Routing rules"
        rows={sending.routes.map((route, index) => ({ ...route, index }))}
        rowKey={(route) => route.id}
        empty="No rules: every email goes through the primary connection."
        rowActions={(route) => [
          ...(route.index > 0
            ? [
                <FormButton
                  key="up"
                  variant="link"
                  action={urls.move}
                  fields={{ id: route.id, direction: 'up' }}
                >
                  Move up
                </FormButton>,
              ]
            : []),
          ...(route.index < sending.routes.length - 1
            ? [
                <FormButton
                  key="down"
                  variant="link"
                  action={urls.move}
                  fields={{ id: route.id, direction: 'down' }}
                >
                  Move down
                </FormButton>,
              ]
            : []),
          <FormButton key="delete" variant="delete" action={urls.remove} fields={{ id: route.id }}>
            Delete
          </FormButton>,
        ]}
        columns={[
          {
            key: 'conditions',
            label: 'When',
            render: (route) => (
              <>
                {route.conditions.map((condition, index) => (
                  <div key={index}>
                    {index > 0 && 'and '}
                    {condition.field === 'header'
                      ? `Header ${condition.header}`
                      : label(CONDITION_FIELDS, condition.field)}{' '}
                    {label(CONDITION_OPERATORS, condition.operator)} “{condition.value}”
                  </div>
                ))}
              </>
            ),
          },
          { key: 'connection', label: 'Send through', render: (route) => name(route.connection) },
        ]}
      />
      <h2>Add a rule</h2>
      <form method="post" action={urls.add}>
        <FormTable>
          <FormField
            label="When"
            description="Every condition you fill in must match. Letter case doesn’t matter."
          >
            {Array.from({ length: CONDITION_ROWS }, (_, row) => (
              <div className="mailer-condition" key={row}>
                <select name={`field.${row}`} aria-label={`Condition ${row + 1}: what to look at`}>
                  {CONDITION_FIELDS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <input
                  name={`header.${row}`}
                  className="small-text"
                  style={{ width: 130 }}
                  placeholder="Header name"
                  aria-label={`Condition ${row + 1}: header name, for Header`}
                  maxLength={76}
                />
                <select name={`operator.${row}`} aria-label={`Condition ${row + 1}: comparison`}>
                  {CONDITION_OPERATORS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <input
                  name={`value.${row}`}
                  className="regular-text"
                  aria-label={`Condition ${row + 1}: value`}
                  maxLength={300}
                  required={row === 0}
                />
              </div>
            ))}
          </FormField>
          <FormField label="Send through" htmlFor="route-connection">
            <select id="route-connection" name="connection" required>
              {sending.connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name}
                </option>
              ))}
            </select>
          </FormField>
        </FormTable>
        <SubmitButton>Add Rule</SubmitButton>
      </form>
    </>
  )
}

// ── The email log ────────────────────────────────────────────────────────────

function StatusMark({ status }: { status: 'sent' | 'failed' }) {
  return status === 'sent' ? <Mark kind="ok">Sent</Mark> : <Mark kind="bad">Failed</Mark>
}

export function LogScreen({
  rows,
  total,
  counts,
  status,
  search,
  page,
  pages,
  logging,
  urls,
}: {
  rows: LoggedEmail[]
  total: number
  counts: { all: number; sent: number; failed: number }
  status: 'sent' | 'failed' | undefined
  search: string
  page: number
  pages: number
  logging: boolean
  urls: {
    list(query: { status?: string; s?: string; page?: number }): string
    listPath: string
    email(id: string): string
    remove: string
    exportCsv: string
  }
}) {
  return (
    <>
      <Styles />
      {!logging && (
        <Notice type="info" inline>
          Logging sent emails is off: only failed emails are recorded.
        </Notice>
      )}
      <form method="get" action={urls.listPath} className="mailer-search" role="search">
        {status && <input type="hidden" name="status" value={status} />}
        <label className="screen-reader-text" htmlFor="log-search">
          Search emails
        </label>
        <input id="log-search" type="search" name="s" defaultValue={search} maxLength={200} />{' '}
        <button type="submit" className="button">
          Search Emails
        </button>
      </form>
      <Views
        label="Filter emails"
        views={[
          { label: 'All', href: urls.list({ s: search }), count: counts.all, current: !status },
          {
            label: 'Sent',
            href: urls.list({ status: 'sent', s: search }),
            count: counts.sent,
            current: status === 'sent',
          },
          {
            label: 'Failed',
            href: urls.list({ status: 'failed', s: search }),
            count: counts.failed,
            current: status === 'failed',
          },
        ]}
      />
      <form method="post" action={urls.remove}>
        <TableNav
          total={total}
          noun={['email', 'emails']}
          page={page}
          pages={pages}
          pageUrl={(target) => urls.list({ status, s: search, page: target })}
        >
          <button type="submit" className="button" name="what" value="selected">
            Delete selected
          </button>{' '}
          <button type="submit" className="button" name="what" value="all">
            Delete all
          </button>{' '}
          <a className="button" href={urls.exportCsv}>
            Export CSV
          </a>
        </TableNav>
        <ListTable
          caption="Emails"
          rows={rows}
          rowKey={(email) => email.id}
          empty={search || status ? 'No emails match.' : 'No emails yet.'}
          select={{
            name: 'ids',
            value: (email) => email.id,
            label: (email) => email.subject || '(no subject)',
          }}
          rowActions={(email) => [
            <a key="view" href={urls.email(email.id)}>
              View
            </a>,
          ]}
          columns={[
            {
              key: 'subject',
              label: 'Subject',
              render: (email) => (
                <strong>
                  <a href={urls.email(email.id)}>{email.subject || '(no subject)'}</a>
                </strong>
              ),
            },
            { key: 'to', label: 'To', render: (email) => email.recipients },
            {
              key: 'status',
              label: 'Status',
              render: (email) => <StatusMark status={email.status} />,
            },
            { key: 'mailer', label: 'Sent through', render: (email) => mailerLabel(email.mailer) },
            { key: 'date', label: 'Date', render: (email) => when(email.createdAt) },
          ]}
        />
      </form>
    </>
  )
}

function Attempts({ attempts }: { attempts: Attempt[] }) {
  if (attempts.length === 0) return <p>No connection was tried.</p>
  return (
    <table className="widefat striped">
      <thead>
        <tr>
          <th scope="col">Connection</th>
          <th scope="col">Mailer</th>
          <th scope="col">Result</th>
          <th scope="col">Took</th>
        </tr>
      </thead>
      <tbody>
        {attempts.map((attempt, index) => (
          <tr key={index}>
            <td>
              <code>{attempt.connection || '—'}</code>
            </td>
            <td>{mailerLabel(attempt.mailer)}</td>
            <td>
              {attempt.ok ? (
                <>
                  Sent{attempt.providerId ? ` (id ${attempt.providerId})` : ''}
                  {attempt.detail ? `: ${attempt.detail}` : ''}
                </>
              ) : (
                (attempt.error?.message ?? 'Failed')
              )}
            </td>
            <td>{attempt.durationMs} ms</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * An email's HTML, shown the only safe way: in a frame with no permissions at all (no scripts,
 * no forms, no navigation), and a policy that loads nothing from the network, so opening the log
 * can't run what an email carries or tell a tracker it was read.
 */
export function previewDocument(html: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><base target="_blank">${html}`
}

export function EmailScreen({
  email,
  urls,
}: {
  email: LoggedEmail
  urls: { list: string; resend: string; remove: string; original?: string }
}) {
  const hasContent = email.textBody !== null || email.htmlBody !== null
  return (
    <>
      <Styles />
      <EditColumns
        main={
          <>
            <Postbox id="mailer-email-details" title="Details">
              <table className="mailer-details">
                <tbody>
                  <tr>
                    <th scope="row">Status</th>
                    <td>
                      <StatusMark status={email.status} />
                    </td>
                  </tr>
                  {email.error && (
                    <tr>
                      <th scope="row">Error</th>
                      <td>{email.error}</td>
                    </tr>
                  )}
                  <tr>
                    <th scope="row">Date</th>
                    <td>{when(email.createdAt)}</td>
                  </tr>
                  <tr>
                    <th scope="row">From</th>
                    <td>{email.sender || '—'}</td>
                  </tr>
                  <tr>
                    <th scope="row">To</th>
                    <td>{email.addresses ? email.addresses.to.join(', ') : email.recipients}</td>
                  </tr>
                  {email.addresses && email.addresses.cc.length > 0 && (
                    <tr>
                      <th scope="row">Cc</th>
                      <td>{email.addresses.cc.join(', ')}</td>
                    </tr>
                  )}
                  {email.addresses && email.addresses.bcc.length > 0 && (
                    <tr>
                      <th scope="row">Bcc</th>
                      <td>{email.addresses.bcc.join(', ')}</td>
                    </tr>
                  )}
                  {email.replyTo && (
                    <tr>
                      <th scope="row">Reply-To</th>
                      <td>{email.replyTo}</td>
                    </tr>
                  )}
                  <tr>
                    <th scope="row">Subject</th>
                    <td>{email.subject || '(no subject)'}</td>
                  </tr>
                  <tr>
                    <th scope="row">Sent through</th>
                    <td>
                      {mailerLabel(email.mailer)}
                      {email.connection && (
                        <>
                          {' '}
                          (<code>{email.connection}</code>)
                        </>
                      )}
                    </td>
                  </tr>
                  {email.messageId && (
                    <tr>
                      <th scope="row">Message ID</th>
                      <td>
                        <code>{email.messageId}</code>
                      </td>
                    </tr>
                  )}
                  {urls.original && (
                    <tr>
                      <th scope="row">Resend of</th>
                      <td>
                        <a href={urls.original}>the original email</a>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Postbox>
            <Postbox id="mailer-email-attempts" title="Delivery">
              <Attempts attempts={email.attempts} />
            </Postbox>
            <Postbox id="mailer-email-content" title="Content">
              {!hasContent && (
                <p>
                  This email’s content wasn’t kept. Turn on “Log email content” in the Mailer
                  settings to keep the content of later emails.
                </p>
              )}
              {email.htmlBody !== null && (
                <iframe
                  className="mailer-preview"
                  title="The email’s HTML"
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={previewDocument(email.htmlBody)}
                />
              )}
              {email.textBody !== null && (
                <>
                  {email.htmlBody !== null && <h3>Plain text</h3>}
                  <pre className="mailer-pre">{email.textBody}</pre>
                </>
              )}
            </Postbox>
          </>
        }
        side={
          <Postbox id="mailer-email-actions" title="Actions">
            {hasContent ? (
              <p>
                <FormButton action={urls.resend} fields={{ id: email.id }} variant="primary">
                  Resend
                </FormButton>
              </p>
            ) : (
              <p className="description">It can’t be sent again: its content wasn’t kept.</p>
            )}
            <p>
              <FormButton
                action={urls.remove}
                fields={{ ids: email.id, what: 'selected', back: 'list' }}
                variant="delete"
              >
                Delete
              </FormButton>
            </p>
            <p>
              <a href={urls.list}>← Back to the log</a>
            </p>
          </Postbox>
        }
      />
    </>
  )
}

// ── Reports ──────────────────────────────────────────────────────────────────

export const REPORT_RANGES = [7, 14, 30] as const

export function ReportsScreen({
  days,
  stats,
  subjects,
  url,
}: {
  days: number
  stats: DayStats[]
  subjects: { subject: string; sent: number; failed: number }[]
  url(days: number): string
}) {
  const sent = stats.reduce((sum, day) => sum + day.sent, 0)
  const failed = stats.reduce((sum, day) => sum + day.failed, 0)
  const most = Math.max(1, ...stats.map((day) => day.sent + day.failed))
  const share = (count: number) => `${(count / most) * 100}%`
  return (
    <>
      <Styles />
      <Views
        label="Period"
        views={REPORT_RANGES.map((range) => ({
          label: `Last ${range} days`,
          href: url(range),
          current: range === days,
        }))}
      />
      <div className="mailer-totals" style={{ clear: 'both' }}>
        <div>
          <b>{sent + failed}</b> emails
        </div>
        <div>
          <b>{sent}</b> sent
        </div>
        <div>
          <b>{failed}</b> failed
        </div>
        <div>
          <b>{sent + failed === 0 ? '—' : `${Math.round((sent / (sent + failed)) * 100)}%`}</b>{' '}
          delivered to the mailer
        </div>
      </div>
      <h2>By day</h2>
      <table className="mailer-bars">
        <thead>
          <tr>
            <th scope="col">Day (UTC)</th>
            <th scope="col" className="num">
              Sent
            </th>
            <th scope="col" className="num">
              Failed
            </th>
            <th scope="col">
              <span className="screen-reader-text">Chart</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {stats.map((day) => (
            <tr key={day.day}>
              <th scope="row">{day.day}</th>
              <td className="num">{day.sent}</td>
              <td className="num">{day.failed}</td>
              <td>
                <div className="mailer-bar" aria-hidden="true">
                  <i style={{ width: share(day.sent) }} />
                  <i className="failed" style={{ width: share(day.failed) }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Most sent</h2>
      <ListTable
        caption="Most sent subjects"
        rows={subjects}
        rowKey={(row) => row.subject}
        empty="No emails in this period."
        columns={[
          { key: 'subject', label: 'Subject', render: (row) => row.subject || '(no subject)' },
          { key: 'sent', label: 'Sent', numeric: true, render: (row) => row.sent },
          { key: 'failed', label: 'Failed', numeric: true, render: (row) => row.failed },
        ]}
      />
      <p className="description">
        Reports count what the email log holds, so they reach back as far as the log is kept, and
        need “Log sent emails” on.
      </p>
    </>
  )
}

// ── Tools ────────────────────────────────────────────────────────────────────

function FindingRow({ name, finding }: { name: string; finding: Finding }) {
  const kind = finding.status === 'pass' ? 'ok' : finding.status === 'fail' ? 'bad' : 'warn'
  const word = finding.status === 'pass' ? 'OK' : finding.status === 'fail' ? 'Problem' : 'Check'
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>
        <Mark kind={kind}>{word}</Mark>
      </td>
      <td>
        {finding.message}
        {finding.record && (
          <>
            <br />
            <code>{finding.record}</code>
          </>
        )}
      </td>
    </tr>
  )
}

export function ToolsScreen({
  connections,
  selected,
  defaultTo,
  domain,
  selector,
  check,
  checkError,
  events,
  urls,
}: {
  connections: StoredConnection[]
  selected: string | undefined
  defaultTo: string
  domain: string
  selector: string
  check: DomainCheck | null
  checkError: string | null
  events: LoggedEvent[]
  urls: { test: string; tools: string; clearEvents: string; connections: string }
}) {
  return (
    <>
      <Styles />
      <h2 id="test">Send a test email</h2>
      {connections.length === 0 ? (
        <p>
          <a href={urls.connections}>Add a connection</a> first.
        </p>
      ) : (
        <form method="post" action={urls.test}>
          <FormTable>
            <FormField label="Send to" htmlFor="test-to">
              <input
                id="test-to"
                name="to"
                type="email"
                className="regular-text"
                required
                maxLength={254}
                defaultValue={defaultTo}
              />
            </FormField>
            <FormField
              label="Through"
              htmlFor="test-connection"
              description="A test goes through this connection only: no routing rules, no backup."
            >
              <select id="test-connection" name="connection" defaultValue={selected}>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label="HTML"
              htmlFor="test-html"
              description="Send an HTML email with a plain-text part."
            >
              <input id="test-html" name="html" type="checkbox" defaultChecked />
            </FormField>
          </FormTable>
          <SubmitButton>Send Test Email</SubmitButton>
        </form>
      )}

      <h2 id="domain">Check a sending domain</h2>
      <p>
        Mail services look at a domain’s DNS before they trust email from it. This looks up the
        records that matter.
      </p>
      <form method="get" action={urls.tools}>
        <FormTable>
          <FormField label="Domain" htmlFor="check-domain">
            <input
              id="check-domain"
              name="domain"
              className="regular-text"
              required
              maxLength={253}
              placeholder="example.com"
              defaultValue={domain}
            />
          </FormField>
          <FormField
            label="DKIM selector"
            htmlFor="check-selector"
            description="Optional. Your mail service names the selector of the key it signs with."
          >
            <input
              id="check-selector"
              name="selector"
              className="regular-text"
              maxLength={63}
              defaultValue={selector}
            />
          </FormField>
        </FormTable>
        <SubmitButton>Check Domain</SubmitButton>
      </form>
      {checkError && (
        <Notice type="error" inline>
          {checkError}
        </Notice>
      )}
      {check && (
        <table className="widefat striped" id="domain-results">
          <caption className="screen-reader-text">DNS records of {check.domain}</caption>
          <tbody>
            <FindingRow name="SPF" finding={check.spf} />
            {check.dkim && <FindingRow name="DKIM" finding={check.dkim} />}
            <FindingRow name="DMARC" finding={check.dmarc} />
            <FindingRow name="MX" finding={check.mx} />
          </tbody>
        </table>
      )}

      <h2 id="events">Debug events</h2>
      <p>
        What went wrong lately, newest first: every failed try at sending, and alerts that weren’t
        sent.
      </p>
      <ListTable
        caption="Debug events"
        rows={events}
        rowKey={(event) => String(event.id)}
        empty="No events."
        columns={[
          { key: 'message', label: 'Event', render: (event) => event.message },
          {
            key: 'context',
            label: 'Details',
            render: (event) =>
              Object.entries(event.context)
                .filter(([, value]) => value !== null && value !== '')
                .map(([key, value]) => `${key}: ${String(value)}`)
                .join(' · '),
          },
          { key: 'date', label: 'Date', render: (event) => when(event.createdAt) },
        ]}
      />
      {events.length > 0 && (
        <p>
          <FormButton action={urls.clearEvents}>Clear events</FormButton>
        </p>
      )}
    </>
  )
}

/** The dashboard's box: the last week at a glance. */
export function DashboardWidget({
  sent,
  failed,
  ready,
  urls,
}: {
  sent: number
  failed: number
  ready: boolean
  urls: { log: string; connections: string }
}) {
  return (
    <Postbox id="mailer-widget" title="Email">
      {!ready && (
        <p>
          <a href={urls.connections}>Set up a connection</a> so the site can send email.
        </p>
      )}
      <p>
        Last 7 days: <a href={urls.log}>{sent} sent</a>
        {failed > 0 && (
          <>
            , <a href={`${urls.log}?status=failed`}>{failed} failed</a>
          </>
        )}
        .
      </p>
    </Postbox>
  )
}
