import { hex, utf8 } from './encoding.ts'

/** What signs a request to Amazon Web Services. */
export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', imported, utf8(data) as Uint8Array<ArrayBuffer>),
  )
}

async function sha256(data: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(data) as Uint8Array<ArrayBuffer>)),
  )
}

/**
 * The headers that sign a JSON POST with AWS Signature Version 4, using the web's own crypto so it
 * runs anywhere `fetch` does. `url` must have no query string.
 */
export async function signedHeaders(input: {
  credentials: AwsCredentials
  region: string
  service: string
  url: string
  body: string
  now: Date
}): Promise<Record<string, string>> {
  const { credentials, region, service, body } = input
  const url = new URL(input.url)
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = amzDate.slice(0, 8)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: url.host,
    'x-amz-date': amzDate,
  }
  const names = Object.keys(headers).sort()
  const canonical = [
    'POST',
    url.pathname,
    '',
    ...names.map((name) => `${name}:${headers[name]}`),
    '',
    names.join(';'),
    await sha256(body),
  ].join('\n')
  const scope = `${date}/${region}/${service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonical)].join('\n')
  let key = await hmac(utf8(`AWS4${credentials.secretAccessKey}`), date)
  for (const part of [region, service, 'aws4_request']) key = await hmac(key, part)
  const signature = hex(await hmac(key, toSign))
  return {
    'content-type': headers['content-type']!,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  }
}
