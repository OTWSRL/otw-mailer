/*
 * What each mailer is called and which settings it takes. Data only: importing this loads no
 * mailer's code, so a settings screen can list them all for the price of this file.
 */

/** A mailer's id: how connections name it. */
export type MailerId =
  | 'smtp'
  | 'sendlayer'
  | 'smtpcom'
  | 'brevo'
  | 'ses'
  | 'gmail'
  | 'mailgun'
  | 'mailjet'
  | 'mailersend'
  | 'mandrill'
  | 'outlook'
  | 'postmark'
  | 'resend'
  | 'sendgrid'
  | 'smtp2go'
  | 'sparkpost'
  | 'zoho'
  | 'elasticemail'

/** One of a mailer's settings. */
export interface MailerField {
  /** Its key in a connection's `config`. */
  name: string
  label: string
  /** `secret` is a key or password: keep it out of databases, logs and pages. */
  type: 'text' | 'secret' | 'number' | 'select' | 'boolean'
  required?: boolean
  default?: string | number | boolean
  /** The choices of a `select`. */
  options?: readonly { value: string; label: string }[]
  help?: string
  placeholder?: string
}

/** A mailer: its name, what it needs, and what it can carry. */
export interface MailerInfo {
  id: MailerId
  label: string
  description: string
  /** The service's website. */
  url: string
  fields: readonly MailerField[]
  /** Set for mailers that send as a signed-in account, with the service that signs it in. */
  oauth?: 'google' | 'microsoft' | 'zoho'
  /** Whether the service sends the plain-text and HTML bodies together; some send only one. */
  alternative: boolean
  /** Whether extra headers are sent. */
  headers: boolean
  /** Whether files shown inside the HTML body (`cid:`) stay inline. */
  inline: boolean
}

const apiKey = (help: string): MailerField => ({
  name: 'apiKey',
  label: 'API key',
  type: 'secret',
  required: true,
  help,
})

