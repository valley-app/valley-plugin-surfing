import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { createFilters } from '../src/backend'
import { decodeBytes, encodeBytes, engineCacheDirectory, readManifest, sha256 } from '../src/backend/engineCache'
import { buildShards, type ShardedParts } from '../src/backend/filterShards'
import { createMockValleyApi } from './mock'

vi.mock('../src/backend/filterShards', async (load) => {
  const actual = await load<typeof import('../src/backend/filterShards')>()
  return { ...actual, buildShards: vi.fn(actual.buildShards) }
})

const rules = '||ads.example.test^\n@@||ads.example.test/allowed.js\nexample.test##.advert\n##.banner\nexample.test#@#.banner\n||example.test^$csp=script-src \'none\'\n||tracker.example.test^$badfilter\n||tracker.example.test^'
const newerRules = `${rules}\n||cdn.example.test/ads.js`
let resources = '{"scriptlets":[],"redirects":[]}'
const listUrl = 'https://filters.example.test/list.txt'
const config = { profiles: [{ partition: 'persist:profile', enabled: true, rules: listUrl, frequencyDays: 7 }] }
const key = `7\n${listUrl}`
const base = { partition: 'persist:profile', type: 'script', method: 'GET', sourceUrl: 'https://example.test' }
const requests = [
  { ...base, url: 'https://ads.example.test/track.js' },
  { ...base, url: 'https://ads.example.test/allowed.js' },
  { ...base, url: 'https://tracker.example.test/pixel.gif', type: 'image' },
  { ...base, url: 'https://cdn.example.test/ads.js' },
  { ...base, url: 'https://example.test/app.js' },
  { ...base, url: 'https://example.test', type: 'mainFrame' },
  { ...base, url: 'https://example.test', type: 'mainFrame', phase: 'response' as const }
]
const cosmetics = { partition: 'persist:profile', url: 'https://example.test', classes: ['advert', 'banner'], initial: true }
let mock: ReturnType<typeof createMockValleyApi>
let network: { fetch: ReturnType<typeof vi.fn> }
let api: PluginBackendApi
let served = rules
beforeEach(() => {
  served = rules
  mock = createMockValleyApi({ manifest: { id: 'renamed-browser' } })
  network = { fetch: vi.fn(async ({ url }: { url: string }) => ({ status: 200, headers: {}, bodyBase64: btoa(url.endsWith('resources.json') ? resources : served) })) }
  api = { data: mock.api.data, network, rpc: { handle: vi.fn(() => () => {}), emit: vi.fn() } } as unknown as PluginBackendApi
})
afterEach(() => { vi.restoreAllMocks(); vi.mocked(buildShards).mockClear() })

const answers = async (filters: ReturnType<typeof createFilters>) => ({
  requests: await Promise.all(requests.map((entry) => filters.request(entry))),
  cosmetics: await filters.cosmetics(cosmetics)
})
const warm = async () => {
  const filters = createFilters(api)
  await filters.configure(config)
  const result = await answers(filters)
  await filters.idle()
  return result
}
const directory = () => engineCacheDirectory(key)
const replace = async (name: string, content: string) => {
  const path = `${await directory()}/${name}`
  const current = await mock.api.data.files.readTextBaseline(path)
  expect((await mock.api.data.files.writeTextGuarded(path, content, current?.baseline ?? null)).ok).toBe(true)
}

