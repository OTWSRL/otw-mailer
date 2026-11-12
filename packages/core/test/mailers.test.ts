import { describe, expect, it } from 'vitest'
import { createMailer, MAILERS, MailerError, type MailerId } from '../src/index.ts'
import { fakeFetch, FULL, json, PDF, PNG, type Call } from './helpers.ts'

/** Sends FULL through one connection with a fake fetch, and returns what was called. */
async function send(
  mailer: MailerId,
  config: Record<string, unknown>,
  ...answers: Parameters<typeof fakeFetch>
) {
  const { fetch, calls } = fakeFetch(...answers)
  const delivery = await createMailer({
    connections: [{ id: 'main', mailer, config }],
    fetch,
  }).send(FULL)
  const call = calls.at(-1)!
  return { delivery, calls, call, body: call.body as Body }
}

/** A request's JSON body, read loosely: each test compares it whole. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>

const BO = { email: 'bo@example.com', name: 'Bo Reader' }
const CY = { email: 'cy@example.com' }
const DI = { email: 'di@example.com', name: 'Di' }
const EVE = { email: 'eve@example.com' }
const TEXT = 'Thanks for your order.'
const HTML = '<p>Thanks for your <b>order</b>. <img src="cid:logo"></p>'

describe('each mailer sends the email the way its service documents', () => {
  it('SendGrid', async () => {
    const { delivery, call, body } = await send(
      'sendgrid',
      { apiKey: 'SG.k', region: 'eu' },
      new Response(null, { status: 202, headers: { 'x-message-id': 'sg-1' } }),
    )
    expect(call.url).toBe('https://api.eu.sendgrid.com/v3/mail/send')
    expect(call.headers.authorization).toBe('Bearer SG.k')
    expect(body).toEqual({
      personalizations: [{ to: [BO, CY], cc: [DI], bcc: [EVE] }],
      from: { email: 'ada@example.com', name: 'Ada Admin' },
      reply_to_list: [{ email: 'help@example.com', name: 'Help Desk' }],
      subject: FULL.subject,
      content: [
        { type: 'text/plain', value: TEXT },
        { type: 'text/html', value: HTML },
      ],
      attachments: [
        {
          content: PDF,
          filename: 'report.pdf',
          type: 'application/pdf',
          disposition: 'attachment',
        },
        {
          content: PNG,
          filename: 'logo.png',
          type: 'image/png',
          disposition: 'inline',
          content_id: 'logo',
        },
      ],
      headers: { 'X-Campaign': 'welcome' },
    })
    expect(delivery).toMatchObject({ connection: 'main', mailer: 'sendgrid', providerId: 'sg-1' })
  })

  it('Mailgun', async () => {
    const { delivery, call } = await send(
      'mailgun',
      { apiKey: 'key-1', domain: 'mg.example.com', region: 'eu' },
      json({ id: '<m1@mg.example.com>', message: 'Queued. Thank you.' }),
    )
    expect(call.url).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages')
    expect(call.headers.authorization).toBe(`Basic ${btoa('api:key-1')}`)
    expect(call.body).toEqual([
      ['from', '"Ada Admin" <ada@example.com>'],
      ['to', '"Bo Reader" <bo@example.com>'],
      ['to', 'cy@example.com'],
      ['cc', '"Di" <di@example.com>'],
      ['bcc', 'eve@example.com'],
      ['subject', FULL.subject],
      ['text', TEXT],
      ['html', HTML],
      ['h:Reply-To', '"Help Desk" <help@example.com>'],
      ['h:X-Campaign', 'welcome'],
      ['attachment', { name: 'report.pdf', type: 'application/pdf', text: '%PDF' }],
      ['inline', { name: 'logo', type: 'image/png', text: '\u0001\u0002\u0003' }],
    ])
    expect(delivery.providerId).toBe('<m1@mg.example.com>')
  })

  it('Postmark', async () => {
    const { delivery, call, body } = await send(
      'postmark',
      { apiKey: 'pm-token' },
      json({ MessageID: 'pm-1', ErrorCode: 0, Message: 'OK' }),
    )
    expect(call.url).toBe('https://api.postmarkapp.com/email')
    expect(call.headers['x-postmark-server-token']).toBe('pm-token')
    expect(body).toEqual({
      From: '"Ada Admin" <ada@example.com>',
      To: '"Bo Reader" <bo@example.com>, cy@example.com',
      Cc: '"Di" <di@example.com>',
      Bcc: 'eve@example.com',
      ReplyTo: '"Help Desk" <help@example.com>',
      Subject: FULL.subject,
      TextBody: TEXT,
      HtmlBody: HTML,
      MessageStream: 'outbound',
      Headers: [{ Name: 'X-Campaign', Value: 'welcome' }],
      Attachments: [
        { Name: 'report.pdf', Content: PDF, ContentType: 'application/pdf' },
        { Name: 'logo.png', Content: PNG, ContentType: 'image/png', ContentID: 'cid:logo' },
      ],
    })
    expect(delivery.providerId).toBe('pm-1')
  })

  it('Brevo', async () => {
    const { delivery, call, body } = await send(
      'brevo',
      { apiKey: 'xkeysib-1' },
      json({ messageId: '<b1@smtp-relay>' }, { status: 201 }),
    )
    expect(call.url).toBe('https://api.brevo.com/v3/smtp/email')
    expect(call.headers['api-key']).toBe('xkeysib-1')
    expect(body).toEqual({
      sender: { email: 'ada@example.com', name: 'Ada Admin' },
      to: [BO, CY],
      cc: [DI],
      bcc: [EVE],
      replyTo: { email: 'help@example.com', name: 'Help Desk' },
      subject: FULL.subject,
      textContent: TEXT,
      htmlContent: HTML,
      headers: { 'X-Campaign': 'welcome' },
      attachment: [
        { name: 'report.pdf', content: PDF },
        { name: 'logo.png', content: PNG },
      ],
    })
    expect(delivery.providerId).toBe('<b1@smtp-relay>')
  })

  it('Resend', async () => {
    const { delivery, call, body } = await send('resend', { apiKey: 're_1' }, json({ id: 're-1' }))
    expect(call.url).toBe('https://api.resend.com/emails')
    expect(call.headers.authorization).toBe('Bearer re_1')
    expect(body).toEqual({
      from: '"Ada Admin" <ada@example.com>',
      to: ['bo@example.com', 'cy@example.com'],
      cc: ['di@example.com'],
      bcc: ['eve@example.com'],
      reply_to: ['help@example.com'],
      subject: FULL.subject,
      text: TEXT,
      html: HTML,
      headers: { 'X-Campaign': 'welcome' },
      attachments: [
        { filename: 'report.pdf', content: PDF, content_type: 'application/pdf' },
        { filename: 'logo.png', content: PNG, content_type: 'image/png', content_id: 'logo' },
      ],
    })
    expect(delivery.providerId).toBe('re-1')
  })

  it('SparkPost', async () => {
    const { delivery, call, body } = await send(
      'sparkpost',
      { apiKey: 'sp-1' },
      json({ results: { total_accepted_recipients: 4, id: 'sp-9' } }),
    )
    expect(call.url).toBe('https://api.sparkpost.com/api/v1/transmissions')
    expect(call.headers.authorization).toBe('sp-1')
    // Every copy shows the same To line: the addresses of those the email is to.
    const shown = 'bo@example.com, cy@example.com'
    expect(body.recipients).toEqual([
      { address: { email: 'bo@example.com', header_to: shown } },
      { address: { email: 'cy@example.com', header_to: shown } },
      { address: { email: 'di@example.com', header_to: shown } },
      { address: { email: 'eve@example.com', header_to: shown } },
    ])
    expect(body.content).toEqual({
      from: { email: 'ada@example.com', name: 'Ada Admin' },
      subject: FULL.subject,
      text: TEXT,
      html: HTML,
      reply_to: '"Help Desk" <help@example.com>',
      headers: { 'X-Campaign': 'welcome', CC: '"Di" <di@example.com>' },
      attachments: [{ name: 'report.pdf', type: 'application/pdf', data: PDF }],
      inline_images: [{ name: 'logo', type: 'image/png', data: PNG }],
    })
    expect(delivery.providerId).toBe('sp-9')
  })

  it('SparkPost: one recipient keeps their name, and braces never run as a template', async () => {
    const { fetch, calls } = fakeFetch(json({ results: { id: 'sp-1' } }))
    await createMailer({
      connections: [{ id: 'main', mailer: 'sparkpost', config: { apiKey: 'k' } }],
      fetch,
    }).send({
      from: 'a@example.com',
      to: 'Bo Reader <bo@example.com>',
      subject: 'Use {{name}} here',
      text: 'Write {{{ raw }}} and }} alone',
    })
    const body = calls[0]!.body as Body
    expect(body.recipients).toEqual([{ address: { email: 'bo@example.com', name: 'Bo Reader' } }])
    expect(body.content.subject).toBe(
      'Use {{opening_double_curly()}}name{{closing_double_curly()}} here',
    )
    expect(body.content.text).toBe(
      'Write {{opening_double_curly()}}{ raw {{closing_double_curly()}}} and {{closing_double_curly()}} alone',
    )
  })

  it('Mailjet', async () => {
    const { delivery, call, body } = await send(
      'mailjet',
      { apiKey: 'pub', secretKey: 'sec' },
      json({
        Messages: [
          {
            Status: 'success',
            To: [{ Email: 'bo@example.com', MessageUUID: 'u-77', MessageID: 77 }],
          },
        ],
      }),
    )
    expect(call.url).toBe('https://api.mailjet.com/v3.1/send')
    expect(call.headers.authorization).toBe(`Basic ${btoa('pub:sec')}`)
    expect(body).toEqual({
      Messages: [
        {
          From: { Email: 'ada@example.com', Name: 'Ada Admin' },
          To: [{ Email: 'bo@example.com', Name: 'Bo Reader' }, { Email: 'cy@example.com' }],
          Cc: [{ Email: 'di@example.com', Name: 'Di' }],
          Bcc: [{ Email: 'eve@example.com' }],
          ReplyTo: { Email: 'help@example.com', Name: 'Help Desk' },
          Subject: FULL.subject,
          TextPart: TEXT,
          HTMLPart: HTML,
          Headers: { 'X-Campaign': 'welcome' },
          Attachments: [
            { ContentType: 'application/pdf', Filename: 'report.pdf', Base64Content: PDF },
          ],
          InlinedAttachments: [
            {
              ContentType: 'image/png',
              Filename: 'logo.png',
              ContentID: 'logo',
              Base64Content: PNG,
            },
          ],
        },
      ],
    })
    expect(delivery.providerId).toBe('u-77')
  })

  it('MailerSend, which takes headers only when the plan does', async () => {
    const answer = new Response(null, { status: 202, headers: { 'x-message-id': 'ms-1' } })
    const { delivery, call, body } = await send('mailersend', { apiKey: 'mlsn.1' }, answer)
    expect(call.url).toBe('https://api.mailersend.com/v1/email')
    expect(call.headers.authorization).toBe('Bearer mlsn.1')
    expect(body).toEqual({
      from: { email: 'ada@example.com', name: 'Ada Admin' },
      to: [BO, CY],
      cc: [DI],
      bcc: [EVE],
      reply_to: { email: 'help@example.com', name: 'Help Desk' },
      subject: FULL.subject,
      text: TEXT,
      html: HTML,
      attachments: [
        { content: PDF, filename: 'report.pdf', disposition: 'attachment' },
        { content: PNG, filename: 'logo.png', disposition: 'inline', id: 'logo' },
      ],
    })
    expect(delivery.providerId).toBe('ms-1')
    const paid = await send('mailersend', { apiKey: 'mlsn.1', customHeaders: 'true' }, answer)
    expect(paid.body.headers).toEqual([{ name: 'X-Campaign', value: 'welcome' }])
  })

  it('Mandrill', async () => {
    const { delivery, call, body } = await send(
      'mandrill',
      { apiKey: 'md-1' },
      json([{ email: 'bo@example.com', status: 'sent', _id: 'md-9' }]),
    )
    expect(call.url).toBe('https://mandrillapp.com/api/1.4/messages/send')
    expect(body).toEqual({
      key: 'md-1',
      message: {
        from_email: 'ada@example.com',
        from_name: 'Ada Admin',
        to: [
          { email: 'bo@example.com', name: 'Bo Reader', type: 'to' },
          { email: 'cy@example.com', type: 'to' },
          { email: 'di@example.com', name: 'Di', type: 'cc' },
          { email: 'eve@example.com', type: 'bcc' },
        ],
        subject: FULL.subject,
        text: TEXT,
        html: HTML,
        headers: { 'X-Campaign': 'welcome', 'Reply-To': '"Help Desk" <help@example.com>' },
        attachments: [{ type: 'application/pdf', name: 'report.pdf', content: PDF }],
        images: [{ type: 'image/png', name: 'logo', content: PNG }],
      },
    })
    expect(delivery.providerId).toBe('md-9')
  })

  it('SMTP2GO', async () => {
    const { delivery, call, body } = await send(
      'smtp2go',
      { apiKey: 'api-1' },
      json({ request_id: 'r', data: { succeeded: 4, failed: 0, email_id: 's2g-1' } }),
    )
    expect(call.url).toBe('https://api.smtp2go.com/v3/email/send')
    expect(call.headers['x-smtp2go-api-key']).toBe('api-1')
    expect(body).toEqual({
      sender: '"Ada Admin" <ada@example.com>',
      to: ['"Bo Reader" <bo@example.com>', 'cy@example.com'],
      cc: ['"Di" <di@example.com>'],
      bcc: ['eve@example.com'],
      subject: FULL.subject,
      text_body: TEXT,
      html_body: HTML,
      custom_headers: [
        { header: 'X-Campaign', value: 'welcome' },
        { header: 'Reply-To', value: '"Help Desk" <help@example.com>' },
      ],
      attachments: [{ filename: 'report.pdf', fileblob: PDF, mimetype: 'application/pdf' }],
      inlines: [{ filename: 'logo', fileblob: PNG, mimetype: 'image/png' }],
    })
    expect(delivery.providerId).toBe('s2g-1')
  })

  it('Elastic Email', async () => {
    const { delivery, call, body } = await send(
      'elasticemail',
      { apiKey: 'ee-1' },
      json({ TransactionID: 't-1', MessageID: 'ee-9' }),
    )
    expect(call.url).toBe('https://api.elasticemail.com/v4/emails/transactional')
    expect(call.headers['x-elasticemail-apikey']).toBe('ee-1')
    expect(body).toEqual({
      Recipients: {
        To: ['"Bo Reader" <bo@example.com>', 'cy@example.com'],
        CC: ['"Di" <di@example.com>'],
        BCC: ['eve@example.com'],
      },
      Content: {
        From: '"Ada Admin" <ada@example.com>',
        ReplyTo: '"Help Desk" <help@example.com>',
        Subject: FULL.subject,
        Body: [
          { ContentType: 'HTML', Content: HTML, Charset: 'utf-8' },
          { ContentType: 'PlainText', Content: TEXT, Charset: 'utf-8' },
        ],
        Headers: { 'X-Campaign': 'welcome' },
        Attachments: [
          { BinaryContent: PDF, Name: 'report.pdf', ContentType: 'application/pdf' },
          { BinaryContent: PNG, Name: 'logo.png', ContentType: 'image/png' },
        ],
      },
    })
    expect(delivery.providerId).toBe('ee-9')
  })

  it('SendLayer', async () => {
    const { delivery, call, body } = await send(
      'sendlayer',
      { apiKey: 'sl-1' },
      json({ MessageID: 'sl-9' }),
    )
    expect(call.url).toBe('https://console.sendlayer.com/api/v1/email')
    expect(call.headers.authorization).toBe('Bearer sl-1')
    expect(body).toEqual({
      From: { name: 'Ada Admin', email: 'ada@example.com' },
      To: [{ name: 'Bo Reader', email: 'bo@example.com' }, { email: 'cy@example.com' }],
      CC: [{ name: 'Di', email: 'di@example.com' }],
      BCC: [{ email: 'eve@example.com' }],
      ReplyTo: [{ name: 'Help Desk', email: 'help@example.com' }],
      Subject: FULL.subject,
      ContentType: 'HTML',
      PlainContent: TEXT,
      HTMLContent: HTML,
      Headers: { 'X-Campaign': 'welcome' },
      Attachments: [
        {
          Content: PDF,
          Type: 'application/pdf',
          Filename: 'report.pdf',
          Disposition: 'attachment',
        },
        { Content: PNG, Type: 'image/png', Filename: 'logo.png', Disposition: 'attachment' },
      ],
    })
    expect(delivery.providerId).toBe('sl-9')
  })

  it('SMTP.com', async () => {
    const { delivery, call, body } = await send(
      'smtpcom',
      { apiKey: 'sc-1', channel: 'site' },
      json({ status: 'success', data: { msg_id: 'abc123' } }),
    )
    expect(call.url).toBe('https://api.smtp.com/v4/messages')
    expect(call.headers.authorization).toBe('Bearer sc-1')
    expect(body).toEqual({
      channel: 'site',
      originator: {
        from: { name: 'Ada Admin', address: 'ada@example.com' },
        reply_to: { name: 'Help Desk', address: 'help@example.com' },
      },
      recipients: {
        to: [{ name: 'Bo Reader', address: 'bo@example.com' }, { address: 'cy@example.com' }],
        cc: [{ name: 'Di', address: 'di@example.com' }],
        bcc: [{ address: 'eve@example.com' }],
      },
      subject: FULL.subject,
      body: {
        parts: [
          { type: 'text/plain', charset: 'UTF-8', content: TEXT },
          { type: 'text/html', charset: 'UTF-8', content: HTML },
        ],
        attachments: [
          {
            content: PDF,
            type: 'application/pdf',
            filename: 'report.pdf',
            disposition: 'attachment',
          },
          {
            content: PNG,
            type: 'image/png',
            filename: 'logo.png',
            disposition: 'inline',
            cid: 'logo',
          },
        ],
      },
      custom_headers: { 'X-Campaign': 'welcome' },
    })
    expect(delivery.providerId).toBe('abc123')
  })

  it('Amazon SES, signed, with the email as a MIME message', async () => {
    const { delivery, call, body } = await send(
      'ses',
      {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'secret',
        region: 'eu-west-1',
        configurationSet: 'site',
      },
      json({ MessageId: 'ses-1' }),
    )
    expect(call.url).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails')
    expect(call.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    )
    expect(call.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
    expect(body).toMatchObject({
      FromEmailAddress: 'ada@example.com',
      Destination: {
        ToAddresses: ['bo@example.com', 'cy@example.com'],
        CcAddresses: ['di@example.com'],
        BccAddresses: ['eve@example.com'],
      },
      ConfigurationSetName: 'site',
    })
    const mime = atob(body.Content.Raw.Data)
    expect(mime).toContain('From: Ada Admin <ada@example.com>')
    expect(mime).not.toMatch(/^Bcc:/m)
    expect(delivery.providerId).toBe('ses-1')
  })

  it('Gmail, with a fresh access token and the MIME message as the upload', async () => {
    const { delivery, calls } = await send(
      'gmail',
      { clientId: 'id', clientSecret: 'shh', refreshToken: 'rt' },
      json({ access_token: 'at-1', expires_in: 3600 }),
      json({ id: 'gm-1', threadId: 't' }),
    )
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token')
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body as string))).toEqual({
      client_id: 'id',
      client_secret: 'shh',
      grant_type: 'refresh_token',
      refresh_token: 'rt',
    })
    expect(calls[1]!.url).toBe(
      'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media',
    )
    expect(calls[1]!.headers).toMatchObject({
      authorization: 'Bearer at-1',
      'content-type': 'message/rfc822',
    })
    expect(calls[1]!.body).toMatch(/^Bcc: eve@example\.com\r$/m)
    expect(delivery.providerId).toBe('gm-1')
  })

  it('Microsoft 365, through Graph, as base64 MIME', async () => {
    const { delivery, calls } = await send(
      'outlook',
      {
        clientId: 'id',
        clientSecret: 'shh',
        refreshToken: 'rt',
        tenant: 'contoso.onmicrosoft.com',
      },
      json({ access_token: 'at-1', refresh_token: 'rt-2', expires_in: 3600 }),
      new Response(null, { status: 202 }),
    )
    expect(calls[0]!.url).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token',
    )
    expect(calls[1]!.url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
    expect(calls[1]!.headers).toMatchObject({
      authorization: 'Bearer at-1',
      'content-type': 'text/plain',
    })
    expect(atob(calls[1]!.body as string)).toContain('Subject: =?UTF-8?B?')
    expect(delivery.providerId).toBeNull()
  })

  it('Zoho Mail: finds the account, uploads the files, then sends the HTML', async () => {
    const stored = (name: string) =>
      json({ data: { storeName: 's', attachmentPath: `/p/${name}`, attachmentName: name } })
    const { delivery, calls } = await send(
      'zoho',
      { clientId: 'id', clientSecret: 'shh', refreshToken: 'rt', region: 'eu' },
      json({ access_token: 'at-1', expires_in: 3600 }),
      json({ data: [{ accountId: '42' }] }),
      stored('report.pdf'),
      stored('logo.png'),
      json({ data: { messageId: 'z-1' } }),
    )
    expect(calls.map((call: Call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://accounts.zoho.eu/oauth/v2/token',
      'GET https://mail.zoho.eu/api/accounts',
      'POST https://mail.zoho.eu/api/accounts/42/messages/attachments?fileName=report.pdf',
      'POST https://mail.zoho.eu/api/accounts/42/messages/attachments?fileName=logo.png',
      'POST https://mail.zoho.eu/api/accounts/42/messages',
    ])
    expect(calls[1]!.headers.authorization).toBe('Zoho-oauthtoken at-1')
    expect(calls[4]!.body).toEqual({
      fromAddress: 'ada@example.com',
      toAddress: 'bo@example.com,cy@example.com',
      ccAddress: 'di@example.com',
      bccAddress: 'eve@example.com',
      subject: FULL.subject,
      content: HTML,
      mailFormat: 'html',
      encoding: 'UTF-8',
      askReceipt: 'no',
      attachments: [
        { storeName: 's', attachmentPath: '/p/report.pdf', attachmentName: 'report.pdf' },
        { storeName: 's', attachmentPath: '/p/logo.png', attachmentName: 'logo.png' },
      ],
    })
    expect(delivery.providerId).toBe('z-1')
  })
})

describe('what services answer', () => {
  const failing = async (
    mailer: MailerId,
    config: Record<string, unknown>,
    answer: Response,
  ): Promise<MailerError> => {
    const { fetch } = fakeFetch(answer)
    const mailerOf = createMailer({ connections: [{ id: 'main', mailer, config }], fetch })
    return mailerOf.send(FULL).then(
      () => {
        throw new Error('expected the send to fail')
      },
      (error: MailerError) => error,
    )
  }

  it('says why in the service’s own words, and never repeats the key', async () => {
    const error = await failing(
      'sendgrid',
      { apiKey: 'SG.secret-key' },
      json(
        { errors: [{ message: 'The from address does not match a verified Sender Identity.' }] },
        { status: 403 },
      ),
    )
    expect(error).toBeInstanceOf(MailerError)
    expect(error.code).toBe('auth')
    expect(error.status).toBe(403)
    expect(error.retryable).toBe(false)
    expect(error.message).toBe(
      'SendGrid refused the email (HTTP 403): The from address does not match a verified Sender Identity.',
    )
    expect(JSON.stringify(error)).not.toContain('secret-key')
  })

  it('takes the key out of an answer that repeats it', async () => {
    const error = await failing(
      'resend',
      { apiKey: 're_live_12345' },
      json({ message: 'API key re_live_12345 is invalid (re_live_12345)' }, { status: 401 }),
    )
    expect(error.message).toBe(
      'Resend refused the email (HTTP 401): API key [secret] is invalid ([secret])',
    )
    expect(error).toMatchObject({ code: 'auth', status: 401 })
  })

  it('tells problems that may pass from those that won’t', async () => {
    const cases: [number, string, boolean][] = [
      [400, 'rejected', false],
      [401, 'auth', false],
      [422, 'rejected', false],
      [420, 'rate-limited', true],
      [429, 'rate-limited', true],
      [500, 'unavailable', true],
      [503, 'unavailable', true],
    ]
    for (const [status, code, retryable] of cases) {
      const error = await failing('resend', { apiKey: 'k' }, json({ message: 'no' }, { status }))
      expect([status, error.code, error.retryable]).toEqual([status, code, retryable])
    }
  })

  it('says who is calling, reads Amazon’s 400 throttle as one, and stops an email too big for Graph', async () => {
    const { fetch, calls } = fakeFetch(json({ id: 'r' }))
    await createMailer({
      connections: [{ id: 'main', mailer: 'resend', config: { apiKey: 'k' } }],
      fetch,
    }).send(FULL)
    expect(calls[0]!.headers['user-agent']).toBe('otw-mailer')

    const throttled = await failing(
      'ses',
      { accessKeyId: 'a', secretAccessKey: 'b', region: 'EU-WEST-1' },
      json({ __type: 'ThrottlingException', message: 'Rate exceeded' }, { status: 400 }),
    )
    expect(throttled).toMatchObject({ code: 'rate-limited', retryable: true })

    const big = fakeFetch(json({ access_token: 'at', expires_in: 3600 }))
    const error = await createMailer({
      connections: [
        {
          id: 'main',
          mailer: 'outlook',
          config: { clientId: 'i', clientSecret: 's', refreshToken: 'r' },
        },
      ],
      fetch: big.fetch,
    })
      .send({ ...FULL, attachments: [{ filename: 'big.bin', content: new Uint8Array(3_200_000) }] })
      .catch((caught: MailerError) => caught)
    expect(error).toMatchObject({ code: 'rejected' })
    expect((error as MailerError).message).toMatch(/up to about 3 MB/)
    expect(big.calls.map((call) => call.url)).not.toContain(
      'https://graph.microsoft.com/v1.0/me/sendMail',
    )
  })

  it('keeps a page of HTML out of the error', async () => {
    const error = await failing(
      'postmark',
      { apiKey: 'k' },
      new Response(`<html>${'x'.repeat(5000)}</html>`, { status: 502 }),
    )
    expect(error.message.length).toBeLessThan(400)
  })

  it('reports MailerSend accepting an email it won’t send', async () => {
    const error = await failing(
      'mailersend',
      { apiKey: 'k' },
      json(
        {
          message: 'There are some warnings for your request.',
          warnings: [{ type: 'ALL_SUPPRESSED' }],
        },
        { status: 202 },
      ),
    )
    expect(error).toMatchObject({
      code: 'rejected',
      message: "MailerSend didn't send the email: ALL_SUPPRESSED.",
    })
  })

  it('reports a service that answers 200 but refused everyone', async () => {
    const mandrill = await failing(
      'mandrill',
      { apiKey: 'k' },
      json([{ email: 'bo@example.com', status: 'rejected', reject_reason: 'unsigned' }]),
    )
    expect(mandrill).toMatchObject({
      code: 'rejected',
      message: 'Mandrill refused the email: unsigned.',
    })
    const mailjet = await failing(
      'mailjet',
      { apiKey: 'a', secretKey: 'b' },
      json({ Messages: [{ Status: 'error', Errors: [{ ErrorMessage: 'Sender not allowed' }] }] }),
    )
    expect(mailjet.message).toBe('Mailjet refused the email: Sender not allowed')
    const smtp2go = await failing(
      'smtp2go',
      { apiKey: 'k' },
      json({ data: { succeeded: 0, failed: 1, failures: ['bad address'] } }),
    )
    expect(smtp2go.code).toBe('rejected')
  })

  it('reports a network failure and a timeout as worth another try', async () => {
    const down = createMailer({
      connections: [{ id: 'main', mailer: 'resend', config: { apiKey: 'k' } }],
      fetch: async () => {
        const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
          code: 'ECONNREFUSED',
        })
        throw new TypeError('fetch failed', { cause: refused })
      },
    })
    await expect(down.send(FULL)).rejects.toMatchObject({
      code: 'network',
      retryable: true,
      message: "Couldn't reach Resend: fetch failed: connect ECONNREFUSED 127.0.0.1:443",
    })

    const slow = createMailer({
      connections: [{ id: 'main', mailer: 'resend', config: { apiKey: 'k' } }],
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))
        }),
    })
    await expect(slow.send(FULL)).rejects.toMatchObject({
      code: 'timeout',
      message: "Resend didn't answer in time.",
    })
  })
})

describe('settings', () => {
  it('names the setting that’s missing, before anything is sent', async () => {
    const { fetch, calls } = fakeFetch(json({}))
    const send = (mailer: MailerId, config: Record<string, unknown>) =>
      createMailer({ connections: [{ id: 'main', mailer, config }], fetch }).send(FULL)
    await expect(send('sendgrid', {})).rejects.toMatchObject({
      code: 'not-configured',
      message: "SendGrid isn't set up: it needs its api key.",
    })
    await expect(send('mailgun', { apiKey: 'k' })).rejects.toThrow(/needs its domain name/)
    await expect(send('mailgun', { apiKey: 'k', domain: 'evil.test/x?' })).rejects.toThrow(
      /The Mailgun domain isn't valid/,
    )
    await expect(
      send('ses', { accessKeyId: 'a', secretAccessKey: 'b', region: 'x.evil.test/' }),
    ).rejects.toThrow(/region isn't valid/)
    await expect(
      send('zoho', { clientId: 'a', clientSecret: 'b', region: 'evil.test' }),
    ).rejects.toThrow(/isn't one of its choices/)
    await expect(send('resend', { apiKey: 'k\r\nX-Injected: 1' })).rejects.toThrow(
      /one line of text/,
    )
    expect(calls).toEqual([])
  })

  it('describes every mailer for a settings form', () => {
    expect(MAILERS.map((mailer) => mailer.id)).toHaveLength(18)
    for (const mailer of MAILERS) {
      expect(mailer.label && mailer.description && mailer.url.startsWith('https://')).toBeTruthy()
      for (const item of mailer.fields) {
        if (item.type === 'select') expect(item.options?.length).toBeGreaterThan(0)
        // A key or a password is never a plain field.
        if (/secret|password|token/i.test(item.name) || item.name === 'apiKey') {
          expect([mailer.id, item.name, item.type]).toEqual([
            mailer.id,
            item.name,
            mailer.id === 'mailjet' && item.name === 'apiKey' ? 'text' : 'secret',
          ])
        }
      }
    }
  })
})