const oauthClient = (idLabel: string, where: string): MailerField[] => [
  { name: 'clientId', label: idLabel, type: 'text', required: true, help: where },
  { name: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
  {
    name: 'refreshToken',
    label: 'Refresh token',
    type: 'secret',
    help: 'Only when the tokens are not kept in a token store.',
  },
]

/** Every mailer, in the order a picker shows them. */
export const MAILERS: readonly MailerInfo[] = [
  {
    id: 'smtp',
    label: 'Other SMTP',
    description: 'Any mail server that speaks SMTP: your host’s, your provider’s, or your own.',
    url: 'https://en.wikipedia.org/wiki/Simple_Mail_Transfer_Protocol',
    alternative: true,
    headers: true,
    inline: true,
    fields: [
      {
        name: 'host',
        label: 'SMTP host',
        type: 'text',
        required: true,
        placeholder: 'smtp.example.com',
      },
      {
        name: 'encryption',
        label: 'Encryption',
        type: 'select',
        default: 'tls',
        options: [
          { value: 'tls', label: 'TLS (STARTTLS, usually port 587)' },
          { value: 'ssl', label: 'SSL (usually port 465)' },
          { value: 'none', label: 'None (usually port 25)' },
        ],
      },
      {
        name: 'port',
        label: 'SMTP port',
        type: 'number',
        help: 'Defaults to 587 for TLS, 465 for SSL and 25 for none.',
      },
      {
        name: 'autoTls',
        label: 'Auto TLS',
        type: 'boolean',
        default: true,
        help: 'With no encryption chosen, still encrypt when the server offers it.',
      },
      {
        name: 'verifyCertificate',
        label: 'Verify the server’s certificate',
        type: 'boolean',
        default: true,
        help: 'Turn off only for a test server with a self-signed certificate.',
      },
      {
        name: 'username',
        label: 'SMTP username',
        type: 'text',
        help: 'Leave empty for a server without sign-in.',
      },
      { name: 'password', label: 'SMTP password', type: 'secret' },
    ],
  },
  {
    id: 'sendlayer',
    label: 'SendLayer',
    description: 'Transactional email with a simple setup.',
    url: 'https://sendlayer.com',
    alternative: true,
    headers: true,
    inline: false,
    fields: [apiKey('Settings › API Keys in your SendLayer account.')],
  },
  {
    id: 'smtpcom',
    label: 'SMTP.com',
    description: 'A long-standing email delivery service.',
    url: 'https://www.smtp.com',
    alternative: true,
    headers: true,
    inline: true,
    fields: [
      apiKey('Account › API in your SMTP.com account.'),
      {
        name: 'channel',
        label: 'Sender name',
        type: 'text',
        required: true,
        help: 'The channel (sender) to send through, from Senders in your account.',
      },
    ],
  },
  {
    id: 'brevo',
    label: 'Brevo',
    description: 'Formerly Sendinblue. Transactional and marketing email.',
    url: 'https://www.brevo.com',
    alternative: true,
    headers: true,
    inline: false,
    fields: [apiKey('SMTP & API › API Keys in your Brevo account.')],
  },
  {
    id: 'ses',
    label: 'Amazon SES',
    description: 'Amazon Web Services’ email service.',
    url: 'https://aws.amazon.com/ses/',
    alternative: true,
    headers: true,
    inline: true,
    fields: [
      { name: 'accessKeyId', label: 'Access key ID', type: 'text', required: true },
      { name: 'secretAccessKey', label: 'Secret access key', type: 'secret', required: true },
      {
        name: 'region',
        label: 'Region',
        type: 'text',
        required: true,
        default: 'us-east-1',
        placeholder: 'us-east-1',
      },
      { name: 'configurationSet', label: 'Configuration set', type: 'text', help: 'Optional.' },
    ],
  },
  {
    id: 'gmail',
    label: 'Google Workspace / Gmail',
    description: 'Sends as your Gmail or Google Workspace account, through Google’s API.',
    url: 'https://workspace.google.com',
    oauth: 'google',
    alternative: true,
    headers: true,
    inline: true,
    fields: oauthClient(
      'Client ID',
      'From an OAuth client (type Web application) in Google Cloud.',
    ),
  },
  {
    id: 'mailgun',
    label: 'Mailgun',
    description: 'Email delivery for developers.',
    url: 'https://www.mailgun.com',
    alternative: true,
    headers: true,
    inline: true,
    fields: [
      apiKey('A sending key from your domain’s settings, or a private API key.'),
      {
        name: 'domain',
        label: 'Domain name',
        type: 'text',
        required: true,
        placeholder: 'mg.example.com',
      },
      {
        name: 'region',
        label: 'Region',
        type: 'select',
        default: 'us',
        options: [
          { value: 'us', label: 'US' },
          { value: 'eu', label: 'EU' },
        ],
      },
    ],
  },
  {
    id: 'mailjet',
    label: 'Mailjet',
    description: 'Transactional and marketing email.',
    url: 'https://www.mailjet.com',
    alternative: true,
    headers: true,
    inline: true,
    fields: [
      { name: 'apiKey', label: 'API key', type: 'text', required: true },
      { name: 'secretKey', label: 'Secret key', type: 'secret', required: true },
    ],
  },
  {
    id: 'mailersend',
    label: 'MailerSend',
    description: 'Transactional email by the makers of MailerLite.',
    url: 'https://www.mailersend.com',
    alternative: true,
    headers: true,
    inline: true,
    fields: [
      apiKey('Integrations › API tokens in your MailerSend account.'),
      {
        name: 'customHeaders',
        label: 'Send extra headers',
        type: 'boolean',
        default: false,
        help: 'MailerSend takes custom headers on its Professional plan and above.',
      },
    ],
  },
  {
    id: 'mandrill',
    label: 'Mandrill',
    description: 'Mailchimp’s transactional email.',
    url: 'https://mailchimp.com/features/transactional-email/',
    alternative: true,
    headers: true,
    inline: true,
    fields: [apiKey('Settings › SMTP & API Info in Mandrill.')],
  },
  {
    id: 'outlook',
    label: 'Microsoft 365 / Outlook',
    description: 'Sends as your Microsoft 365 or Outlook.com account, through Microsoft Graph.',
    url: 'https://www.microsoft.com/microsoft-365',
    oauth: 'microsoft',
    alternative: true,
    headers: true,
    inline: true,
    fields: [
      ...oauthClient('Application (client) ID', 'From an app registration in Microsoft Entra.'),
      {
        name: 'tenant',
        label: 'Tenant',
        type: 'text',
        default: 'common',
        help: 'The directory (tenant) ID, or `common` for any Microsoft account.',
      },
    ],
  },
  {
    id: 'postmark',
    label: 'Postmark',
    description: 'Fast transactional email.',
    url: 'https://postmarkapp.com',
    alternative: true,
    headers: true,
    inline: true,
    fields: [
      {
        name: 'apiKey',
        label: 'Server API token',
        type: 'secret',
        required: true,
        help: 'API Tokens on your Postmark server.',
      },
      {
        name: 'messageStream',
        label: 'Message stream ID',
        type: 'text',
        default: 'outbound',
        help: 'The transactional stream to send through.',
      },
    ],
  },
  {
    id: 'resend',
    label: 'Resend',
    description: 'Email for developers.',
    url: 'https://resend.com',
    alternative: true,
    headers: true,
    inline: true,
    fields: [apiKey('API Keys in your Resend account.')],
  },
  {
    id: 'sendgrid',
    label: 'SendGrid',
    description: 'Twilio’s email delivery service.',
    url: 'https://sendgrid.com',
    alternative: true,
    headers: true,
    inline: true,
    fields: [
      apiKey('Settings › API Keys, with Mail Send access.'),
      {
        name: 'region',
        label: 'Region',
        type: 'select',
        default: 'global',
        options: [
          { value: 'global', label: 'Global' },
          { value: 'eu', label: 'EU' },
        ],
      },
    ],
  },
  {
    id: 'smtp2go',
    label: 'SMTP2GO',
    description: 'Email delivery with worldwide servers.',
    url: 'https://www.smtp2go.com',
    alternative: true,
    headers: true,
    inline: true,
    fields: [apiKey('Sending › API Keys in your SMTP2GO account.')],
  },
  {
    id: 'sparkpost',
    label: 'SparkPost',
    description: 'Email delivery by Bird.',
    url: 'https://www.sparkpost.com',
    alternative: true,
    headers: true,
    inline: true,
    fields: [
      apiKey('An API key with Transmissions: Read/Write.'),
      {
        name: 'region',
        label: 'Region',
        type: 'select',
        default: 'us',
        options: [
          { value: 'us', label: 'US' },
          { value: 'eu', label: 'EU' },
        ],
      },
    ],
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    description: 'Sends as your Zoho Mail account.',
    url: 'https://www.zoho.com/mail/',
    oauth: 'zoho',
    alternative: false,
    headers: false,
    inline: false,
    fields: [
      ...oauthClient('Client ID', 'From a server-based application in Zoho’s API console.'),
      {
        name: 'region',
        label: 'Data center',
        type: 'select',
        default: 'com',
        options: [
          { value: 'com', label: 'United States (zoho.com)' },
          { value: 'eu', label: 'Europe (zoho.eu)' },
          { value: 'in', label: 'India (zoho.in)' },
          { value: 'com.au', label: 'Australia (zoho.com.au)' },
          { value: 'jp', label: 'Japan (zoho.jp)' },
          { value: 'ca', label: 'Canada (zohocloud.ca)' },
          { value: 'sa', label: 'Saudi Arabia (zoho.sa)' },
          { value: 'ae', label: 'United Arab Emirates (zoho.ae)' },
          { value: 'com.cn', label: 'China (zoho.com.cn)' },
        ],
      },
    ],
  },
  {
    id: 'elasticemail',
    label: 'Elastic Email',
    description: 'Low-cost email delivery.',
    url: 'https://elasticemail.com',
    alternative: true,
    headers: true,
    inline: false,
    fields: [apiKey('Settings › Manage API Keys in your Elastic Email account.')],
  },
]

const BY_ID: ReadonlyMap<string, MailerInfo> = new Map(MAILERS.map((mailer) => [mailer.id, mailer]))

/** A mailer by id, or `undefined` for an id no mailer has. */
export function mailerInfo(id: string): MailerInfo | undefined {
  return BY_ID.get(id)
}

/** Whether text is a mailer's id. */
export function isMailerId(id: unknown): id is MailerId {
  return typeof id === 'string' && BY_ID.has(id)
}
