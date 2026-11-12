import { signedHeaders } from '../aws.ts'
import { base64, utf8 } from '../encoding.ts'
import { request, textField } from '../http.ts'
import { toMime } from '../mime.ts'
import type { CreateTransport } from '../types.ts'
import { hostPart, some } from './shared.ts'

/** Amazon SES's settings. */
export interface SesConfig {
  accessKeyId: string
  secretAccessKey: string
  /** Such as `eu-west-1`. */
  region: string
  configurationSet?: string
}

const MAILER = 'Amazon SES'

/**
 * Amazon SES's v2 SendEmail, with the email as a raw MIME message so every part of it arrives:
 * both bodies, headers, inline files. Recipients are named in the request, so `Bcc` never
 * appears in the message.
 */
export const create: CreateTransport<SesConfig> = (config, context) => {
  // Lowercase, as the signature's scope must be.
  const region = hostPart(config.region, 'The Amazon SES region', MAILER).toLowerCase()
  const url = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`
  return {
    async send(email, signal) {
      const body = JSON.stringify({
        FromEmailAddress: email.from.email,
        Destination: {
          ToAddresses: email.to.map((address) => address.email),
          CcAddresses: some(email.cc.map((address) => address.email)),
          BccAddresses: some(email.bcc.map((address) => address.email)),
        },
        Content: { Raw: { Data: base64(utf8(toMime(email))) } },
        ConfigurationSetName: config.configurationSet || undefined,
      })
      const response = await request({
        mailer: MAILER,
        url,
        headers: await signedHeaders({
          credentials: config,
          region,
          service: 'ses',
          url,
          body,
          now: new Date(),
        }),
        body,
        fetch: context.fetch,
        signal,
        explain: (answer) => textField(answer, 'message') ?? textField(answer, 'Message'),
        // Amazon answers some throttles with 400.
        classify: (_status, answer) =>
          /throttl|TooManyRequests/i.test(
            `${textField(answer, '__type')} ${textField(answer, 'message')}`,
          )
            ? 'rate-limited'
            : undefined,
      })
      return { id: textField(response.body, 'MessageId') ?? null }
    },
  }
}
