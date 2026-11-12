import { describe, expect, it } from 'vitest'
import { checkDomain, type DnsResolver } from '../src/dns.ts'

function resolver(
  txt: Record<string, string[][]>,
  mx: { exchange: string; priority: number }[] = [],
): DnsResolver {
  const missing = () =>
    Promise.reject(Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' }))
  return {
    resolveTxt: (name) => (txt[name] ? Promise.resolve(txt[name]) : missing()),
    resolveMx: () => (mx.length > 0 ? Promise.resolve(mx) : missing()),
  }
}

describe('checkDomain', () => {
  it('passes a domain with SPF, DMARC, DKIM and MX records', async () => {
    const check = await checkDomain(' Example.COM. ', {
      dkimSelector: 's1',
      resolver: resolver(
        {
          'example.com': [
            ['google-site-verification=abc'],
            ['v=spf1 include:_spf.example.net ', '~all'],
          ],
          '_dmarc.example.com': [['v=DMARC1; p=quarantine; rua=mailto:d@example.com']],
          's1._domainkey.example.com': [['v=DKIM1; k=rsa; p=MIGfMA0', 'GCSqGSIb3']],
        },
        [
          { exchange: 'mx2.example.com', priority: 20 },
          { exchange: 'mx1.example.com', priority: 10 },
        ],
      ),
    })
    expect(check).toEqual({
      domain: 'example.com',
      spf: {
        status: 'pass',
        record: 'v=spf1 include:_spf.example.net ~all',
        message: 'An SPF record is in place.',
      },
      dmarc: {
        status: 'pass',
        record: 'v=DMARC1; p=quarantine; rua=mailto:d@example.com',
        message: 'A DMARC record is in place.',
      },
      mx: { status: 'pass', record: 'mx1.example.com', message: 'The domain receives email.' },
      dkim: {
        status: 'pass',
        record: 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3',
        message: 'A DKIM key is published.',
      },
    })
  })

  it('says what is missing', async () => {
    const check = await checkDomain('example.com', { dkimSelector: 's1', resolver: resolver({}) })
    expect([check.spf.status, check.dmarc.status, check.mx.status, check.dkim?.status]).toEqual([
      'fail',
      'warn',
      'warn',
      'fail',
    ])
    expect(check.spf.message).toMatch(/^No SPF record/)
    expect(check.dkim?.message).toContain('s1._domainkey')
    expect((await checkDomain('example.com', { resolver: resolver({}) })).dkim).toBeNull()
  })

  it('catches SPF records receivers reject or that allow anyone', async () => {
    const two = await checkDomain('example.com', {
      resolver: resolver({ 'example.com': [['v=spf1 a -all'], ['v=spf1 mx -all']] }),
    })
    expect(two.spf).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('More than one'),
    })
    const open = await checkDomain('example.com', {
      resolver: resolver({ 'example.com': [['v=spf1 +all']] }),
    })
    expect(open.spf.status).toBe('warn')
    const revoked = await checkDomain('example.com', {
      dkimSelector: 's1',
      resolver: resolver({ 's1._domainkey.example.com': [['v=DKIM1; p=']] }),
    })
    expect(revoked.dkim).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('revoked'),
    })
  })

  it('reports a resolver that is down as unknown, not as missing', async () => {
    const down: DnsResolver = {
      resolveTxt: () =>
        Promise.reject(Object.assign(new Error('queryTxt ETIMEOUT'), { code: 'ETIMEOUT' })),
      resolveMx: () =>
        Promise.reject(Object.assign(new Error('queryMx ESERVFAIL'), { code: 'ESERVFAIL' })),
    }
    const check = await checkDomain('example.com', { resolver: down })
    expect(check.spf).toEqual({
      status: 'warn',
      record: null,
      message: "Couldn't look up the SPF record: queryTxt ETIMEOUT",
    })
    expect(check.mx.status).toBe('warn')
  })

  it('refuses what isn’t a domain or a selector', async () => {
    for (const bad of ['', 'localhost', 'exa mple.com', 'example.com/x', '-a.com', 'a..com']) {
      await expect(checkDomain(bad, { resolver: resolver({}) })).rejects.toThrow(
        /isn't a domain name/,
      )
    }
    await expect(
      checkDomain('example.com', { dkimSelector: 'a b', resolver: resolver({}) }),
    ).rejects.toThrow(/isn't a DKIM selector/)
  })
})
