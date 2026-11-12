import type { Message } from '../src/index.ts'

/** One call a fake `fetch` received, with its body read: JSON parsed, forms as entries. */
export interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

type Answer = Response | ((call: Call) => Response)

/**
 * A `fetch` that records what it's sent and answers from a list, in order (the last answer
 * repeats). Mailers get it through `createMailer({ fetch })`, so no test touches the network.
 */
export function fakeFetch(...answers: Answer[]) {
  const calls: Call[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input as string, init)
    const type = request.headers.get('content-type') ?? ''
    let body: unknown
    if (type.includes('multipart/form-data')) {
      const form = await request.formData()
      body = await Promise.all(
        [...form.entries()].map(async ([name, value]) =>
          typeof value === 'string'
            ? [name, value]
            : [name, { name: value.name, type: value.type, text: await value.text() }],
        ),
      )
    } else {
      const text = await request.text()
      body = type.includes('json') ? JSON.parse(text) : text
    }
    const call = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body,
    }
    calls.push(call)
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]
    if (!answer) return new Response(null, { status: 204 })
    return typeof answer === 'function' ? answer(call) : answer.clone()
  }
  return { fetch: fetcher, calls }
}

export const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init)

/** An email that uses everything a mailer can carry. */
export const FULL: Message = {
  from: 'Ada Admin <ada@example.com>',
  to: ['Bo Reader <bo@example.com>', 'cy@example.com'],
  cc: 'Di <di@example.com>',
  bcc: 'eve@example.com',
  replyTo: 'Help Desk <help@example.com>',
  subject: 'Your order №7 is ready',
  text: 'Thanks for your order.',
  html: '<p>Thanks for your <b>order</b>. <img src="cid:logo"></p>',
  headers: { 'X-Campaign': 'welcome' },
  attachments: [
    { filename: 'report.pdf', content: new Uint8Array([37, 80, 68, 70]) },
    { filename: 'logo.png', content: new Uint8Array([1, 2, 3]), cid: 'logo' },
  ],
}

/** The base64 of FULL's two files. */
export const PDF = 'JVBERg=='
export const PNG = 'AQID'
