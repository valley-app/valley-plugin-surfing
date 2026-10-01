import { describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import { registerProviderOwner } from '../src/backend/providers'
import type { EmbedProviderConfiguration } from '../src/embedProviderData'
import type { EmbedProvider } from '../src/embeds/types'
import { createMockValleyApi } from './mock'
import { assertCommandOutput } from './commandContracts'
import config from '../config.json'

function fixture() {
  const mock = createMockValleyApi(), methods = new Map<string, (input: unknown, context: PluginBackendOperationContext) => Promise<unknown>>()
  const open = mock.storage.open
  Object.assign(mock.storage, { open: vi.fn(async (request: Parameters<PluginBackendApi['storage']['open']>[0]) => {
    const metadata = (config.permissions.storage as { metadata?: string[] }).metadata ?? []
    if (request.area === 'metadata' && !metadata.some(prefix => request.path === prefix || request.path.startsWith(`${prefix}/`))) throw new Error('Metadata storage is not declared')
    return open(request)
  }) })
  const emit = vi.fn(), controller = new AbortController()
  const ambient = { rpc: { emit, handle: () => () => {}, handleOperation: (method: string, handler: (input: unknown, context: PluginBackendOperationContext) => Promise<unknown>) => { methods.set(method, handler); return () => {} } } }
  registerProviderOwner(ambient as unknown as PluginBackendApi)
  const context = { api: { data: mock.api.data, storage: mock.storage, rpc: { emit } }, cancellation: controller.signal } as unknown as PluginBackendOperationContext
  const call = async <T>(method: string, input: unknown): Promise<T> => {
    const result = await methods.get(`command.${method}`)!(input, context)
    assertCommandOutput(`command.${method}`, input, result)
    return result as T
  }
  return { ...mock, call, controller, emit }
}
type Saved = { provider: EmbedProvider; revisions: { provider: number; renderer: number }; catalogRevision: number }

describe('background embed provider owner', () => {
  it('validates all four operation results without executing renderer code', async () => {
    const { call, api } = fixture(), compile = vi.spyOn(api.data.files, 'compileModule')
    const initial = await call<EmbedProviderConfiguration>('providers.list', {})
    const youtube = await call<Saved>('providers.customize', { id: 'youtube', expected: { ...initial.revisions.youtube, catalog: initial.catalogRevision } })
    const current = await call<EmbedProviderConfiguration>('providers.list', {})
    const edited = await call<Saved>('providers.set', { provider: { ...youtube.provider, displayName: 'Video' }, expected: { ...current.revisions.youtube, catalog: current.catalogRevision } })
    expect(edited.provider.displayName).toBe('Video')
    const created = await call<Saved>('providers.create', {})
    expect(created.provider.id).toBe('custom')
    const ui = await api.backend.call<EmbedProviderConfiguration>('providers.list', {})
    expect(ui.providers.find(value => value.id === 'youtube')?.displayName).toBe('Video')
    expect(compile).not.toHaveBeenCalled()
  })

  it('serializes concurrent provider creations through the shared catalog revision', async () => {
    const { call } = fixture()
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => call('providers.create', {})))
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(9)
    expect((await call<EmbedProviderConfiguration>('providers.list', {})).customized).toEqual(['custom'])
  })

  it('rejects stale definitions, preserves external renderer edits, and keeps no-op revisions', async () => {
    const { call, api } = fixture(), created = await call<Saved>('providers.create', {})
    const file = 'embeds/custom/renderer.tsx', baseline = await api.data.files.readTextBaseline(file)
    await api.data.files.writeTextGuarded(file, 'export default customRenderer', baseline!.baseline)
    await expect(call('providers.set', { provider: { ...created.provider, displayName: 'New' }, expected: { ...created.revisions, catalog: created.catalogRevision } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(await api.data.files.readText(file)).toBe('export default customRenderer')
    const observed = await call<EmbedProviderConfiguration>('providers.list', {})
    const noOp = await call<Saved>('providers.customize', { id: 'custom', expected: { ...observed.revisions.custom, catalog: observed.catalogRevision } })
    expect(noOp.revisions).toEqual(observed.revisions.custom)
    expect(noOp.catalogRevision).toEqual(observed.catalogRevision)
  })

  it('does not write after its admitted operation is cancelled', async () => {
    const { call, controller, storage } = fixture()
    const read = storage.readDocument.bind(storage)
    vi.spyOn(storage, 'readDocument').mockImplementation(async location => { const result = await read(location); controller.abort(new Error('Cancelled')); return result })
    await expect(call('providers.create', {})).rejects.toThrow('Cancelled')
    expect(storage.writeDocuments).not.toHaveBeenCalled()
    expect(storage.close).toHaveBeenCalled()
  })
})
