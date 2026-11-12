# OTW Mailer

Email delivery for [OTW CMS](https://github.com/OTWSRL/otw-cms), and for any Node app: SMTP or
17 email services, a backup connection, routing rules, an email log, failure alerts and reports.

| Package                                       | What it is                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| [`@otwdesign/mailer`](packages/core)          | The engine. Works in any Node app, Next.js, Bun and Deno.                 |
| [`@otwdesign/plugin-mailer`](packages/plugin) | The OTW CMS plugin: sends the site's email, with admin screens and a log. |

## What it does

- **18 mailers:** Other SMTP, SendLayer, SMTP.com, Brevo, Amazon SES, Google Workspace / Gmail,
  Mailgun, Mailjet, MailerSend, Mandrill, Microsoft 365 / Outlook, Postmark, Resend, SendGrid,
  SMTP2GO, SparkPost, Zoho Mail and Elastic Email.
- **Only the mailer in use is loaded.** Each mailer is a module of its own, imported the first
  time an email goes through it. A site that sends through SendGrid never loads the SMTP client.
- **Backup connection:** when the first connection fails, the email goes through the backup.
- **Smart routing:** rules send matching emails (by subject, recipient, sender, body or a
  header) through another connection.
- **Email log:** every email, its status, each delivery try and why it failed. Search, filter,
  resend, delete and export as CSV.
- **Alerts** when an email fails: email, Slack, Discord, Microsoft Teams, a text message through
  Twilio, or a webhook of your own.
- **Reports:** sent and failed per day, and the subjects sent most.
- **Tools:** a test email through any connection, a DNS check of a sending domain (SPF, DKIM,
  DMARC, MX), and debug events.

## Security

- **Secrets come from the environment only.** API keys and passwords are read from environment
  variables, never stored in the database and never shown in the admin. OAuth tokens (Gmail,
  Microsoft 365, Zoho) are stored encrypted with a key made from the client secret, which is in
  the environment.
- **No header injection:** addresses, subjects and headers that contain a line break are refused.
- **Errors never carry a key:** a service's answer that repeats the key has it removed.
- **The log's HTML preview** renders in a frame with no permissions and no network access.
- **CSV exports** can't run as spreadsheet formulas.

## Development

The CMS plugin's tests and test site link the CMS's packages from a checkout beside this repo
(`../nextjs-cms`).

```sh
pnpm install
pnpm test:all   # everything CI runs: lint, format, types, tests, e2e, packed installs
```

- `pnpm check` runs lint, the format check, type checks and the unit and integration tests.
- `pnpm test:e2e` builds the engine and the test site, then runs the Playwright tests against a
  real SMTP server the tests start themselves.
- `pnpm dev` runs the test site on http://localhost:3480.

## Releasing

Run `pnpm changeset` with each change. To release, run `pnpm version-packages`, commit and push
to `main`: once CI passes, the release workflow publishes the packages whose version isn't on
npm yet.

## License

Apache-2.0
