# @otwdesign/plugin-mailer

Email delivery for [OTW CMS](https://github.com/OTWSRL/otw-cms): sends the site's email through
SMTP or an email service, with a backup connection, routing rules, an email log, failure alerts
and reports.

## Install

```sh
npm install @otwdesign/plugin-mailer
```

Add it to `cms.config.json`, then activate it under Plugins:

```json
{ "plugins": ["@otwdesign/plugin-mailer"] }
```

## Set up

1. **Mailer › Connections › Add Connection.** Choose a mailer, give the connection an ID (such
   as `main`) and fill in its settings.
2. **Set the connection's secrets in the site's environment.** The connection's screen names
   each variable. For a connection with the ID `main`:

   | Mailer                     | Variable                                              |
   | -------------------------- | ----------------------------------------------------- |
   | A service with an API key  | `MAILER_MAIN_API_KEY`                                 |
   | Other SMTP                 | `MAILER_MAIN_PASSWORD`                                |
   | Amazon SES                 | `MAILER_MAIN_SECRET_ACCESS_KEY`                       |
   | Mailjet                    | `MAILER_MAIN_SECRET_KEY`                              |
   | Gmail, Microsoft 365, Zoho | `MAILER_MAIN_CLIENT_SECRET`, then **Connect account** |

   Secrets are never stored in the database or shown in the admin.

3. **Set the site's sender** in Settings › General › Send email from.
4. **Mailer › Tools › Send a test email.**

## What you get

- **Connections:** as many as you need. One is the primary; another can be the backup, which
  sends when the primary fails.
- **Smart Routing:** rules that send matching emails through another connection.
- **Email Log:** every email with its status and each delivery try. Search, filter, resend,
  delete, export as CSV. Email content is kept only when you turn "Log email content" on.
- **Reports:** sent and failed per day, and the subjects sent most.
- **Tools:** a test email, a DNS check of your sending domain, and debug events.
- **Alerts** when an email fails: email, Slack, Discord, Microsoft Teams, Twilio or a webhook.

## Settings

Each can be set in Mailer › Settings or by its environment variable, which wins.

| Setting             | Variable                       | Default  |
| ------------------- | ------------------------------ | -------- |
| Force From email    | `MAILER_FORCE_FROM_EMAIL`      | off      |
| Force From name     | `MAILER_FORCE_FROM_NAME`       | off      |
| Log sent emails     | `MAILER_LOG`                   | on       |
| Log email content   | `MAILER_LOG_CONTENT`           | off      |
| Keep the log for    | `MAILER_LOG_RETENTION`         | `90d`    |
| Do not send         | `MAILER_DO_NOT_SEND`           | off      |
| Alert email         | `MAILER_ALERT_EMAIL`           |          |
| Slack webhook       | `MAILER_ALERT_SLACK_WEBHOOK`   | env only |
| Discord webhook     | `MAILER_ALERT_DISCORD_WEBHOOK` | env only |
| Teams webhook       | `MAILER_ALERT_TEAMS_WEBHOOK`   | env only |
| Your own webhook    | `MAILER_ALERT_WEBHOOK`         | env only |
| Twilio Account SID  | `MAILER_ALERT_TWILIO_SID`      |          |
| Twilio auth token   | `MAILER_ALERT_TWILIO_TOKEN`    | env only |
| Twilio phone number | `MAILER_ALERT_TWILIO_FROM`     |          |
| Send text alerts to | `MAILER_ALERT_TWILIO_TO`       |          |

## For other plugins

`cms.mail.send()` goes through the plugin as it is. For what it doesn't carry (Cc, Bcc,
attachments, extra headers), use the plugin's service:

```ts
await cms.services.get('mailer').send({
  to: 'ada@example.com',
  cc: 'accounts@example.com',
  subject: 'Your invoice',
  text: 'Attached.',
  attachments: [{ filename: 'invoice.pdf', content: pdfBytes }],
})
```

## Cost

Measured on a production build with one Gmail connection, against the same site without the
plugin:

- **Browsers:** nothing. What visitors and the admin download is the same, byte for byte.
- **Server start:** 29 KB more code loaded and 0.3 MB more memory. Mailer's admin screens load
  on the first admin visit, never at start.
- **Pages:** nothing, on any page that sends no email.
- **Each email:** one request to the mail service, three queries (connections, options, the log
  row) and about 1 ms of the server's own time. Only the mailer in use loads: with Gmail,
  Nodemailer and the other 16 services' code never do.
- **Disk:** 3.1 MB in `node_modules` (Nodemailer is 2.2 MB of it), 0.8 MB more server JavaScript
  in the build.
- **Database:** about 0.7 KB per logged email without its content.

## License

Apache-2.0