describe('serialized filter engine cache', () => {
  it('round-trips bytes through the bounded base64 helpers', async () => {
    const bytes = Uint8Array.from({ length: 700_001 }, (_, index) => (index * 31) % 256)
    const pause = vi.fn(async () => {})
    const text = await encodeBytes(bytes, pause)
    expect(text).toBe(Buffer.from(bytes).toString('base64'))
    expect(await decodeBytes(text, pause)).toEqual(bytes)
    expect(pause).toHaveBeenCalled()
  })

  it('answers a new backend from the cache exactly as the cold-built engine did', async () => {
    const cold = await warm()
    expect(cold.requests.slice(0, 3)).toEqual([{ cancel: true }, { cancel: false }, { cancel: false }])
    const manifest = await readManifest(mock.api.data.files, await directory())
    expect(manifest?.files.map((file) => file.kind)).toContain('core')
    expect(manifest?.lists.map((list) => list.url).sort()).toEqual(expect.arrayContaining([listUrl]))
    const second = createFilters(api)
    await second.configure(config)
    expect(await answers(second)).toEqual(cold)
    expect(buildShards).toHaveBeenCalledTimes(1)
    await second.idle()
    expect(buildShards).toHaveBeenCalledTimes(1)
  })

  it('applies the redirect resources again when it loads the saved core', async () => {
    served = `${rules}\n||ads.example.test/noop.js$script,redirect=noop.js`
    resources = JSON.stringify({ scriptlets: [], redirects: [{ name: 'noop.js', aliases: [], contentType: 'application/javascript', body: '(function(){})();' }] })
    try {
      const redirected = { ...base, url: 'https://ads.example.test/noop.js' }
      const first = createFilters(api)
      await first.configure(config)
      const cold = await first.request(redirected)
      expect(cold.redirectURL).toMatch(/^data:application\/javascript/)
      await first.idle()
      const second = createFilters(api)
      await second.configure(config)
      expect(await second.request(redirected)).toEqual(cold)
      expect(buildShards).toHaveBeenCalledTimes(1)
    } finally { resources = '{"scriptlets":[],"redirects":[]}' }
  })

  it.each([
    ['a shard from another write', async () => replace('core.txt', 'other-generation\nAAAA')],
    ['a truncated shard', async () => { const manifest = await readManifest(mock.api.data.files, await directory()); await replace('core.txt', `${manifest!.generation}\nAAAA`) }],
    ['damaged shard bytes', async () => {
      const manifest = await readManifest(mock.api.data.files, await directory())
      const text = (await mock.api.data.files.readText(`${await directory()}/core.txt`))!.slice(manifest!.generation.length + 1)
      const bytes = Buffer.from(text, 'base64'); bytes[Math.floor(bytes.length / 2)] ^= 0xff
      await replace('core.txt', `${manifest!.generation}\n${bytes.toString('base64')}`)
    }],
    ['a missing shard', async () => { const manifest = await readManifest(mock.api.data.files, await directory()); await replace('manifest.json', JSON.stringify({ ...manifest, files: [...manifest!.files, { name: 'n-99.txt', kind: 'network', bytes: 4 }] })) }],
    ['another engine version', async () => { const manifest = await readManifest(mock.api.data.files, await directory()); await replace('manifest.json', JSON.stringify({ ...manifest, engineVersion: manifest!.engineVersion + 1 })) }],
    ['other shard limits', async () => { const manifest = await readManifest(mock.api.data.files, await directory()); await replace('manifest.json', JSON.stringify({ ...manifest, shardLimits: { ...manifest!.shardLimits, networkFilters: 10 } })) }],
    ['an unfinished write', async () => replace('manifest.json', JSON.stringify({ format: 0 }))]
  ])('builds from the lists again after %s', async (_, damage) => {
    const cold = await warm()
    await damage()
    const second = createFilters(api)
    await second.configure(config)
    expect(await answers(second)).toEqual(cold)
    expect(buildShards).toHaveBeenCalledTimes(2)
    await second.idle()
    expect(await readManifest(mock.api.data.files, await directory())).not.toBeNull()
  })

  it('answers a main-frame request without waiting for the engine, while subresources keep waiting', async () => {
    let complete!: (parts: ShardedParts | null) => void
    vi.mocked(buildShards).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const filters = createFilters(api)
    await filters.configure(config)
    expect(await filters.request(requests[5])).toEqual({})
    await vi.waitFor(() => expect(buildShards).toHaveBeenCalledTimes(1))
    let settled = false
    const blocked = filters.request(requests[0]).then((value) => { settled = true; return value })
    const response = filters.request(requests[6])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    const actual = await vi.importActual<typeof import('../src/backend/filterShards')>('../src/backend/filterShards')
    complete(await actual.buildShards([rules], { enableCompression: true }, resources))
    expect(await blocked).toEqual({ cancel: true })
    expect(await response).toEqual({ appendResponseHeaders: { 'Content-Security-Policy': ["script-src 'none'"] } })
  })

  it('keeps serving the cached engine while expired lists are rebuilt, then switches to the new engine', async () => {
    await warm()
    const later = Date.now() + 8 * 86400000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    served = newerRules
    const second = createFilters(api)
    await second.configure(config)
    expect(await second.request(requests[3])).toEqual({ cancel: false })
    expect(await second.request(requests[0])).toEqual({ cancel: true })
    await vi.waitFor(() => expect(buildShards).toHaveBeenCalledTimes(2))
    await second.idle()
    expect(await second.request(requests[3])).toEqual({ cancel: true })
    const manifest = await readManifest(mock.api.data.files, await directory())
    expect(manifest?.lists.some((list) => list.url === listUrl && list.at === later)).toBe(true)
  })

  it('rebuilds in the background when another configuration refreshed a shared list', async () => {
    await warm()
    const path = `filter-cache/${await sha256(listUrl)}.json`
    const current = await mock.api.data.files.readTextBaseline(path)
    await mock.api.data.files.writeTextGuarded(path, JSON.stringify({ at: Date.now() + 1000, bodyBase64: btoa(newerRules) }), current!.baseline)
    const second = createFilters(api)
    await second.configure(config)
    expect(await second.request(requests[3])).toEqual({ cancel: false })
    await second.idle()
    expect(buildShards).toHaveBeenCalledTimes(2)
    expect(await second.request(requests[3])).toEqual({ cancel: true })
  })

  it('does not write the cache after the service is disposed', async () => {
    const filters = createFilters(api)
    const dispose = filters.register()
    await filters.configure(config)
    await filters.request(requests[0])
    dispose()
    await filters.idle()
    expect(await readManifest(mock.api.data.files, await directory())).toBeNull()
  })
})
