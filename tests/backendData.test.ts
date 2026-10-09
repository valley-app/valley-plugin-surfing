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

  it('refuses invalid, protected and missing targets as not-applied before any mutation', async () => {
    const { call, api, emit } = fixture(), initial = await call('profiles.list', {}), page = { url: 'https://forest.example', title: 'Forest', ts: 1 }
    await call('history.append', { profileId: 'default', page, id: 'visit-1' })
    const transaction = vi.spyOn(api.data, 'transaction'), refused = (code: string) => ({ code, outcome: 'not-applied', retryable: false })
    await expect(call('profiles.delete', { id: 'missing', expected: initial.revisions })).rejects.toMatchObject(refused('TARGET_NOT_FOUND'))
    await expect(call('profiles.delete', { id: 'default', expected: initial.revisions })).rejects.toMatchObject(refused('ACTION_UNAVAILABLE'))
    await expect(call('profiles.delete', { id: 'incognito', expected: initial.revisions })).rejects.toMatchObject(refused('ACTION_UNAVAILABLE'))
    await expect(call('profiles.set', { profiles: initial.profiles.map(value => ({ ...value, private: true })), expected: initial.revisions })).rejects.toMatchObject(refused('INVALID_INPUT'))
    await expect(call('profiles.create', { name: '   ', expected: initial.revisions })).rejects.toMatchObject(refused('INVALID_INPUT'))
    await expect(call('profiles.patch', { id: 'default', patch: { hidden: true }, expected: initial.revisions })).rejects.toMatchObject(refused('ACTION_UNAVAILABLE'))
    await expect(call('saved.set', { profileId: 'incognito', kind: 'favorite', pages: [], expectedRevision: 0 })).rejects.toMatchObject(refused('ACTION_UNAVAILABLE'))
    await expect(call('saved.set', { profileId: 'default', kind: 'favorite', pages: [page, page], expectedRevision: 0 })).rejects.toMatchObject(refused('INVALID_INPUT'))
    await expect(call('saved.list', { profileId: 'missing', kind: 'favorite' })).rejects.toMatchObject(refused('TARGET_NOT_FOUND'))
    await expect(call('history.append', { profileId: 'default', page: { ...page, url: 'file:///forest' }, id: 'visit-2' })).rejects.toMatchObject(refused('INVALID_INPUT'))
    await expect(call('history.append', { profileId: 'default', page: { ...page, title: 'Duplicate' }, id: 'visit-1' })).rejects.toMatchObject(refused('INVALID_INPUT'))
    expect(transaction).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect((await call<PagesSnapshot>('history.list', { profileId: 'default' })).pages).toEqual([page])
  })

  it('deletes profiles and clears history without the empty record writes the store rejects', async () => {
    const { call, api } = fixture(), transaction = api.data.transaction.bind(api.data)
    vi.spyOn(api.data, 'transaction').mockImplementation(async (operations, options) => {
      if (operations.some(operation => (operation.operation === 'insert' || operation.operation === 'upsert') && Array.isArray(operation.values) && !operation.values.length)) throw Object.assign(new Error('Invalid records'), { code: 'validation-failed', retryable: false, outcomeUnknown: false })
      return transaction(operations, options)
    })
    const page = { url: 'https://forest.example', title: 'Forest', ts: 1 }
    expect(await call<PagesSnapshot>('history.clear', { profileId: 'default', expectedRevision: (await call<PagesSnapshot>('history.list', { profileId: 'default' })).revision })).toMatchObject({ pages: [] })
    await call('history.append', { profileId: 'default', page, id: 'visit-1' })
    const cleared = await call<PagesSnapshot>('history.clear', { profileId: 'default', expectedRevision: (await call<PagesSnapshot>('history.list', { profileId: 'default' })).revision })
    expect(cleared.pages).toEqual([])
    expect((await api.data.dataset('visits').query({})).rows).toEqual([])
    const initial = await call('profiles.list', {}), created = await call('profiles.create', { name: 'Fixture', expected: initial.revisions })
    const id = created.profiles.find(value => value.name === 'Fixture')!.id
    await call('history.append', { profileId: id, page, id: 'visit-2' })
    const deleted = await call('profiles.delete', { id, expected: (await call('profiles.list', {})).revisions })
    expect(deleted.browserCleanupDeferred).toEqual([id])
    expect((await call('profiles.list', {})).profiles.map(value => value.id)).toEqual(initial.profiles.map(value => value.id))
    expect((await api.data.dataset('visits').query({})).rows).toEqual([])
  })

  it('reports store refusals that rolled back as not-applied and keeps unknown store outcomes unknown', async () => {
    const { call, api } = fixture(), initial = await call('profiles.list', {}), transaction = vi.spyOn(api.data, 'transaction')
    transaction.mockRejectedValueOnce(Object.assign(new Error('Dataset revision changed'), { code: 'conflict', retryable: false, outcomeUnknown: false }))
    await expect(call('profiles.patch', { id: 'default', patch: { name: 'Raced' }, expected: initial.revisions })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied', retryable: false })
    transaction.mockRejectedValueOnce(Object.assign(new Error('Invalid records'), { code: 'validation-failed', retryable: false, outcomeUnknown: false }))
    await expect(call('history.append', { profileId: 'default', page: { url: 'https://forest.example', title: 'Forest', ts: 1 }, id: 'visit-1' })).rejects.toMatchObject({ code: 'validation-failed', outcome: 'not-applied' })
    transaction.mockRejectedValueOnce(Object.assign(new Error('Store closed during commit'), { code: 'store-unavailable', retryable: false, outcomeUnknown: true }))
    const unknown = await call('profiles.patch', { id: 'default', patch: { name: 'Unknown' }, expected: initial.revisions }).catch((error: unknown) => error)
    expect(unknown).toMatchObject({ code: 'store-unavailable', outcomeUnknown: true })
    expect(unknown).not.toHaveProperty('outcome')
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
