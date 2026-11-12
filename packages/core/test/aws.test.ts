import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { signedHeaders } from '../src/aws.ts'

const credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
}
const now = new Date('2026-11-12T10:20:30.123Z')
const url = 'https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails'
const body = JSON.stringify({
  FromEmailAddress: 'ada@example.com',
  Content: { Raw: { Data: 'QQ==' } },
})

/**
 * The same request signed by Amazon's own signer (@smithy/signature-v4), as the oracle. It runs
 * in a Node process of its own: Vitest starts its workers with the `module` export condition,
 * under which that package resolves to a build Node can't load.
 */
function officialHeaders(): Record<string, string> {
  const script = `
    const { Sha256 } = require('@aws-crypto/sha256-js')
    const { SignatureV4 } = require('@smithy/signature-v4')
    const input = JSON.parse(process.argv[1])
    new SignatureV4({
      credentials: input.credentials,
      region: 'eu-west-1',
      service: 'ses',
      sha256: Sha256,
      applyChecksum: false,
    })
      .sign(
        {
          method: 'POST',
          protocol: 'https:',
          hostname: 'email.eu-west-1.amazonaws.com',
          path: '/v2/email/outbound-emails',
          headers: { host: 'email.eu-west-1.amazonaws.com', 'content-type': 'application/json' },
          body: input.body,
        },
        { signingDate: new Date(input.now) },
      )
      .then((request) => console.log(JSON.stringify(request.headers)))
  `
  const output = execFileSync(
    process.execPath,
    ['-e', script, JSON.stringify({ credentials, body, now: now.toISOString() })],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
  )
  return JSON.parse(output) as Record<string, string>
}

describe('signedHeaders', () => {
  it('signs as Amazon’s own signer does', async () => {
    const ours = await signedHeaders({
      credentials,
      region: 'eu-west-1',
      service: 'ses',
      url,
      body,
      now,
    })
    const official = officialHeaders()
    expect(ours['x-amz-date']).toBe('20261112T102030Z')
    expect(ours['x-amz-date']).toBe(official['x-amz-date'])
    expect(ours.authorization).toMatch(/Signature=[0-9a-f]{64}$/)
    expect(ours.authorization).toBe(official.authorization)
  })
})
