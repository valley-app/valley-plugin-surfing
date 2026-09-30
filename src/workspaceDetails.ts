import { WORKSPACE_DETAILS_V1, type ValleyPluginApi, type WorkspaceDetailItem, type WorkspaceDetailsContext, type WorkspaceDetailsSnapshot } from '@valley/plugin-sdk'
import type { WebStore, WebTabState } from './store'
import { uiText } from './localization'

type Runtime = { files: Map<string, WebTabState>; emit(): void }
const runtimes = new WeakMap<ValleyPluginApi, Runtime>()
export interface SurfingFileBookmarkState { path: string; search: string; page: number; selected: string | null }
const fileBookmarks = (api: ValleyPluginApi) => api.runtime.getOrCreate('surfing.fileBookmarks', () => ({ values: new Map<string, SurfingFileBookmarkState>(), listeners: new Set<() => void>() }))
export function readSurfingFileBookmark(api: ValleyPluginApi, path: string): SurfingFileBookmarkState {
  const runtime = fileBookmarks(api)
  if (!runtime.values.has(path)) runtime.values.set(path, { path, search: '', page: 0, selected: null })
  return runtime.values.get(path)!
}
export function updateSurfingFileBookmark(api: ValleyPluginApi, path: string, patch: Partial<SurfingFileBookmarkState>): void {
  const runtime = fileBookmarks(api)
  runtime.values.set(path, { ...readSurfingFileBookmark(api, path), ...patch, path })
  runtime.listeners.forEach(listener => listener())
}
export function subscribeSurfingFileBookmarks(api: ValleyPluginApi, listener: () => void): () => void {
  const runtime = fileBookmarks(api)
  runtime.listeners.add(listener)
  return () => { runtime.listeners.delete(listener) }
}
const fileKey = (context: Pick<WorkspaceDetailsContext, 'instanceId' | 'filePath'>) => JSON.stringify([context.instanceId, context.filePath])
export function publishSurfingFileDetails(api: ValleyPluginApi, context: Pick<WorkspaceDetailsContext, 'instanceId' | 'filePath'>, tab: WebTabState): () => void {
  const runtime = runtimes.get(api)
  if (!runtime) return () => {}
  const key = fileKey(context)
  runtime.files.set(key, tab)
  runtime.emit()
  return () => { if (runtime.files.get(key) === tab) { runtime.files.delete(key); runtime.emit() } }
}

export function registerSurfingDetails(api: ValleyPluginApi, store: WebStore): () => void {
  const listeners = new Set<() => void>()
  const runtime: Runtime = { files: new Map(), emit: () => listeners.forEach(listener => listener()) }
  runtimes.set(api, runtime)
  const offStore = store.subscribe(runtime.emit)
  const labels: [string, string, WorkspaceDetailItem['kind']][] = [
    ['hostname', 'Site', 'text'], ['connection', 'Connection', 'badge'], ['title', 'Page title', 'text'],
    ['url', 'URL', 'text'], ['siteName', 'Site name', 'text'], ['favicon', 'Favicon', 'thumbnail'],
    ['language', 'Language', 'text'], ['profile', 'Browser profile', 'text']
  ]
  const offProvider = api.interop.extensions.provide(WORKSPACE_DETAILS_V1, {
    id: 'surfing.details', label: 'Surfing', labelKey: 'manifest.name', pluginViews: true, fileExtensions: ['.url'],
    items: labels.map(([id, label, kind]) => ({ id, label, kind, labelKey: `details.${id}` })),
    defaultItems: ['hostname', 'connection'], subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot(context): WorkspaceDetailsSnapshot {
      if (!context) return { items: {} }
      const tab = context.filePath ? runtime.files.get(fileKey(context)) : store.getTab(context.instanceId ?? '__single')
      if (!tab) return { items: {} }
      const items: WorkspaceDetailsSnapshot['items'] = {}
      const add = (id: string, text: string | undefined): void => { if (text) items[id] = { text } }
      const url = tab.connection?.url || tab.url
      try { add('hostname', new URL(url).hostname) } catch { /* A blank tab has no site. */ }
      add('connection', uiText(`details.connection.${tab.connection?.status ?? 'unavailable'}`))
      add('url', url)
      add('title', tab.title)
      add('siteName', tab.metadata?.siteName)
      add('language', tab.metadata?.language)
      add('profile', store.getSnapshot().profiles.find(profile => profile.id === tab.profileId)?.name)
      if (tab.metadata?.icon && /^(https?:|data:image\/)/i.test(tab.metadata.icon)) items.favicon = { imageUrl: tab.metadata.icon, text: tab.metadata.siteName || tab.title }
      return { items }
    }
  })
  return () => { offProvider(); offStore(); listeners.clear(); runtime.files.clear(); if (runtimes.get(api) === runtime) runtimes.delete(api) }
}
