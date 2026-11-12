/*
 * Checks a sending domain's DNS: the records mail services look at before they trust an email.
 * Node only (it asks the system's resolver), so it's an entry of its own.
 */

/** One record's verdict. */
export interface Finding {
  status: 'pass' | 'warn' | 'fail'
  /** The record found, when there is one. */
  record: string | null
  message: string
}

/** What a domain's DNS says about email sent from it. */
export interface DomainCheck {
  domain: string
  /** Which servers may send for the domain. */
  spf: Finding
  /** What receivers do with email that fails SPF and DKIM. */
  dmarc: Finding
  /** Whether the domain receives email, so replies and bounces arrive. */
  mx: Finding
  /** The signing key, when a selector was given. */
  dkim: Finding | null
}

/** What asks DNS: Node's resolver, or a stand-in for tests. */
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>
}

const DOMAIN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/
const SELECTOR = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/
const MISSING = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN'])

async function lookup<T>(query: () => Promise<T[]>): Promise<T[] | Error> {
  try {
    return await query()
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    return MISSING.has(code) ? [] : error instanceof Error ? error : new Error(String(error))
  }
}

const unreachable = (what: string, error: Error): Finding => ({
  status: 'warn',
  record: null,
  message: `Couldn't look up the ${what} record: ${error.message}`,
})

async function txt(resolver: DnsResolver, name: string, prefix: RegExp): Promise<string[] | Error> {
  const records = await lookup(() => resolver.resolveTxt(name))
  if (records instanceof Error) return records
  // A long record arrives in pieces, which join without a space.
  return records.map((pieces) => pieces.join('')).filter((record) => prefix.test(record))
}

async function spf(resolver: DnsResolver, domain: string): Promise<Finding> {
  const records = await txt(resolver, domain, /^v=spf1(\s|$)/i)
  if (records instanceof Error) return unreachable('SPF', records)
  if (records.length === 0) {
    return {
      status: 'fail',
      record: null,
      message:
        'No SPF record. Add the TXT record your mail service gives you, so receivers know it may send for this domain.',
    }
  }
  const record = records[0]!
  if (records.length > 1) {
    return {
      status: 'fail',
      record,
      message: 'More than one SPF record. Receivers reject that: merge them into one.',
    }
  }
  if (/\s\+?all\s*$/i.test(record)) {
    return {
      status: 'warn',
      record,
      message:
        'The SPF record ends in +all, which lets any server send for this domain. End it in ~all or -all.',
    }
  }
  return { status: 'pass', record, message: 'An SPF record is in place.' }
}

async function dmarc(resolver: DnsResolver, domain: string): Promise<Finding> {
  const records = await txt(resolver, `_dmarc.${domain}`, /^v=DMARC1(\s*;|$)/i)
  if (records instanceof Error) return unreachable('DMARC', records)
  const record = records[0]
  if (!record) {
    return {
      status: 'warn',
      record: null,
      message:
        'No DMARC record. Gmail and Yahoo ask for one from regular senders: add a TXT record at _dmarc with at least "v=DMARC1; p=none".',
    }
  }
  if (/;\s*p\s*=\s*none\b/i.test(record)) {
    return {
      status: 'pass',
      record,
      message:
        'A DMARC record is in place, with the policy "none": failures are reported, not blocked.',
    }
  }
  return { status: 'pass', record, message: 'A DMARC record is in place.' }
}

async function mx(resolver: DnsResolver, domain: string): Promise<Finding> {
  const records = await lookup(() => resolver.resolveMx(domain))
  if (records instanceof Error) return unreachable('MX', records)
  const hosts = records.filter((record) => record.exchange && record.exchange !== '.')
  if (hosts.length === 0) {
    return {
      status: 'warn',
      record: null,
      message: 'No MX record: this domain receives no email, so replies and bounces are lost.',
    }
  }
  const first = hosts.sort((a, b) => a.priority - b.priority)[0]!
  return { status: 'pass', record: first.exchange, message: 'The domain receives email.' }
}

async function dkim(resolver: DnsResolver, domain: string, selector: string): Promise<Finding> {
  const records = await txt(resolver, `${selector}._domainkey.${domain}`, /(^|;)\s*p=/i)
  if (records instanceof Error) return unreachable('DKIM', records)
  const record = records[0]
  if (!record) {
    return {
      status: 'fail',
      record: null,
      message: `No DKIM key at ${selector}._domainkey. Add the record your mail service gives you.`,
    }
  }
  if (/(^|;)\s*p=\s*(;|$)/i.test(record)) {
    return {
      status: 'fail',
      record,
      message: 'The DKIM key was revoked: its record has an empty key.',
    }
  }
  return { status: 'pass', record, message: 'A DKIM key is published.' }
}

/**
 * Looks up a domain's SPF, DMARC and MX records, and its DKIM key when the selector is known
 * (mail services name theirs). Never throws for a record that's missing or a resolver that's
 * down: each finding says what was found.
 */
export async function checkDomain(
  domain: string,
  options: { dkimSelector?: string; resolver?: DnsResolver } = {},
): Promise<DomainCheck> {
  const name = domain.trim().toLowerCase().replace(/\.$/, '')
  if (!DOMAIN.test(name)) throw new TypeError(`"${domain.slice(0, 80)}" isn't a domain name`)
  const selector = options.dkimSelector?.trim()
  if (selector && !SELECTOR.test(selector))
    throw new TypeError(`"${selector.slice(0, 80)}" isn't a DKIM selector`)
  const resolver = options.resolver ?? (await systemResolver())
  const [spfFinding, dmarcFinding, mxFinding, dkimFinding] = await Promise.all([
    spf(resolver, name),
    dmarc(resolver, name),
    mx(resolver, name),
    selector ? dkim(resolver, name, selector) : null,
  ])
  return { domain: name, spf: spfFinding, dmarc: dmarcFinding, mx: mxFinding, dkim: dkimFinding }
}

async function systemResolver(): Promise<DnsResolver> {
  const { Resolver } = await import('node:dns/promises')
  // A slow resolver shouldn't hold a page: each lookup gets a few seconds, tried twice.
  return new Resolver({ timeout: 3000, tries: 2 })
}
