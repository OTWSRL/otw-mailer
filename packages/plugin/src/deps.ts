import type { PluginDefinition } from '@otwdesign/sdk'
import type { Env } from './secrets'

/** What the plugin reaches outside the CMS: the environment, and the network. */
export interface MailerDeps {
  /** Where secrets are read from. Defaults to the process's environment. */
  env: Env
  /** Defaults to the runtime's own. */
  fetch?: typeof fetch
}

// The admin entry is a module of its own, and gets the same dependencies as the plugin it belongs
// to: looked up by the definition, so a test's plugin and the site's never share them.
const registered = new WeakMap<PluginDefinition, MailerDeps>()

export function registerDeps(plugin: PluginDefinition, deps: MailerDeps): void {
  registered.set(plugin, deps)
}

export function depsOf(plugin: PluginDefinition): MailerDeps {
  return registered.get(plugin) ?? { env: process.env }
}
