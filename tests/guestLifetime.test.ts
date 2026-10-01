import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from './mock'
import { createStore, type WebStore } from '../src/store'
import { INCOGNITO_PROFILE_ID } from '../src/profiles'
import { initRuntime } from '../src/runtime'

const TAB = 'web-lifetime'
const OLD_GUEST = 'bf52c51e-0a38-4e22-91d1-6b763ef41d31'
const NEW_GUEST = 'bf52c51e-0a38-4e22-91d1-6b763ef41d32'
const URL = 'https://original.example.test/article'
const stores: WebStore[] = []
const releases: Array<() => void> = []

function held<T>(fallback: T) {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  releases.push(() => resolve(fallback))
  return { promise, resolve }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function fixture() {
  const mock = createMockValleyApi()
  let playing = true
  const execute = vi.spyOn(mock.api.drivers.browser, 'execute').mockImplementation(async (_guest, script) => {
    if (!script.includes('video,audio')) return { ok: true, data: {} }
    if (script.includes('"type":"pause"')) playing = false
    if (script.includes('"type":"play"')) playing = true
    return { ok: true, data: { title: 'Canopy', source: 'canopy.mp4',
      state: { status: playing ? 'playing' : 'paused', positionSeconds: 0, durationSeconds: 60, volume: 1, muted: false, rate: 1 },
      capabilities: { seek: true, rate: true, next: false, previous: false } } }
  })
  const close = vi.spyOn(mock.api.drivers.browser, 'close').mockResolvedValue({ ok: true })
  const navigate = vi.spyOn(mock.api.drivers.browser, 'navigate').mockResolvedValue({ ok: true, data: { info: 'Navigated' } })
  const store = createStore(mock.api)
  stores.push(store)
  store.restoreTab(TAB, { url: URL, title: 'Original', profileId: 'default' })
  const ready = (guestId = OLD_GUEST, audible = false) => {
    const binding = store.bindGuest(TAB)
    binding.onReady({ type: 'ready', guestId, url: URL, audible })
    return binding
  }
  const replace = () => {
    store.restoreTab(TAB, { url: URL, title: 'Replacement', profileId: INCOGNITO_PROFILE_ID })
    return ready(NEW_GUEST)
  }
  return { ...mock, store, execute, close, navigate, ready, replace }
}

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(stores.splice(0).map(store => store.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('browser guest ownership', () => {
  it('rejects a retained ready binding after profile A→B→A and accepts a fresh binding', async () => {
    const { store, ready, navigate, close } = fixture()
    const original = ready()
    const originalTarget = original.target
    store.restoreTab(TAB, { url: URL, title: 'Private', profileId: INCOGNITO_PROFILE_ID })
    store.restoreTab(TAB, { url: URL, title: 'Returned', profileId: 'default' })

    expect(store.guestTarget(TAB)).not.toBe(originalTarget)
    original.onReady({ type: 'ready', guestId: OLD_GUEST, url: 'https://stale.example.test', title: 'Stale' })
    expect(store.getTab(TAB)).toMatchObject({ url: URL, title: 'Returned', profileId: 'default' })
    expect((await store.browserNavigate(TAB, 'https://ignored.example.test')).ok).toBe(false)
    expect(navigate).not.toHaveBeenCalled()

    ready(NEW_GUEST)
    await store.browserNavigate(TAB, 'https://current.example.test')
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith(NEW_GUEST, 'https://current.example.test')
    await settle()
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(OLD_GUEST)
  })

  it('revokes a prepared binding before its held preparation completes', async () => {
    const { api, store, execute } = fixture()
    const preparation = held<unknown>(undefined)
    vi.mocked(api.backend.call).mockImplementation(async (method) => {
      if (method === 'filter.prepare') return preparation.promise as never
      return { styles: '', scripts: [] } as never
    })
    const binding = store.bindGuest(TAB)
    const preparing = binding.prepare()
    binding.dispose()
    preparation.resolve(undefined)
    await preparing
    binding.onReady({ type: 'ready', guestId: OLD_GUEST, url: URL })

    expect(api.backend.call).toHaveBeenCalledTimes(1)

    expect(api.backend.call).toHaveBeenCalledWith('filter.prepare', { partition: 'persist:web-default' })
    expect(execute).not.toHaveBeenCalled()
    expect((await store.browserNavigate(TAB, URL)).ok).toBe(false)
  })

  it('keeps retained playback controls attached to their original guest lifetime', async () => {
    const { store, execute, ready, replace, mediaPlayers } = fixture()
    ready(OLD_GUEST, true)
    store.guestEvent(TAB, { type: 'media', guestId: OLD_GUEST, playing: true, audible: true })
    await settle()
    const original = mediaPlayers[0]
    expect(await original.getSnapshot()).toMatchObject({ descriptor: { sourceId: `web:${TAB}` }, state: { status: 'playing' } })
    await original.toggle()
    expect(execute.mock.calls.some(([guestId, script]) => guestId === OLD_GUEST && script.includes('video,audio'))).toBe(true)
    replace()
    store.guestEvent(TAB, { type: 'media', guestId: NEW_GUEST, playing: true, audible: true })
    await settle()
    const replacement = mediaPlayers[1]
    execute.mockClear()
    await expect(original.toggle()).rejects.toThrow('disposed')
    await expect(original.setVolume(0.2)).rejects.toThrow('disposed')
    expect(execute).not.toHaveBeenCalled()
    await replacement.toggle()
    expect(execute.mock.calls[0][0]).toBe(NEW_GUEST)
  })

  it('silences output before waiting for pending guest work during disposal', async () => {
    const { api, store, ready, close } = fixture()
    ready(OLD_GUEST, true)
    store.guestEvent(TAB, { type: 'media', guestId: OLD_GUEST, playing: true, audible: true })
    await settle()
    await store.dispose()
    expect(api.drivers.browser.setAudioMuted).toHaveBeenCalledWith(OLD_GUEST, true)
    expect(close).toHaveBeenCalledWith(OLD_GUEST)
  })

  it('cancels periodic state sampling after the owner closes', async () => {
    vi.useFakeTimers()
    const { store, execute, ready } = fixture()
    ready(OLD_GUEST, true)
    store.guestEvent(TAB, { type: 'media', guestId: OLD_GUEST, playing: true, audible: true })
    await settle()
    await store.dispose()
    execute.mockClear()
    await vi.advanceTimersByTimeAsync(3100)
    expect(execute).not.toHaveBeenCalled()
  })

  it('ignores selection and metadata results from a replaced guest with the same URL', async () => {
    const { store, execute, ready, replace } = fixture()
    const metadata = held({ ok: true as const, data: { description: 'Old metadata' } })
    const selection = held({ ok: true as const, data: 'Old selected text' })
    execute.mockImplementation(async (guestId, script) => {
      if (guestId === OLD_GUEST && script.includes('og:description')) return metadata.promise
      if (guestId === OLD_GUEST && script.includes('getSelection')) return selection.promise
      return { ok: true, data: script.includes('og:description') ? { description: 'Current metadata' } : {} }
    })
    ready()
    const selecting = store.getSelectionText(TAB)
    replace()
    await settle()
    expect(store.getTab(TAB)?.metadata).toEqual({ description: 'Current metadata' })

    metadata.resolve({ ok: true, data: { description: 'Old metadata' } })
    selection.resolve({ ok: true, data: 'Old selected text' })
    expect(await selecting).toBe('')
    await settle()
    expect(store.getTab(TAB)?.metadata).toEqual({ description: 'Current metadata' })
  })

  it('does not resurrect old page reads after navigation A→B→A within one guest', async () => {
    const { store, execute, ready } = fixture()
    const metadata = held({ ok: true as const, data: { description: 'Obsolete document' } })
    const selection = held({ ok: true as const, data: 'Obsolete selection' })
    execute.mockImplementation(async (_guestId, script) => {
      if (script.includes('og:description')) return metadata.promise
      if (script.includes('getSelection')) return selection.promise
      return { ok: true, data: {} }
    })
    ready()
    const selecting = store.getSelectionText(TAB)
    store.guestEvent(TAB, { type: 'navigate', guestId: OLD_GUEST, url: 'https://other.example.test' })
    store.guestEvent(TAB, { type: 'navigate', guestId: OLD_GUEST, url: URL })
    metadata.resolve({ ok: true, data: { description: 'Obsolete document' } })
    selection.resolve({ ok: true, data: 'Obsolete selection' })

    expect(await selecting).toBe('')
    await settle()
    expect(store.getTab(TAB)?.metadata).toBeUndefined()
  })

  it('invalidates old document reads when the same guest becomes ready at the same URL again', async () => {
    const { store, execute, ready } = fixture()
    const metadata = held({ ok: true as const, data: { description: 'Previous document' } })
    const selection = held({ ok: true as const, data: 'Previous selection' })
    let metadataReads = 0
    execute.mockImplementation(async (_guestId, script) => {
      if (script.includes('og:description')) {
        if (++metadataReads === 1) return metadata.promise
        return { ok: true, data: { description: 'Reloaded document' } }
      }
      if (script.includes('getSelection')) return selection.promise
      return { ok: true, data: {} }
    })
    ready()
    const selecting = store.getSelectionText(TAB)
    store.guestEvent(TAB, { type: 'ready', guestId: OLD_GUEST, url: URL })
    await settle()
    expect(store.getTab(TAB)?.metadata).toEqual({ description: 'Reloaded document' })
    metadata.resolve({ ok: true, data: { description: 'Previous document' } })
    selection.resolve({ ok: true, data: 'Previous selection' })

    expect(await selecting).toBe('')
    await settle()
    expect(store.getTab(TAB)?.metadata).toEqual({ description: 'Reloaded document' })
  })

  it('does not remove a replacement guest when a held browser inventory returns', async () => {
    const { api, store, ready, replace, navigate } = fixture()
    ready()
    const inventory = held({ ok: true as const, data: { guests: [{ guestId: OLD_GUEST, url: URL, title: 'Old' }] } })
    vi.spyOn(api.drivers.browser, 'list').mockReturnValue(inventory.promise)
    const listing = store.listBrowserTabs()
    replace()
    inventory.resolve({ ok: true, data: { guests: [{ guestId: OLD_GUEST, url: URL, title: 'Old' }] } })

    expect(await listing).toEqual({ ok: true, data: { tabs: [{ instanceId: TAB, url: URL, title: 'Replacement' }] } })
    await store.browserNavigate(TAB, 'https://next.example.test')
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith(NEW_GUEST, 'https://next.example.test')
  })

  it.each([true, false])('preserves an accepted mutation outcome after replacement (success=%s)', async (success) => {
    const { store, execute, close, ready, replace } = fixture()
    ready()
    await settle()
    const outcome = success ? { ok: true as const, data: { ok: true, info: 'Original click' } } : { ok: false as const, error: 'Original failure' }
    const mutation = held(outcome)
    execute.mockImplementation(async (_guestId, script) => script.includes('__valleyMarks') ? mutation.promise : { ok: true, data: {} })
    const clicking = store.browserClick(TAB, 3)
    replace()
    await settle()
    expect(close).not.toHaveBeenCalledWith(OLD_GUEST)
    mutation.resolve(outcome)

    expect(await clicking).toEqual(success ? { ok: true, data: { info: 'Original click' } } : { ok: false, error: 'Original failure' })
    await settle()
    expect(execute.mock.calls.filter(([, script]) => script.includes('__valleyMarks')).map(([guestId]) => guestId)).toEqual([OLD_GUEST])
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(OLD_GUEST)
  })

  it('waits for accepted commands and guest closure while refusing new work during disposal', async () => {
    const { store, execute, close, ready } = fixture()
    ready()
    await settle()
    const mutation = held({ ok: true as const, data: { ok: true, info: 'Accepted' } })
    const closing = held({ ok: true as const })
    execute.mockImplementation(async (_guestId, script) => script.includes('__valleyMarks') ? mutation.promise : { ok: true, data: {} })
    close.mockReturnValue(closing.promise)
    const clicking = store.browserClick(TAB, 1)
    let disposed = false
    const disposing = store.dispose().then(() => { disposed = true })
    expect(store.dispose()).toBe(store.dispose())
    expect((await store.browserClick(TAB, 2)).ok).toBe(false)
    await settle()
    expect(disposed).toBe(false)
    expect(close).not.toHaveBeenCalled()

    mutation.resolve({ ok: true, data: { ok: true, info: 'Accepted' } })
    expect(await clicking).toEqual({ ok: true, data: { info: 'Accepted' } })
    await settle()
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(OLD_GUEST)
    expect(disposed).toBe(false)
    closing.resolve({ ok: true })
    await disposing
    expect(disposed).toBe(true)
    expect(execute.mock.calls.filter(([, script]) => script.includes('__valleyMarks'))).toHaveLength(1)
  })

  it('drains held cosmetic discovery without dispatching follow-up work after disposal', async () => {
    const { api, store, execute, close, ready } = fixture()
    const discovery = held({ ok: true as const, data: { url: URL, classes: ['ad'], ids: [], hrefs: [] } })
    execute.mockImplementation(async (_guestId, script) => script.includes('const classes = new Set') ? discovery.promise : { ok: true, data: {} })
    ready()
    const disposing = store.dispose()
    await settle()
    expect(close).not.toHaveBeenCalled()
    discovery.resolve({ ok: true, data: { url: URL, classes: ['ad'], ids: [], hrefs: [] } })
    await disposing

    expect(api.backend.call).not.toHaveBeenCalledWith('filter.cosmetics', expect.anything())
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(OLD_GUEST)
    expect(execute.mock.calls.filter(([, script]) => !script.includes('AbortController'))).toHaveLength(2)
  })

  it('joins superseded cosmetic discovery before closing a guest after another ready event', async () => {
    const { api, store, execute, close, ready } = fixture()
    const discovery = held({ ok: true as const, data: { url: URL, classes: ['old'], ids: [], hrefs: [] } })
    let discoveries = 0
    execute.mockImplementation(async (_guestId, script) => {
      if (script.includes('const classes = new Set') && ++discoveries === 1) return discovery.promise
      return { ok: true, data: {} }
    })
    ready()
    store.guestEvent(TAB, { type: 'ready', guestId: OLD_GUEST, url: URL })
    const disposing = store.dispose()
    await settle()
    expect(close).not.toHaveBeenCalled()
    discovery.resolve({ ok: true, data: { url: URL, classes: ['old'], ids: [], hrefs: [] } })
    await disposing

    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(OLD_GUEST)
    expect(api.backend.call).not.toHaveBeenCalledWith('filter.cosmetics', expect.objectContaining({ classes: ['old'] }))
  })

  it('keeps old API callbacks and drains isolated from a later plugin API', async () => {
    const old = fixture()
    old.ready(OLD_GUEST, true)
    old.store.guestEvent(TAB, { type: 'media', guestId: OLD_GUEST, playing: true, audible: true })
    await settle()
    const retained = old.mediaPlayers[0]
    const fresh = fixture()
    initRuntime(fresh.api)
    fresh.ready(NEW_GUEST, true)
    fresh.store.guestEvent(TAB, { type: 'media', guestId: NEW_GUEST, playing: true, audible: true })
    await settle()
    old.execute.mockClear()
    fresh.execute.mockClear()

    await retained.toggle()
    expect(old.execute).toHaveBeenCalledTimes(1)
    expect(old.execute.mock.calls[0][0]).toBe(OLD_GUEST)
    expect(fresh.execute).not.toHaveBeenCalled()
    await old.store.dispose()
    expect(old.close).toHaveBeenCalledTimes(1)
    expect(old.close).toHaveBeenCalledWith(OLD_GUEST)
    expect(fresh.close).not.toHaveBeenCalled()
    expect(await fresh.mediaPlayers[0].getSnapshot()).toMatchObject({ state: { status: 'playing' } })
    old.execute.mockClear()
    await expect(retained.toggle()).rejects.toThrow('disposed')
    expect(old.execute).not.toHaveBeenCalled()
    expect(fresh.execute).not.toHaveBeenCalled()
  })

  it('keeps old ready and playback bindings revoked after root A→B→A', async () => {
    const { api, emitState, store, execute, close, ready, mediaPlayers } = fixture()
    const originalRoot = api.getState().vault
    const binding = ready(OLD_GUEST, true)
    store.guestEvent(TAB, { type: 'media', guestId: OLD_GUEST, playing: true, audible: true })
    await settle()
    const playback = mediaPlayers[0]
    execute.mockClear()

    emitState({ vault: { path: '/test/surfing-other-vault', name: 'Other', displayName: 'Other' } })
    emitState({ vault: originalRoot })
    binding.onReady({ type: 'ready', guestId: NEW_GUEST, url: 'https://stale.example.test' })
    await settle()
    execute.mockClear()
    await expect(playback.toggle()).rejects.toThrow('disposed')
    await expect(playback.pause()).rejects.toThrow('disposed')
    await expect(playback.setVolume(0.25)).rejects.toThrow('disposed')

    expect(store.guestTarget(TAB)).toBeUndefined()
    expect(store.getTab(TAB)?.url).toBe(URL)
    expect(execute).not.toHaveBeenCalled()
    expect((await store.browserClick(TAB, 1)).ok).toBe(false)
    await store.dispose()
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(OLD_GUEST)
    expect(mediaPlayers[0].dispose).toHaveBeenCalled()
  })

  it('preserves a failed guest close on repeated disposal without retrying it', async () => {
    const { store, close, ready } = fixture()
    ready()
    await settle()
    close.mockResolvedValue({ ok: false, error: 'Guest close failed' })
    const disposing = store.dispose()
    expect(store.dispose()).toBe(disposing)
    await expect(disposing).rejects.toThrow('Guest close failed')
    expect(store.dispose()).toBe(disposing)
    await expect(store.dispose()).rejects.toThrow('Guest close failed')
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(OLD_GUEST)
  })

  it('closes a deleted profile guest and ignores its retained ready and history events', async () => {
    const { api, store, close, ready, navigate } = fixture()
    await store.loadConfig()
    const profileId = store.addProfile('Research')
    await store.flushProfiles()
    store.restoreTab(TAB, { url: URL, title: 'Research', profileId })
    const binding = ready()
    await store.deleteProfile(profileId)
    await settle()
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(OLD_GUEST)
    expect(store.getTab(TAB)?.profileId).toBe('default')

    binding.onReady({ type: 'ready', guestId: OLD_GUEST, url: 'https://late.example.test', title: 'Late' })
    store.guestEvent(TAB, { type: 'navigate', guestId: OLD_GUEST, url: 'https://late.example.test' })
    store.guestEvent(TAB, { type: 'title', guestId: OLD_GUEST, title: 'Late' })
    expect(store.getTab(TAB)).toMatchObject({ url: URL, title: 'Research', profileId: 'default' })
    expect((await store.browserNavigate(TAB, 'https://ignored.example.test')).ok).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    await settle()
    const history = await api.data.dataset('visits').query({})
    expect(history.rows.some(row => row.url === 'https://late.example.test')).toBe(false)
  })

  it('waits for a deleted profile mutation and guest closure before clearing browser data', async () => {
    const { api, store, execute, close, ready } = fixture()
    const clearData = vi.spyOn(api.drivers.browser, 'clearData').mockResolvedValue({ ok: true })
    await store.loadConfig()
    const profileId = store.addProfile('Research')
    await store.flushProfiles()
    store.restoreTab(TAB, { url: URL, title: 'Research', profileId })
    ready()
    await settle()
    const mutation = held({ ok: true as const, data: { ok: true, info: 'Saved by old guest' } })
    const closing = held({ ok: true as const })
    execute.mockImplementation(async (_guestId, script) => script.includes('__valleyMarks') ? mutation.promise : { ok: true, data: {} })
    close.mockReturnValue(closing.promise)
    const clicking = store.browserClick(TAB, 4)
    const deleting = store.deleteProfile(profileId)
    await settle()
    expect(close).not.toHaveBeenCalled()
    expect(clearData).not.toHaveBeenCalled()

    mutation.resolve({ ok: true, data: { ok: true, info: 'Saved by old guest' } })
    expect(await clicking).toEqual({ ok: true, data: { info: 'Saved by old guest' } })
    await settle()
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(OLD_GUEST)
    expect(clearData).not.toHaveBeenCalled()
    closing.resolve({ ok: true })
    await deleting
    expect(clearData).toHaveBeenCalledTimes(1)
    expect(clearData).toHaveBeenCalledWith(`persist:web_${profileId}`)
  })
})
