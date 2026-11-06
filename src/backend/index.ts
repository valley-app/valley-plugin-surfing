import { createWorkflowAdapter } from './workflow'
import { z } from 'zod'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { DEFAULT_ADBLOCK_RULES, normalizeProfileAdblock, partitionFor } from '../profiles'
import { registerArchiveReader } from './archives'
import { registerFetch } from './fetch'
import { registerDataOwner } from './data'
import { registerProviderOwner } from './providers'
import { KERNEL_ENGINES, createFilterKernel, engineCacheDirectory, nextTurn, readEngine, writeEngine, type EngineManifest, type ListStamp } from './filterKernel'

const profileSchema = z.object({ partition: z.string().max(256), enabled: z.boolean(), rules: z.string().max(64 * 1024), frequencyDays: z.number().int().min(0).max(3650) }).strict()
const requestSchema = z.object({ partition: z.string().max(256), phase: z.enum(['request', 'response']).optional(), url: z.string().url().max(8192), type: z.string().max(64), method: z.string().max(64), sourceUrl: z.string().max(8192) }).strict()
const cosmeticsSchema = z.object({ partition: z.string().max(256), url: z.string().url().max(8192), classes: z.array(z.string().max(128)).max(1000).optional(), ids: z.array(z.string().max(128)).max(1000).optional(), hrefs: z.array(z.string().max(2048)).max(1000).optional(), initial: z.boolean().optional() }).strict()
type Configuration = z.infer<typeof profileSchema>
const configurationKey = (configuration: Configuration): string => `${configuration.frequencyDays}\n${configuration.rules}`
const DAY_MS = 86400000
const MIRROR = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets'
/** uBlock Origin's scriptlets and redirect resources, for `+js(…)` and `$redirect` rules. */
export const RESOURCES_URL = `${MIRROR}/ublock-origin/resources.json`
/** The lists a profile uses when its rules name no list URL. */
export const FALLBACK_LISTS = [
  'easylist/easylist.txt', 'peter-lowe/serverlist.txt', 'ublock-origin/badware.txt', 'ublock-origin/filters-2020.txt', 'ublock-origin/filters-2021.txt',
  'ublock-origin/filters-2022.txt', 'ublock-origin/filters-2023.txt', 'ublock-origin/filters-2024.txt', 'ublock-origin/filters.txt',
  'ublock-origin/quick-fixes.txt', 'ublock-origin/resource-abuse.txt', 'ublock-origin/unbreak.txt', 'easylist/easyprivacy.txt', 'ublock-origin/privacy.txt'
].map((path) => `${MIRROR}/${path}`)
const digest = async (value: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const missingSlot = (error: unknown): boolean => /no engine in slot/.test(String((error as Error)?.message))

export function createFilters(api: PluginBackendApi) {
  let configured = false
  let disposed = false
  let configurationRevision = 0
  let profileRead: Promise<void> | null = null
  const profiles = new Map<string, Configuration>()
  const kernel = createFilterKernel(api.wasm)
  // Engine slots in the kernel by configuration key, most recently used last.
  const engines = new Map<string, Promise<number>>()
  const builds = new Map<string, { slot: number; lists: string[] }>()
  const refreshing = new Set<string>()
  const background = new Set<Promise<unknown>>()
  const track = (work: Promise<unknown>): void => { const settled = work.catch(() => {}).finally(() => background.delete(settled)); background.add(settled) }
  const release = (pending: Promise<number> | undefined): void => { if (pending) track(pending.then((slot) => kernel.drop(slot))) }
  const retire = (key: string): void => { const pending = engines.get(key); engines.delete(key); release(pending) }
  const off = new Set<() => void>()
  off.add(kernel.onReset(() => engines.clear()))
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
  const download = async (url: string): Promise<string> => {
    for (let attempt = 0; ; attempt++) {
      if (disposed) throw new DOMException('Filter service disposed', 'AbortError')
      try {
        const result = await api.network.fetch({ url, timeoutMs: 30000 })
        if (result.status < 200 || result.status >= 300) throw new Error(api.i18n.t('surfing.backend.filterRequest', { status: result.status }))
        return result.bodyBase64
      } catch (error) {
        if (attempt >= 3) throw error
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }
  const fetchList = async (url: string, frequencyDays: number): Promise<{ at: number; bodyBase64: string }> => {
    const path = `filter-cache/${await digest(url)}.json`
    if (disposed) throw new DOMException('Filter service disposed', 'AbortError')
    const previous = await api.data.files.readTextBaseline(path)
    let cached: { at: number; bodyBase64: string } | undefined
    try { cached = z.object({ at: z.number(), bodyBase64: z.string() }).parse(JSON.parse(previous?.content ?? 'null')) } catch { /* Empty or outdated cache. */ }
    if (cached && (!frequencyDays || Date.now() - cached.at < frequencyDays * DAY_MS)) return cached
    try {
      const record = { at: Date.now(), bodyBase64: await download(url) }
      if (!disposed) await api.data.files.writeTextGuarded(path, JSON.stringify(record), previous?.baseline ?? null)
      return record
    } catch (error) { if (cached) return cached; throw error }
  }
  const configurationFor = (partition: string): Configuration => profiles.get(partition) ?? { partition, enabled: true, rules: DEFAULT_ADBLOCK_RULES, frequencyDays: 7 }
  const sourcesFor = (configuration: Configuration): string[] => {
    const urls = configuration.rules.split('\n').map((line) => line.trim()).filter((line) => /^https?:\/\//i.test(line))
    return urls.length ? urls : FALLBACK_LISTS
  }
  // Parsing and indexing need more than a guest turn's default WebAssembly call budget; the `filter.build` background
  // operation runs them with the longer one.
  const buildOperation = async (raw: unknown, context: { api: Pick<PluginBackendApi, 'wasm'> }): Promise<void> => {
    const { id } = z.object({ id: z.string().max(32) }).strict().parse(raw)
    const job = builds.get(id)
    if (!job || disposed) throw new DOMException('Filter build is no longer pending', 'AbortError')
    await kernel.build(job.slot, job.lists, context.api.wasm)
  }
  // Builds from the lists, then saves the engine in the background so the next backend start loads it.
  const coldBuild = async (configuration: Configuration, directory: string): Promise<number> => {
    const stamps: ListStamp[] = []
    const fetchStamped = async (url: string): Promise<string> => { const list = await fetchList(url, configuration.frequencyDays); stamps.push({ url, at: list.at }); return list.bodyBase64 }
    const [lists, resources] = await Promise.all([Promise.all(sourcesFor(configuration).map(fetchStamped)), fetchStamped(RESOURCES_URL)])
    if (disposed) throw new DOMException('Filter service disposed', 'AbortError')
    const slot = kernel.slot()
    const id = String(slot)
    builds.set(id, { slot, lists })
    try { await api.lifecycle.runBackground('filter.build', { id }) } finally { builds.delete(id) }
    await kernel.resources(slot, resources)
    if (!disposed) track(kernel.save(slot).then((pieces) => writeEngine(api.data.files, directory, pieces, stamps, () => disposed)).catch((error: unknown) => { if (!disposed) console.warn('Surfing could not save the filter engine', error) }))
    return slot
  }
  // A list's stored time, read from the start of its cache record ({"at":…,"bodyBase64":…}) without parsing the body.
  const listStamp = async (url: string): Promise<number | undefined> => {
    const text = await api.data.files.readText(`filter-cache/${await digest(url)}.json`)
    const match = /^\{"at":(\d+),/.exec(text?.slice(0, 40) ?? '')
    return match ? Number(match[1]) : undefined
  }
  const outdated = async (manifest: EngineManifest, frequencyDays: number): Promise<boolean> => {
    if (frequencyDays && manifest.lists.some((list) => Date.now() - list.at >= frequencyDays * DAY_MS)) return true
    for (const list of manifest.lists) {
      if (disposed) return false
      const at = await listStamp(list.url)
      if (at !== undefined && at !== list.at) return true
    }
    return false
  }
  // Keeps answering with the loaded engine; a rebuilt one replaces it only once it is complete.
  const refresh = (key: string, configuration: Configuration, directory: string, manifest: EngineManifest): void => {
    if (refreshing.has(key)) return
    refreshing.add(key)
    track((async () => {
      try {
        if (!await outdated(manifest, configuration.frequencyDays) || disposed) return
        const next = await coldBuild(configuration, directory)
        if (disposed || !engines.has(key)) { await kernel.drop(next); return }
        release(engines.get(key))
        engines.set(key, Promise.resolve(next))
      } finally { refreshing.delete(key) }
    })())
  }
  // The saved engine has no resources; without them only redirects fall back to blocking.
  const applyResources = async (slot: number, configuration: Configuration): Promise<void> => {
    let resources: string
    try { resources = (await fetchList(RESOURCES_URL, configuration.frequencyDays)).bodyBase64 } catch { return }
    await nextTurn()
    await kernel.resources(slot, resources)
  }
  const obtain = async (key: string, configuration: Configuration): Promise<number> => {
    const directory = await engineCacheDirectory(key)
    try {
      const cached = await readEngine(api.data.files, directory)
      if (cached) {
        const slot = kernel.slot()
        try {
          await kernel.load(slot, cached.pieces)
          await applyResources(slot, configuration)
        } catch (error) { void kernel.drop(slot).catch(() => {}); throw error }
        refresh(key, configuration, directory, cached.manifest)
        return slot
      }
    } catch { /* Damaged or incompatible cache: build from the lists. */ }
    if (disposed) throw new DOMException('Filter service disposed', 'AbortError')
    return coldBuild(configuration, directory)
  }
  const engine = async (partition: string): Promise<number | null> => {
    await readProfiles()
    while (!disposed) {
      const configuration = configurationFor(partition)
      if (!configuration.enabled) return null
      const key = configurationKey(configuration)
      let pending = engines.get(key)
      if (!pending) pending = obtain(key, configuration)
      engines.delete(key)
      engines.set(key, pending)
      while (engines.size > KERNEL_ENGINES) retire(engines.keys().next().value!)
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
  // An engine evicted or rebuilt between lookup and use answers "no engine in slot"; the lookup then runs once more.
  const withEngine = async <T>(partition: string, empty: T, run: (slot: number) => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const slot = await engine(partition)
      if (slot === null) return empty
      try { return await run(slot) } catch (error) { if (attempt || !missingSlot(error)) throw error }
    }
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
    for (const key of [...engines.keys()]) if (!retained.has(key)) retire(key)
    api.rpc.emit('filter.changed', {})
  }
  const request = async (raw: unknown) => {
    const input = requestSchema.parse(raw)
    // A main-frame request is never blocked, so it does not wait for the engine; it only starts loading it. Every other
    // request, and the main-frame response (CSP), still waits for the engine.
    if (input.phase !== 'response' && input.type === 'mainFrame') { void engine(input.partition).catch(() => {}); return {} }
    return withEngine(input.partition, {}, (slot) => kernel.request(slot, input))
  }
  const cosmetics = async (raw: unknown) => {
    const input = cosmeticsSchema.parse(raw)
    return withEngine(input.partition, { styles: '', scripts: [] as string[] }, (slot) => kernel.cosmetics(slot, input))
  }
  // Resolves once background cache writes and refreshes started so far have finished (tests and orderly shutdown).
  const idle = async (): Promise<void> => { while (background.size) await Promise.all([...background]) }
  return { configure, request, cosmetics, idle, buildOperation, register() { off.add(api.rpc.handle('filter.configure', configure)); off.add(api.rpc.handle('filter.prepare', async (raw) => { const value = z.object({ partition: z.string().max(256) }).strict().parse(raw); await engine(value.partition) })); off.add(api.rpc.handle('filter.request', request)); off.add(api.rpc.handle('filter.cosmetics', cosmetics)); off.add(api.rpc.handleOperation('filter.build', buildOperation)); return () => { disposed = true; configurationRevision++; off.forEach((dispose) => dispose()); off.clear(); engines.clear(); builds.clear(); profiles.clear() } } }
}
export function register(api: PluginBackendApi): () => void {
  const workflow = createWorkflowAdapter(api)
  const offFilters = createFilters(api).register()
  const offArchives = registerArchiveReader(api)
  const offFetch = registerFetch({ ...api, rpc: { ...api.rpc, handleOperation: workflow.operation } })
  const offData = registerDataOwner({ ...api, rpc: { ...api.rpc, handleOperation: workflow.operation } })
  const offProviders = registerProviderOwner({ ...api, rpc: { ...api.rpc, handleOperation: workflow.operation } })
  return () => { workflow.dispose(); offProviders(); offData(); offFetch(); offArchives(); offFilters() }
}
