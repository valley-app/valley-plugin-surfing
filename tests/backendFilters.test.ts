import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockBackendWasm, loadPackageWasm, type MockWasmModule } from '@valley/plugin-testkit'
import type { DatasetPage, PluginBackendApi } from '@valley/plugin-sdk'
import { createFilters } from '../src/backend'
import { ENGINE_FORMAT, KERNEL_ENGINES, engineCacheDirectory, readManifest } from '../src/backend/filterKernel'
import { partitionFor } from '../src/profiles'
import { createMockValleyApi } from './mock'

const rules = '||ads.example.test^\n@@||ads.example.test/allowed.js\nexample.test##.advert\n||example.test^$csp=script-src \'none\'\n||cdn.example.test/ad.gif$image,redirect=1x1.gif\nexample.test##+js(set-constant, adsEnabled, false)'
const bytes = (value: string): string => btoa(value)
const resources = JSON.stringify({
  scriptlets: [{ name: 'set-constant.js', aliases: [], body: 'function setConstant(a,b){window[a]=b}', dependencies: [] }],
  redirects: [{ name: '1x1.gif', aliases: [], body: 'R0lGODlhAQABAIAAAP///////yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', contentType: 'image/gif;base64' }]
})
const listFetches = (): number => network.fetch.mock.calls.filter(([{ url }]) => !url.endsWith('resources.json')).length
const builds = (): number => calls.filter((name) => name === 'filters_build').length
let module: MockWasmModule
let mock: ReturnType<typeof createMockValleyApi>
let network: { fetch: ReturnType<typeof vi.fn> }
let api: PluginBackendApi
let calls: string[]
let runBackground: ReturnType<typeof vi.fn>
let filters: ReturnType<typeof createFilters>
beforeAll(async () => { module = await loadPackageWasm(process.cwd(), 'filters') })
beforeEach(() => {
  mock = createMockValleyApi({ manifest: { id: 'renamed-browser' } })
  network = { fetch: vi.fn(async ({ url }: { url: string }) => ({ status: 200, headers: {}, bodyBase64: bytes(url.endsWith('resources.json') ? resources : rules) })) }
  calls = []
  runBackground = vi.fn((method: string, payload: unknown) => filters.buildOperation(payload, { api }))
  api = { data: mock.api.data, network, lifecycle: { runBackground }, rpc: { handle: vi.fn(() => () => {}), handleOperation: vi.fn(() => () => {}), emit: vi.fn() } } as unknown as PluginBackendApi
})
afterEach(() => { vi.restoreAllMocks() })
// Every backend generation gets its own module host, as in the app.
const create = () => {
  const wasm = createMockBackendWasm({ modules: [module] })
  api.wasm = { ...wasm, call: (handle, name, input, options) => { calls.push(name); return wasm.call(handle, name, input, options) } }
  return (filters = createFilters(api))
}
const config = { profiles: [{ partition: 'persist:profile', enabled: true, rules: 'https://filters.example.test/list.txt', frequencyDays: 7 }] }
const request = { partition: 'persist:profile', url: 'https://ads.example.test/track.js', type: 'script', method: 'GET', sourceUrl: 'https://example.test' }

