import { describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import { registerDataOwner, type ProfilesSnapshot, type PagesSnapshot } from '../src/backend/data'
import { createMockValleyApi } from './mock'
import { assertCommandOutput } from './commandContracts'

function fixture() {
  const mock = createMockValleyApi(), methods = new Map<string, (input: unknown, context: PluginBackendOperationContext) => Promise<unknown>>()
  const emit = vi.fn(), controller = new AbortController()
  const ambient = { data: { dataset: vi.fn(() => { throw new Error('Ambient owner must not serve an admitted command') }) }, rpc: { emit, handle: vi.fn(() => () => {}), handleOperation: (method: string, handler: (input: unknown, context: PluginBackendOperationContext) => Promise<unknown>) => { methods.set(method, handler); return () => methods.delete(method) } } }
  const dispose = registerDataOwner(ambient as unknown as PluginBackendApi)
  const context = { api: { data: mock.api.data, rpc: { emit } }, cancellation: controller.signal } as unknown as PluginBackendOperationContext
  const call = async <T = ProfilesSnapshot>(method: string, input: unknown): Promise<T> => {
    const output = await methods.get(`command.${method}`)!(input, context)
    assertCommandOutput(`command.${method}`, input, output)
    return output as T
  }
  return { ...mock, call, dispose, controller, emit, ambient }
}

describe('owned background browser data', () => {
  it('validates all ten real operation results and shares UI persistence', async () => {
    const { call, api, ambient } = fixture()
    const initial = await call('profiles.list', {})
    const seeded = await call('profiles.set', { profiles: initial.profiles, expected: initial.revisions })
    const created = await call('profiles.create', { name: 'Research', expected: seeded.revisions })
    const id = created.profiles.find(value => value.name === 'Research')!.id
    const patched = await call('profiles.patch', { id, patch: { name: 'Articles', adblockEnabled: false }, expected: created.revisions })
    expect(patched.profiles.find(value => value.id === id)).toMatchObject({ name: 'Articles', adblockEnabled: false })
    const saved = await call<PagesSnapshot>('saved.list', { profileId: id, kind: 'favorite' })
    const page = { url: 'https://forest.example', title: 'Forest', ts: 1 }
    await call('saved.set', { profileId: id, kind: 'favorite', pages: [page], expectedRevision: saved.revision })
    await expect(api.backend.call('data.saved.list', { profileId: id, kind: 'favorite' })).resolves.toMatchObject({ pages: [page] })
    await call('history.append', { profileId: id, page, id: 'visit-1' })
    const history = await call<PagesSnapshot>('history.list', { profileId: id })
    expect(history.pages).toEqual([page])
    await call('history.clear', { profileId: id, expectedRevision: history.revision })
    const deleted = await call('profiles.delete', { id, expected: patched.revisions })
    expect(deleted.browserCleanupDeferred).toEqual([id])
    expect((await api.data.dataset('saved_pages').query({})).rows).toEqual([])
    expect(ambient.data.dataset).not.toHaveBeenCalled()
  })

  it('allows exactly one of ten concurrent writes with the same observed revisions', async () => {
    const { call } = fixture(), initial = await call('profiles.list', {})
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => call('profiles.patch', { id: 'default', patch: { name: `Profile ${index}` }, expected: initial.revisions })))
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(value => value.status === 'rejected')).toHaveLength(9)
  })

  it('rejects stale history clearing and stale list replacement without discarding new entries', async () => {
    const { call } = fixture(), saved = await call<PagesSnapshot>('saved.list', { profileId: 'default', kind: 'favorite' })
    const page = { url: 'https://forest.example', title: 'Forest', ts: 1 }
    await call('saved.set', { profileId: 'default', kind: 'favorite', pages: [page], expectedRevision: saved.revision })
    await expect(call('saved.set', { profileId: 'default', kind: 'favorite', pages: [], expectedRevision: saved.revision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const history = await call<PagesSnapshot>('history.list', { profileId: 'default' })
    await call('history.append', { profileId: 'default', page, id: 'visit-1' })
    await expect(call('history.clear', { profileId: 'default', expectedRevision: history.revision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect((await call<PagesSnapshot>('history.list', { profileId: 'default' })).pages).toEqual([page])
  })

  it('preserves private profile identity and never persists its browsing data', async () => {
    const { call, api } = fixture(), initial = await call('profiles.list', {})
    await expect(call('profiles.patch', { id: 'incognito', patch: { name: 'Public' }, expected: initial.revisions })).rejects.toThrow('Private')
    await expect(call('profiles.set', { profiles: initial.profiles.map(value => value.id === 'incognito' ? { ...value, name: 'Public' } : value), expected: initial.revisions })).rejects.toThrow('Private')
    await expect(call('saved.set', { profileId: 'incognito', kind: 'favorite', pages: [], expectedRevision: 0 })).rejects.toThrow('session-only')
    expect(await call('history.append', { profileId: 'incognito', page: { url: 'https://forest.example', title: 'Forest', ts: 1 }, id: 'visit-1' })).toEqual({ recorded: false })
    expect((await api.data.dataset('visits').query({})).rows).toEqual([])
    await expect(call('profiles.delete', { id: 'default', expected: initial.revisions })).rejects.toThrow('cannot be deleted')
  })

  it('cancels after owner reads before a durable mutation', async () => {
    const { call, api, controller, emit } = fixture(), initial = await call('profiles.list', {})
    const dataset = api.data.dataset.bind(api.data), transaction = vi.spyOn(api.data, 'transaction')
    vi.spyOn(api.data, 'dataset').mockImplementation(id => {
      const value = dataset(id)
      return { ...value, query: async input => { const result = await value.query(input); controller.abort(new Error('Cancelled')); return result } }
    })
    await expect(call('profiles.patch', { id: 'default', patch: { name: 'Changed' }, expected: initial.revisions })).rejects.toThrow('Cancelled')
    expect(transaction).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })
})
