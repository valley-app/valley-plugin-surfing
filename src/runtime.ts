import type { ValleyPluginApi } from '@valley/plugin-sdk'

/**
 * Module-global handles to the host's React instance and plugin API, set once in
 * `register(api)` before any view renders (same pattern as music/sideNotes).
 * Components import these instead of bundling their own `react`; JSX compiles to
 * `React.createElement` (classic transform), resolving to this binding.
 */
export let React!: typeof import('react')
export let api!: ValleyPluginApi

export function initRuntime(a: ValleyPluginApi): void {
  api = a
  React = a.React
}
