import { FiltersEngine, Request, type RequestType } from '@ghostery/adblocker'
import { z } from 'zod'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { DEFAULT_ADBLOCK_RULES, normalizeProfileAdblock, partitionFor } from '../profiles'
import { registerArchiveReader } from './archives'
import { registerFetch } from './fetch'

const profileSchema = z.object({ partition: z.string().max(256), enabled: z.boolean(), rules: z.string().max(64 * 1024), frequencyDays: z.number().int().min(0).max(3650) }).strict()
const requestSchema = z.object({ partition: z.string().max(256), phase: z.enum(['request', 'response']).optional(), url: z.string().url().max(8192), type: z.string().max(64), method: z.string().max(64), sourceUrl: z.string().max(8192) }).strict()
const cosmeticsSchema = z.object({ partition: z.string().max(256), url: z.string().url().max(8192), classes: z.array(z.string().max(128)).max(1000).optional(), ids: z.array(z.string().max(128)).max(1000).optional(), hrefs: z.array(z.string().max(2048)).max(1000).optional(), initial: z.boolean().optional() }).strict()
type Configuration = z.infer<typeof profileSchema>
const ENGINE_CACHE_LIMIT = 8
const configurationKey = (configuration: Configuration): string => `${configuration.frequencyDays}\n${configuration.rules}`
const decode = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
const digest = async (value: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')

export function createFilters(api: PluginBackendApi) {
  let configured = false
  let disposed = false
  let configurationRevision = 0
  let profileRead: Promise<void> | null = null
  const profiles = new Map<string, Configuration>()
  const engines = new Map<string, Promise<FiltersEngine>>()
  const off = new Set<() => void>()
  const readProfiles = (): Promise<void> => {
    if (configured || disposed) return Promise.resolve()
    if (profileRead) return profileRead
    const revision = configurationRevision
    const pending = (async () => {
      const next = new Map<string, Configuration>()
      let cursor: string | undefined
      do {
        const page = await api.data.dataset('profile_adblock').query({ limit: 1000, cursor })
        if (disposed || revision !== configurationRevision) return
        for (const row of page.rows) {
          const settings = normalizeProfileAdblock(row)
          if (typeof row.profileId === 'string') next.set(partitionFor(row.profileId), { partition: partitionFor(row.profileId), enabled: settings.adblockEnabled, rules: settings.adblockRules, frequencyDays: settings.adblockFrequency })
        }
        cursor = page.cursor
      } while (cursor)
      for (const [partition, settings] of next) profiles.set(partition, settings)
      configured = true
    })().catch((reason: unknown) => {
      if (!disposed && revision === configurationRevision) throw reason
    }).finally(() => { if (profileRead === pending) profileRead = null })
    profileRead = pending
    return pending
  }
  const fetchList = async (url: string, frequencyDays: number) => {
    const path = `filter-cache/${await digest(url)}.json`
    if (disposed) throw new DOMException('Filter service disposed', 'AbortError')
    const previous = await api.data.files.readTextBaseline(path)
    let cached: { at: number; bodyBase64: string } | undefined
    try { cached = z.object({ at: z.number(), bodyBase64: z.string() }).parse(JSON.parse(previous?.content ?? 'null')) } catch { /* Empty or outdated cache. */ }
    const materialize = (value: { bodyBase64: string }) => {
      const bytes = decode(value.bodyBase64)
      return { text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer as ArrayBuffer, json: async () => JSON.parse(new TextDecoder().decode(bytes)) }
    }
    if (cached && (!frequencyDays || Date.now() - cached.at < frequencyDays * 86400000)) return materialize(cached)
    try {
      if (disposed) throw new DOMException('Filter service disposed', 'AbortError')
      const result = await api.network.fetch({ url, timeoutMs: 30000 })
      if (result.status < 200 || result.status >= 300) throw new Error(api.i18n.t('surfing.backend.filterRequest', { status: result.status }))
      const record = { at: Date.now(), bodyBase64: result.bodyBase64 }
      if (!disposed) await api.data.files.writeTextGuarded(path, JSON.stringify(record), previous?.baseline ?? null)
      return materialize(record)
    } catch (error) { if (cached) return materialize(cached); throw error }
  }
  const configurationFor = (partition: string): Configuration => profiles.get(partition) ?? { partition, enabled: true, rules: DEFAULT_ADBLOCK_RULES, frequencyDays: 7 }
  const engine = async (partition: string): Promise<FiltersEngine | null> => {
    await readProfiles()
    while (!disposed) {
      const configuration = configurationFor(partition)
      if (!configuration.enabled) return null
      const key = configurationKey(configuration)
      let pending = engines.get(key)
      if (!pending) {
        const urls = configuration.rules.split('\n').map((line) => line.trim()).filter((line) => /^https?:\/\//i.test(line))
        const fetcher = (url: string) => fetchList(url, configuration.frequencyDays)
        pending = urls.length ? FiltersEngine.fromLists(fetcher, urls, { enableCompression: true }) : FiltersEngine.fromPrebuiltAdsAndTracking(fetcher)
      }
      engines.delete(key)
      engines.set(key, pending)
      while (engines.size > ENGINE_CACHE_LIMIT) engines.delete(engines.keys().next().value!)
      try {
        const result = await pending
        const current = configurationFor(partition)
        if (!disposed && current.enabled && configurationKey(current) === key) return result
      } catch (reason) {
        if (engines.get(key) === pending) engines.delete(key)
        const current = configurationFor(partition)
        if (!disposed && current.enabled && configurationKey(current) === key) throw reason
      }
    }
    return null
  }
  const configure = async (raw: unknown): Promise<void> => {
    const input = z.object({ profiles: z.array(profileSchema).max(1000) }).strict().parse(raw)
    if (disposed) return
    configurationRevision++
    profiles.clear()
    for (const entry of input.profiles) profiles.set(entry.partition, entry)
    configured = true
    const retained = new Set([...profiles.values()].filter((entry) => entry.enabled).map(configurationKey))
    retained.add(configurationKey({ partition: '', enabled: true, rules: DEFAULT_ADBLOCK_RULES, frequencyDays: 7 }))
    for (const key of engines.keys()) if (!retained.has(key)) engines.delete(key)
    api.rpc.emit('filter.changed', {})
  }
  const request = async (raw: unknown) => {
    const input = requestSchema.parse(raw)
    const blocker = await engine(input.partition)
    if (!blocker) return {}
    const request = Request.fromRawDetails({ url: input.url, sourceUrl: input.sourceUrl, type: input.type as RequestType })
    if (input.phase === 'response') {
      const csp = request.isMainFrame() || request.isSubFrame() ? blocker.getCSPDirectives(request) : undefined
      return csp ? { appendResponseHeaders: { 'Content-Security-Policy': [csp] } } : {}
    }
    if (request.isMainFrame()) return {}
    const { match, redirect, rewrite } = blocker.match(request)
    if (redirect) return { redirectURL: redirect.dataUrl }
    if (rewrite?.url) return { redirectURL: rewrite.url }
    return { cancel: match }
  }
  const cosmetics = async (raw: unknown) => {
    const input = cosmeticsSchema.parse(raw)
    const blocker = await engine(input.partition)
    if (!blocker) return { styles: '', scripts: [] }
    const request = Request.fromRawDetails({ url: input.url, sourceUrl: input.url, type: 'mainFrame' })
    const result = blocker.getCosmeticsFilters({ url: input.url, hostname: request.hostname, domain: request.domain, classes: input.classes, ids: input.ids, hrefs: input.hrefs, getBaseRules: input.initial !== false, getInjectionRules: input.initial !== false, getRulesFromDOM: true, getRulesFromHostname: true })
    return { styles: result.active ? result.styles : '', scripts: result.active ? result.scripts : [] }
  }
  return { configure, request, cosmetics, register() { off.add(api.rpc.handle('filter.configure', configure)); off.add(api.rpc.handle('filter.prepare', async (raw) => { const value = z.object({ partition: z.string().max(256) }).strict().parse(raw); await engine(value.partition) })); off.add(api.rpc.handle('filter.request', request)); off.add(api.rpc.handle('filter.cosmetics', cosmetics)); return () => { disposed = true; configurationRevision++; off.forEach((dispose) => dispose()); off.clear(); engines.clear(); profiles.clear() } } }
}
export function register(api: PluginBackendApi): () => void {
  const offFilters = createFilters(api).register()
  const offArchives = registerArchiveReader(api)
  const offFetch = registerFetch(api)
  return () => { offFetch(); offArchives(); offFilters() }
}
