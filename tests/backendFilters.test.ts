import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FiltersEngine } from '@ghostery/adblocker'
import type { DatasetPage, PluginBackendApi } from '@valley/plugin-sdk'
import { createFilters } from '../src/backend'
import { buildShards, type ShardedParts } from '../src/backend/filterShards'
import { partitionFor } from '../src/profiles'
import { createMockValleyApi } from './mock'

vi.mock('../src/backend/filterShards', async (load) => {
  const actual = await load<typeof import('../src/backend/filterShards')>()
  return { ...actual, buildShards: vi.fn(actual.buildShards) }
})

const rules = '||ads.example.test^\n@@||ads.example.test/allowed.js\nexample.test##.advert\n||example.test^$csp=script-src \'none\''
const bytes = (value: string): string => btoa(value)
const resources = '{"scriptlets":[],"redirects":[]}'
const listFetches = (): number => network.fetch.mock.calls.filter(([{ url }]) => !url.endsWith('resources.json')).length
let mock: ReturnType<typeof createMockValleyApi>
let network: { fetch: ReturnType<typeof vi.fn> }
let api: PluginBackendApi
beforeEach(() => {
  mock = createMockValleyApi({ manifest: { id: 'renamed-browser' } })
  network = { fetch: vi.fn(async ({ url }: { url: string }) => ({ status: 200, headers: {}, bodyBase64: bytes(url.endsWith('resources.json') ? resources : rules) })) }
  api = { data: mock.api.data, network, rpc: { handle: vi.fn(() => () => {}), emit: vi.fn() } } as unknown as PluginBackendApi
})
afterEach(() => { vi.restoreAllMocks(); vi.mocked(buildShards).mockClear() })
const config = { profiles: [{ partition: 'persist:profile', enabled: true, rules: 'https://filters.example.test/list.txt', frequencyDays: 7 }] }
const request = { partition: 'persist:profile', url: 'https://ads.example.test/track.js', type: 'script', method: 'GET', sourceUrl: 'https://example.test' }

describe('package-owned browser filter engine', () => {
  it('blocks rules, honors exceptions, preserves main-frame navigation and CSP', async () => {
    const filters = createFilters(api)
    await filters.configure(config)
    expect(await filters.request(request)).toEqual({ cancel: true })
    expect(await filters.request({ ...request, url: 'https://ads.example.test/allowed.js' })).toEqual({ cancel: false })
    expect(await filters.request({ ...request, type: 'mainFrame' })).toEqual({})
    expect(await filters.request({ ...request, phase: 'response', type: 'mainFrame', url: 'https://example.test' })).toEqual({ appendResponseHeaders: { 'Content-Security-Policy': ["script-src 'none'"] } })
    expect(listFetches()).toBe(1)
  })

  it('keeps disabled profiles independent and returns cosmetic rules', async () => {
    const filters = createFilters(api)
    await filters.configure({ profiles: [...config.profiles, { ...config.profiles[0], partition: 'private', enabled: false }] })
    expect(await filters.request({ ...request, partition: 'private' })).toEqual({})
    expect(network.fetch).not.toHaveBeenCalled()
    const cosmetics = await filters.cosmetics({ partition: 'persist:profile', url: 'https://example.test', classes: ['advert'], initial: true })
    expect(cosmetics.styles).toContain('.advert')
  })

  it('reuses only owner-local cached lists after a new backend starts', async () => {
    const first = createFilters(api)
    await first.configure(config)
    await first.request(request)
    const second = createFilters(api)
    await second.configure(config)
    await second.request(request)
    expect(listFetches()).toBe(1)
    expect(await mock.api.data.files.list('filter-cache')).toHaveLength(2)
  })

  it('validates package RPC payloads before opening a network connection', async () => {
    const filters = createFilters(api)
    await expect(filters.configure({ ...config, extra: true })).rejects.toThrow()
    await expect(filters.request({ ...request, url: 'not a URL' })).rejects.toThrow()
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it.each([999, 1000, 1001])('loads every stored profile across the %i boundary and shares startup reads', async (count) => {
    mock.datasets.set('renamed-browser.profile_adblock', Array.from({ length: count }, (_, index) => ({
      profileId: `profile-${index}`, adblockEnabled: false
    })))
    const dataset = mock.api.data.dataset
    const query = vi.fn((options) => dataset('profile_adblock').query(options))
    vi.spyOn(mock.api.data, 'dataset').mockImplementation(((name: string) => ({ ...dataset(name), query })) as typeof dataset)
    const filters = createFilters(api)
    const selected = { ...request, partition: partitionFor(`profile-${count - 1}`) }
    expect(await Promise.all([filters.request(selected), filters.request(selected)])).toEqual([{}, {}])
    expect(query).toHaveBeenCalledTimes(Math.ceil(count / 1000))
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it('keeps newer explicit configuration when an earlier profile read completes', async () => {
    let complete!: (page: DatasetPage) => void
    const blocked = new Promise<DatasetPage>((resolve) => { complete = resolve })
    const dataset = mock.api.data.dataset
    vi.spyOn(mock.api.data, 'dataset').mockImplementation(((name: string) => ({ ...dataset(name), query: () => blocked })) as typeof dataset)
    const filters = createFilters(api)
    const pending = filters.request({ ...request, partition: partitionFor('profile') })
    await filters.configure({ profiles: [{ ...config.profiles[0], partition: partitionFor('profile'), enabled: false }] })
    complete({ rows: [{ profileId: 'profile', adblockEnabled: true }], revision: 1 })
    expect(await pending).toEqual({})
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it('retires superseded engine configurations, bounds retained engines and reloads evicted ones from the engine cache', async () => {
    const filters = createFilters(api)
    const profiles = Array.from({ length: 10 }, (_, index) => ({
      ...config.profiles[0], partition: `profile-${index}`, rules: `https://filters.example.test/${index}.txt`
    }))
    await filters.configure({ profiles })
    for (const profile of profiles) await filters.request({ ...request, partition: profile.partition })
    expect(buildShards).toHaveBeenCalledTimes(10)
    await filters.idle()
    expect(await mock.api.data.files.list('filter-engine')).toHaveLength(10)
    await filters.request({ ...request, partition: profiles[9].partition })
    expect(buildShards).toHaveBeenCalledTimes(10)
    expect(await filters.request({ ...request, partition: profiles[0].partition })).toEqual({ cancel: true })
    expect(buildShards).toHaveBeenCalledTimes(10)
    await filters.configure({ profiles: [] })
    await filters.configure({ profiles: [profiles[0]] })
    expect(await filters.request({ ...request, partition: profiles[0].partition })).toEqual({ cancel: true })
    expect(buildShards).toHaveBeenCalledTimes(10)
  })

  it.each(['disable', 'dispose'])('discards a pending engine after %s', async (action) => {
    let complete!: (parts: ShardedParts) => void
    vi.mocked(buildShards).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const filters = createFilters(api)
    const dispose = filters.register()
    await filters.configure(config)
    const pending = filters.request(request)
    await vi.waitFor(() => expect(buildShards).toHaveBeenCalledTimes(1))
    if (action === 'disable') await filters.configure({ profiles: [{ ...config.profiles[0], enabled: false }] })
    else dispose()
    complete({ core: FiltersEngine.parse(rules), network: [], cosmetic: [], badFilterIds: new Set() })
    expect(await pending).toEqual({})
    if (action === 'disable') dispose()
  })
})
