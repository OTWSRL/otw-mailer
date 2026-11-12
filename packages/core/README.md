# @otwdesign/mailer

Send email from any Node app through SMTP or 17 email services, with a backup connection and
routing rules. Only the mailer in use is loaded.

```sh
npm install @otwdesign/mailer
```

```ts
import { createMailer } from '@otwdesign/mailer'

const mailer = createMailer({
  from: 'My App <hello@example.com>',
  connections: [
    { id: 'main', mailer: 'postmark', config: { apiKey: process.env.POSTMARK_TOKEN } },
    {
      id: 'spare',
      mailer: 'smtp',
      config: {
        host: 'smtp.example.com',
        encryption: 'tls',
        username: 'app',
        password: process.env.SMTP_PASSWORD,
      },
    },
  ],
  backup: 'spare',
})

await mailer.send({
  to: 'Ada <ada@example.com>',
  subject: 'Your invoice',
  text: 'Thanks for your order.',
  html: '<p>Thanks for your order.</p>',
  attachments: [{ filename: 'invoice.pdf', content: pdfBytes }],
})
```

Creating a mailer loads nothing and opens nothing. A connection's mailer is imported the first
time an email goes through it.

## Mailers

| `mailer`       | Service                  | Settings (`config`)                                                         |
| -------------- | ------------------------ | --------------------------------------------------------------------------- |
| `smtp`         | Any SMTP server          | `host`, `port`, `encryption` (`tls`, `ssl`, `none`), `username`, `password` |
| `sendlayer`    | SendLayer                | `apiKey`                                                                    |
| `smtpcom`      | SMTP.com                 | `apiKey`, `channel`                                                         |
| `brevo`        | Brevo                    | `apiKey`                                                                    |
| `ses`          | Amazon SES               | `accessKeyId`, `secretAccessKey`, `region`, `configurationSet`              |
| `gmail`        | Google Workspace / Gmail | `clientId`, `clientSecret`, `refreshToken`                                  |
| `mailgun`      | Mailgun                  | `apiKey`, `domain`, `region` (`us`, `eu`)                                   |
| `mailjet`      | Mailjet                  | `apiKey`, `secretKey`                                                       |
| `mailersend`   | MailerSend               | `apiKey`, `customHeaders`                                                   |
| `mandrill`     | Mandrill                 | `apiKey`                                                                    |
| `outlook`      | Microsoft 365 / Outlook  | `clientId`, `clientSecret`, `tenant`, `refreshToken`                        |
| `postmark`     | Postmark                 | `apiKey`, `messageStream`                                                   |
| `resend`       | Resend                   | `apiKey`                                                                    |
| `sendgrid`     | SendGrid                 | `apiKey`, `region` (`global`, `eu`)                                         |
| `smtp2go`      | SMTP2GO                  | `apiKey`                                                                    |
| `sparkpost`    | SparkPost                | `apiKey`, `region` (`us`, `eu`)                                             |
| `zoho`         | Zoho Mail                | `clientId`, `clientSecret`, `region`, `refreshToken`                        |
| `elasticemail` | Elastic Email            | `apiKey`                                                                    |

`MAILERS` (also exported from `@otwdesign/mailer/mailers`, which loads no mailer code) describes
every mailer and its fields, for building a settings form.

The services' mailers use `fetch` only, so they run wherever `fetch` does. SMTP uses
[Nodemailer](https://nodemailer.com), which needs Node's sockets.

## Backup and routing

```ts
createMailer({
  connections,
  primary: 'main', // defaults to the first connection
  backup: 'spare', // tried when the first choice fails
  routes: [
    {
      connection: 'marketing',
      conditions: [{ field: 'subject', operator: 'contains', value: 'newsletter' }],
    },
  ],
})
```

A rule sends an email through its connection when the email passes every condition. Rules are
tried in order. `send(message, { connection })` sends through one connection only, with no
rules and no backup, for a test email.

## Errors

`send()` throws a `MailerError`. Its `code` says what went wrong, and `retryable` whether the
same email may pass on another try:

| `code`            | Meaning                                    |
| ----------------- | ------------------------------------------ |
| `invalid-message` | The message isn't a valid email            |
| `not-configured`  | A setting is missing                       |
| `auth`            | The service refused the key or the sign-in |
| `rejected`        | The service refused the email              |
| `rate-limited`    | Too many emails; try later                 |
| `unavailable`     | The service is down; try later             |
| `network`         | The service couldn't be reached            |
| `timeout`         | The service didn't answer in time          |

When no connection took the email, the error is a `DeliveryError`, with every try in `attempts`.
Error messages never contain a key or a password.

## Accounts (Gmail, Microsoft 365, Zoho)

These send as an account a person signs in to. `@otwdesign/mailer/oauth` has the pieces:
`authorizeUrl()` for the consent screen, `exchangeCode()` for the tokens. Pass the refresh token
as `config.refreshToken`, or give the connection a `tokens` store, which also receives the tokens
Microsoft replaces as they're used.

## Checking a sending domain

```ts
import { checkDomain } from '@otwdesign/mailer/dns'

const check = await checkDomain('example.com', { dkimSelector: 's1' })
// check.spf, check.dkim, check.dmarc, check.mx: { status: 'pass' | 'warn' | 'fail', record, message }
```

## License

Apache-2.0