describe('package-owned browser filter engine', () => {
  it('blocks rules, honors exceptions, redirects, preserves main-frame navigation and CSP', async () => {
    const filters = create()
    await filters.configure(config)
    expect(await filters.request(request)).toEqual({ cancel: true })
    expect(await filters.request({ ...request, url: 'https://ads.example.test/allowed.js' })).toEqual({ cancel: false })
    expect(await filters.request({ ...request, type: 'mainFrame' })).toEqual({})
    expect(await filters.request({ ...request, phase: 'response', type: 'mainFrame', url: 'https://example.test' })).toEqual({ appendResponseHeaders: { 'Content-Security-Policy': ["script-src 'none'"] } })
    expect((await filters.request({ ...request, url: 'https://cdn.example.test/ad.gif', type: 'image' })).redirectURL).toMatch(/^data:image\/gif;base64,R0lGOD/)
    expect(listFetches()).toBe(1)
    expect(runBackground).toHaveBeenCalledWith('filter.build', expect.anything())
  })

  it('keeps disabled profiles independent and returns cosmetic rules and scriptlets', async () => {
    const filters = create()
    await filters.configure({ profiles: [...config.profiles, { ...config.profiles[0], partition: 'private', enabled: false }] })
    expect(await filters.request({ ...request, partition: 'private' })).toEqual({})
    expect(await filters.cosmetics({ partition: 'private', url: 'https://example.test' })).toEqual({ styles: '', scripts: [] })
    expect(network.fetch).not.toHaveBeenCalled()
    const cosmetics = await filters.cosmetics({ partition: 'persist:profile', url: 'https://example.test', classes: ['advert'], initial: true })
    expect(cosmetics.styles).toContain('.advert { display: none !important; }')
    expect(cosmetics.scripts.join('\n')).toContain('setConstant("adsEnabled", "false")')
  })

  it('loads the saved engine after a new backend starts instead of parsing the lists', async () => {
    const first = create()
    await first.configure(config)
    await first.request(request)
    await first.idle()
    const manifest = await readManifest(mock.api.data.files, await engineCacheDirectory(`7\n${config.profiles[0].rules}`))
    expect(manifest?.format).toBe(ENGINE_FORMAT)
    const second = create()
    await second.configure(config)
    expect(await second.request(request)).toEqual({ cancel: true })
    expect((await second.request({ ...request, url: 'https://cdn.example.test/ad.gif', type: 'image' })).redirectURL).toMatch(/^data:image\/gif/)
    expect(listFetches()).toBe(1)
    expect(builds()).toBe(1)
    expect(await mock.api.data.files.list('filter-cache')).toHaveLength(2)
  })

  it('rebuilds from the lists when the saved engine is damaged', async () => {
    const first = create()
    await first.configure(config)
    await first.request(request)
    await first.idle()
    const directory = await engineCacheDirectory(`7\n${config.profiles[0].rules}`)
    const manifest = (await readManifest(mock.api.data.files, directory))!
    const current = await mock.api.data.files.readTextBaseline(`${directory}/e-0.txt`)
    await mock.api.data.files.writeTextGuarded(`${directory}/e-0.txt`, `${manifest.generation}\n${'A'.repeat(manifest.files[0].chars)}`, current!.baseline)
    const second = create()
    await second.configure(config)
    expect(await second.request(request)).toEqual({ cancel: true })
    expect(builds()).toBe(2)
  })

  it('validates package RPC payloads before opening a network connection', async () => {
    const filters = create()
    await expect(filters.configure({ ...config, extra: true })).rejects.toThrow()
    await expect(filters.request({ ...request, url: 'not a URL' })).rejects.toThrow()
    await expect(filters.buildOperation({ id: 'unknown' }, { api })).rejects.toThrow()
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it.each([999, 1000, 1001])('loads every stored profile across the %i boundary and shares startup reads', async (count) => {
    mock.datasets.set('renamed-browser.profile_adblock', Array.from({ length: count }, (_, index) => ({
      profileId: `profile-${index}`, adblockEnabled: false
    })))
    const dataset = mock.api.data.dataset
    const query = vi.fn((options) => dataset('profile_adblock').query(options))
    vi.spyOn(mock.api.data, 'dataset').mockImplementation(((name: string) => ({ ...dataset(name), query })) as typeof dataset)
    const filters = create()
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
    const filters = create()
    const pending = filters.request({ ...request, partition: partitionFor('profile') })
    await filters.configure({ profiles: [{ ...config.profiles[0], partition: partitionFor('profile'), enabled: false }] })
    complete({ rows: [{ profileId: 'profile', adblockEnabled: true }], revision: 1 })
    expect(await pending).toEqual({})
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it('bounds the engines held by the module and reloads evicted ones from the engine cache', async () => {
    const filters = create()
    const profiles = Array.from({ length: KERNEL_ENGINES + 3 }, (_, index) => ({
      ...config.profiles[0], partition: `profile-${index}`, rules: `https://filters.example.test/${index}.txt`
    }))
    await filters.configure({ profiles })
    for (const profile of profiles) expect(await filters.request({ ...request, partition: profile.partition })).toEqual({ cancel: true })
    expect(builds()).toBe(profiles.length)
    await filters.idle()
    expect(await mock.api.data.files.list('filter-engine')).toHaveLength(profiles.length)
    expect(calls.filter((name) => name === 'filters_drop')).toHaveLength(profiles.length - KERNEL_ENGINES)
    expect(await filters.request({ ...request, partition: profiles[0].partition })).toEqual({ cancel: true })
    expect(await filters.cosmetics({ partition: profiles[1].partition, url: 'https://example.test', classes: ['advert'] })).toMatchObject({ styles: expect.stringContaining('.advert') })
    await filters.configure({ profiles: [] })
    await filters.configure({ profiles: [profiles[0]] })
    expect(await filters.request({ ...request, partition: profiles[0].partition })).toEqual({ cancel: true })
    expect(builds()).toBe(profiles.length)
  })

  it.each(['disable', 'dispose'])('discards a pending engine after %s', async (action) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    runBackground.mockImplementationOnce(async (method: string, payload: unknown) => { await gate; return filters.buildOperation(payload, { api }) })
    const filters_ = create()
    const dispose = filters_.register()
    await filters_.configure(config)
    const pending = filters_.request(request)
    await vi.waitFor(() => expect(runBackground).toHaveBeenCalledTimes(1))
    if (action === 'disable') await filters_.configure({ profiles: [{ ...config.profiles[0], enabled: false }] })
    else dispose()
    release()
    expect(await pending).toEqual({})
    if (action === 'disable') dispose()
  })
})
