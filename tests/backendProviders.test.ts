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
type Saved = { provider: EmbedProvider; revisions: { provider: number; renderer: number }; catalogRevision: number; restorable: boolean }

describe('background embed provider owner', () => {
  it('validates all provider operation results without executing renderer code', async () => {
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

  it('refuses stale catalogs, missing providers and invalid definitions as not-applied before writing', async () => {
    const { call, storage } = fixture(), initial = await call<EmbedProviderConfiguration>('providers.list', {})
    const created = await call<Saved>('providers.create', {}), refused = (code: string) => ({ code, outcome: 'not-applied', retryable: false })
    const writes = vi.mocked(storage.writeDocuments).mock.calls.length
    await expect(call('providers.customize', { id: 'youtube', expected: { ...initial.revisions.youtube, catalog: initial.catalogRevision } })).rejects.toMatchObject(refused('REVISION_CONFLICT'))
    await expect(call('providers.set', { provider: { ...created.provider, displayName: 'Stale' }, expected: { ...created.revisions, catalog: initial.catalogRevision } })).rejects.toMatchObject(refused('REVISION_CONFLICT'))
    await expect(call('providers.customize', { id: 'missing', expected: { provider: 0, renderer: 0, catalog: created.catalogRevision } })).rejects.toMatchObject(refused('TARGET_NOT_FOUND'))
    await expect(call('providers.set', { provider: { ...created.provider, language: 'youtube' }, expected: { ...created.revisions, catalog: created.catalogRevision } })).rejects.toMatchObject(refused('INVALID_INPUT'))
    await expect(call('providers.set', { provider: { ...created.provider, template: 'https://example.com/{value}/{value}' }, expected: { ...created.revisions, catalog: created.catalogRevision } })).rejects.toMatchObject(refused('INVALID_INPUT'))
    expect(storage.writeDocuments).toHaveBeenCalledTimes(writes)
  })

  it('deletes created and customized providers back to the exact prior file bytes and reuses the freed id', async () => {
    const { call, api, storage, emit } = fixture(), files = async () => {
      const read = async (path: string): Promise<Array<[string, string | null]>> => (await Promise.all((await api.data.files.list(path)).map(async entry => entry.isDirectory ? read(`${path}/${entry.name}`) : [[`${path}/${entry.name}`, await api.data.files.readText(`${path}/${entry.name}`)] as [string, string | null]]))).flat()
      return Object.fromEntries(await read('embeds'))
    }
    const first = await call<Saved>('providers.create', {}), afterFirst = await files()
    const second = await call<Saved>('providers.create', {})
    expect(second.provider.id).toBe('custom-2')
    const deleted = await call<{ id: string; directory: string; catalogRevision: number }>('providers.delete', { id: 'custom-2', expected: { ...second.revisions, catalog: second.catalogRevision } })
    expect(deleted).toMatchObject({ id: 'custom-2', directory: 'custom-2' })
    expect(await files()).toEqual(afterFirst)
    expect(storage.remove).toHaveBeenCalledWith({ handle: 'providers-test', path: 'embeds/custom-2' }, { missingOk: true })
    expect(emit).toHaveBeenCalledWith('providers.changed', { id: 'custom-2' })
    const listed = await call<EmbedProviderConfiguration>('providers.list', {})
    expect(listed.customized).toEqual(['custom'])
    expect(listed.catalogRevision).toBe(deleted.catalogRevision)
    await call('providers.delete', { id: 'custom', expected: { ...listed.revisions.custom, catalog: listed.catalogRevision } })
    expect(await files()).toEqual({})
    expect(storage.remove).toHaveBeenCalledWith({ handle: 'providers-test', path: 'embeds' }, { missingOk: true })
    const recreated = await call<Saved>('providers.create', {})
    expect(recreated.provider).toEqual(first.provider)
    expect(await files()).toEqual(afterFirst)
    const before = await call<EmbedProviderConfiguration>('providers.list', {}), snapshot = await files()
    await call('providers.customize', { id: 'youtube', expected: { ...before.revisions.youtube, catalog: before.catalogRevision } })
    const customized = await call<EmbedProviderConfiguration>('providers.list', {})
    expect(customized.customized).toContain('youtube')
    await call('providers.delete', { id: 'youtube', expected: { ...customized.revisions.youtube, catalog: customized.catalogRevision } })
    expect(await files()).toEqual(snapshot)
    expect((await call<EmbedProviderConfiguration>('providers.list', {})).customized).toEqual(['custom'])
  })

  it('restores a legacy revision-counter catalog byte for byte', async () => {
    const { call, api } = fixture()
    await api.data.files.writeTextGuarded('embeds/catalog.json', '{"revision":7}', null)
    const created = await call<Saved>('providers.create', {})
    expect(await api.data.files.readText('embeds/catalog.json')).not.toBe('{"revision":7}')
    await call('providers.delete', { id: created.provider.id, expected: { ...created.revisions, catalog: created.catalogRevision } })
    expect(await api.data.files.readText('embeds/catalog.json')).toBe('{"revision":7}')
  })

  it('reports restorable only when a later delete rebuilds the exact prior catalog and files', async () => {
    const { call } = fixture()
    expect((await call<Saved>('providers.create', {})).restorable).toBe(true)
    let listed = await call<EmbedProviderConfiguration>('providers.list', {})
    expect((await call<Saved>('providers.customize', { id: 'youtube', expected: { ...listed.revisions.youtube, catalog: listed.catalogRevision } })).restorable).toBe(true)
    listed = await call<EmbedProviderConfiguration>('providers.list', {})
    expect((await call<Saved>('providers.customize', { id: 'youtube', expected: { ...listed.revisions.youtube, catalog: listed.catalogRevision } })).restorable).toBe(false)
    const legacy = fixture()
    await legacy.api.data.files.writeTextGuarded('embeds/catalog.json', '{"revision":7}', null)
    expect((await legacy.call<Saved>('providers.create', {})).restorable).toBe(true)
    const formatted = fixture(), catalog = '{\n  "revision": 7\n}\n'
    await formatted.api.data.files.writeTextGuarded('embeds/catalog.json', catalog, null)
    const created = await formatted.call<Saved>('providers.create', {})
    expect(created.restorable).toBe(false)
    const empty = fixture()
    await empty.api.data.files.writeTextGuarded('embeds/catalog.json', '', null)
    expect((await empty.call<Saved>('providers.create', {})).restorable).toBe(false)
    const created2 = await empty.call<Saved>('providers.create', {}), baseline = await empty.api.data.files.readTextBaseline('embeds/catalog.json')
    await empty.api.data.files.writeTextGuarded('embeds/catalog.json', '', baseline!.baseline)
    const observed = await empty.call<EmbedProviderConfiguration>('providers.list', {})
    await empty.call('providers.set', { provider: created2.provider, expected: { ...observed.revisions[created2.provider.directory], catalog: observed.catalogRevision } })
    expect(await empty.api.data.files.readText('embeds/catalog.json')).toBe('')
  })

  it('reports a customize over a stale catalog entry or existing empty files as not restorable', async () => {
    const stale = fixture()
    await stale.api.data.files.writeTextGuarded('embeds/catalog.json', JSON.stringify({ providers: { youtube: 'stale-token' } }), null)
    let listed = await stale.call<EmbedProviderConfiguration>('providers.list', {})
    expect((await stale.call<Saved>('providers.customize', { id: 'youtube', expected: { ...listed.revisions.youtube, catalog: listed.catalogRevision } })).restorable).toBe(false)
    for (const file of ['provider.json', 'renderer.tsx']) {
      const { call, api } = fixture()
      await api.data.files.writeTextGuarded(`embeds/youtube/${file}`, '', null)
      expect(await api.data.files.readText(`embeds/youtube/${file}`)).toBe('')
      listed = await call<EmbedProviderConfiguration>('providers.list', {})
      expect((await call<Saved>('providers.customize', { id: 'youtube', expected: { ...listed.revisions.youtube, catalog: listed.catalogRevision } })).restorable).toBe(false)
    }
  })

  it('never creates into a directory that already has a catalog entry', async () => {
    const { call, api } = fixture(), catalog = JSON.stringify({ providers: { custom: 'stale-token', 'Custom-2': 'other' } })
    await api.data.files.writeTextGuarded('embeds/catalog.json', catalog, null)
    const created = await call<Saved>('providers.create', {})
    expect(created.provider.id).toBe('custom-3')
    expect(created.restorable).toBe(true)
    await call('providers.delete', { id: 'custom-3', expected: { ...created.revisions, catalog: created.catalogRevision } })
    expect(await api.data.files.readText('embeds/catalog.json')).toBe(catalog)
  })

  it('refuses stale, built-in and missing provider deletions as not-applied before writing', async () => {
    const { call, storage } = fixture(), created = await call<Saved>('providers.create', {}), refused = (code: string) => ({ code, outcome: 'not-applied', retryable: false })
    const listed = await call<EmbedProviderConfiguration>('providers.list', {}), writes = vi.mocked(storage.writeDocuments).mock.calls.length
    await expect(call('providers.delete', { id: 'custom', expected: { ...created.revisions, catalog: created.catalogRevision - 1 } })).rejects.toMatchObject(refused('REVISION_CONFLICT'))
    await expect(call('providers.delete', { id: 'custom', expected: { ...created.revisions, provider: created.revisions.provider + 1, catalog: created.catalogRevision } })).rejects.toMatchObject(refused('REVISION_CONFLICT'))
    await expect(call('providers.delete', { id: 'youtube', expected: { ...listed.revisions.youtube, catalog: listed.catalogRevision } })).rejects.toMatchObject(refused('TARGET_NOT_FOUND'))
    await expect(call('providers.delete', { id: 'missing', expected: { provider: 0, renderer: 0, catalog: listed.catalogRevision } })).rejects.toMatchObject(refused('TARGET_NOT_FOUND'))
    expect(storage.writeDocuments).toHaveBeenCalledTimes(writes)
    vi.mocked(storage.writeDocuments).mockImplementationOnce(() => Promise.reject(Object.assign(new Error('Document changed'), { code: 'REVISION_CONFLICT' })))
    await expect(call('providers.delete', { id: 'custom', expected: { ...listed.revisions.custom, catalog: listed.catalogRevision } })).rejects.toMatchObject(refused('REVISION_CONFLICT'))
    expect((await call<EmbedProviderConfiguration>('providers.list', {})).customized).toEqual(['custom'])
  })

  it('keeps hand-formatted provider bytes when set back to an equal definition', async () => {
    const { call, api } = fixture(), created = await call<Saved>('providers.create', {})
    const file = 'embeds/custom/provider.json', { directory: _, order, ...rest } = created.provider
    const handwritten = `${JSON.stringify({ order, ...rest }, null, '\t')}\n`
    await api.data.files.writeTextGuarded(file, handwritten, (await api.data.files.readTextBaseline(file))!.baseline)
    const listed = await call<EmbedProviderConfiguration>('providers.list', {}), catalog = await api.data.files.readText('embeds/catalog.json')
    const saved = await call<Saved>('providers.set', { provider: created.provider, expected: { ...listed.revisions.custom, catalog: listed.catalogRevision } })
    expect(await api.data.files.readText(file)).toBe(handwritten)
    expect(await api.data.files.readText('embeds/catalog.json')).toBe(catalog)
    expect(saved.catalogRevision).toBe(listed.catalogRevision)
    const listedAgain = await call<EmbedProviderConfiguration>('providers.list', {})
    await call('providers.set', { provider: { ...created.provider, displayName: 'Renamed' }, expected: { ...listedAgain.revisions.custom, catalog: listedAgain.catalogRevision } })
    expect(JSON.parse((await api.data.files.readText(file))!)).toMatchObject({ displayName: 'Renamed' })
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
