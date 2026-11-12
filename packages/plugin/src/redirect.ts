import type { PluginContext } from '@otwdesign/sdk'

/**
 * Where a mail service sends a person back after they connect an account: the address to
 * register with the service. Built from Settings › General › Site address when it's set.
 */
export function redirectUri(cms: PluginContext, request?: Request): string {
  const origin = cms.settings.get('site.url') || (request ? new URL(request.url).origin : '')
  return `${origin.replace(/\/+$/, '')}${cms.routes.apiUrl('/oauth/callback')}`
}
