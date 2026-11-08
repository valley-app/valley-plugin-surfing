import { createMockValleyApi as createApi } from '@valley/plugin-testkit'
import Ajv from 'ajv'
import { createProviderOwner } from '../src/backend/providers'
import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import { createDataOwner } from '../src/backend/data'
import { vi } from 'vitest'
import { pluginDataDirectoryPath } from '@valley/plugin-sdk/paths'
import type { ValleyPluginApi } from '@valley/plugin-sdk'

type PluginStorageLocation = Parameters<PluginBackendOperationContext['api']['storage']['readDocument']>[0]
type PluginStorageDocumentWrite = Parameters<PluginBackendOperationContext['api']['storage']['writeDocuments']>[0][number]

type ExternalPlayer = Awaited<ReturnType<ValleyPluginApi['playback']['createExternalPlayer']>>
type MediaSnapshot = NonNullable<Awaited<ReturnType<ExternalPlayer['getSnapshot']>>>
type MediaExecutor = Parameters<ValleyPluginApi['playback']['createExternalPlayer']>[1]

export function createMockValleyApi(options: Parameters<typeof createApi>[0] = {}) {
  const mock = createApi({ ...options, manifest: { id: 'surfing', ...options.manifest } })
  const register = mock.api.commands.register.bind(mock.api.commands)
  const compiler = new Ajv({ strict: true })
  mock.api.commands.register = command => {
    const outputSchema = (command as typeof command & { outputSchema?: Record<string, unknown> }).outputSchema
    const validate = outputSchema ? compiler.compile(outputSchema) : null
    return register({ ...command, run: async (input, context) => {
      const result = await command.run(input, context)
      const value = command.sideEffect === 'write' && result && typeof result === 'object' && 'value' in result ? result.value : result ?? null
      if (validate && !validate(value)) throw new Error(`Invalid ${command.id} result: ${JSON.stringify(validate.errors)}`)
      return result
    } })
  }
  mock.api.ui.ContentLoader = ({ label }) => mock.api.React.createElement('span', { role: 'status', 'aria-label': label }, label)
  const cacheEntries = new Map<string, { json: string; expiresAt: number }>()
  Object.assign(mock.api.cache, {
    get: vi.fn(async (namespace: string, key: string) => {
      const entry = cacheEntries.get(`${namespace}\n${key}`)
      return entry && entry.expiresAt > Date.now() ? JSON.parse(entry.json) : undefined
    }),
    set: vi.fn(async (namespace: string, key: string, value: unknown, options?: { ttlMs?: number }) => {
      const json = JSON.stringify(value)
      if (key.length > 256 || new TextEncoder().encode(json).length > 1024 * 1024) throw new Error('Cache value rejected')
      cacheEntries.set(`${namespace}\n${key}`, { json, expiresAt: options?.ttlMs ? Date.now() + options.ttlMs : Infinity })
    }),
    delete: vi.fn(async (namespace: string, key: string) => { cacheEntries.delete(`${namespace}\n${key}`) })
  })
  const documents = new Map<string, { content: string; revision: number }>()
  let pending = Promise.resolve()
  const observe = async (location: PluginStorageLocation) => {
    const content = await mock.api.data.files.readText(location.path ?? '') ?? '', previous = documents.get(location.path ?? '')
    const value = { content, revision: previous ? previous.revision + Number(previous.content !== content) : content ? 1 : 0 }
    documents.set(location.path ?? '', value)
    return value
  }
  const storage = {
    open: vi.fn(async () => ({ handle: 'providers-test' })), close: vi.fn(async () => {}), readDocument: vi.fn(observe),
    writeDocuments: vi.fn((entries: PluginStorageDocumentWrite[]) => {
      const operation = pending.then(async () => {
        const current = await Promise.all(entries.map(entry => observe(entry.location)))
        entries.forEach((entry, index) => { if (entry.expectedRevision !== current[index].revision) throw Object.assign(new Error('Document changed'), { code: 'REVISION_CONFLICT' }) })
        for (const entry of entries) {
          const path = entry.location.path ?? '', baseline = await mock.api.data.files.readTextBaseline(path)
          if (entry.content === null) { if (baseline) await mock.api.drivers.files.deleteFile(`${pluginDataDirectoryPath('surfing')}/${path}`); continue }
          const result = await mock.api.data.files.writeTextGuarded(path, entry.content ?? '', baseline?.baseline ?? null)
          if (!result.ok) throw Object.assign(new Error('Document changed'), { code: 'REVISION_CONFLICT' })
        }
        return { revisions: await Promise.all(entries.map(async entry => (await observe(entry.location)).revision)) }
      })
      pending = operation.then(() => {}, () => {})
      return operation
    }),
    list: vi.fn(async (location: PluginStorageLocation) => (await mock.api.data.files.list(location.path ?? '')).map(entry => ({ name: entry.name, kind: entry.isDirectory ? 'directory' : 'file', size: 0, mtimeMs: 0 }))),
    remove: vi.fn(async (location: PluginStorageLocation, options?: { recursive?: boolean }) => {
      if (!options?.recursive && (await mock.api.data.files.list(location.path ?? '')).length) throw Object.assign(new Error('Directory is not empty'), { code: 'ENOTEMPTY' })
    })
  } as unknown as PluginBackendOperationContext['api']['storage']
  const rpc = { emit: () => {} }, data = createDataOwner({ data: mock.api.data, rpc }, undefined, true), providers = createProviderOwner({ data: mock.api.data, rpc, storage })
  vi.mocked(mock.api.backend.call).mockImplementation(async (method, input) => {
    if (method.startsWith('data.') && method.slice(5) in data) return await data[method.slice(5) as keyof typeof data](input) as never
    if (method in providers) return await providers[method as keyof typeof providers](input) as never
    return { styles: '', scripts: [] } as never
  })
  mock.api.drivers.browser.setAudioMuted = vi.fn(async (_guestId, muted) => ({ ok: true, data: { muted } }))
  const mediaPlayers: ExternalPlayer[] = []
  mock.api.playback.createExternalPlayer = vi.fn(async (options, execute) => {
    let closed = false
    let snapshot: MediaSnapshot | null = null
    const listeners = new Set<(snapshot: MediaSnapshot) => void>()
    const command = async (action: Parameters<MediaExecutor>[0]) => {
      if (closed) throw new Error('Media player disposed')
      const result = await execute(action)
      if (result.status === 'observed' && snapshot) {
        snapshot = { ...snapshot, state: result.state, primary: action.type === 'play' || snapshot.primary }
        listeners.forEach(listener => listener(snapshot!))
      }
      return { status: result.status, commandId: 'test', target: snapshot!.target }
    }
    const player: ExternalPlayer = {
      sourceId: options.id, sessionId: `external-${mediaPlayers.length}`,
      load: vi.fn(async descriptor => {
        snapshot = { descriptor, target: { sessionId: player.sessionId, realmGeneration: 1, sessionGeneration: 1, sourceGeneration: (snapshot?.target.sourceGeneration ?? 0) + 1 },
          revision: 0, primary: false, effectiveGain: 1, sampleAgeMs: 0,
          state: { status: 'paused', positionSeconds: 0, durationSeconds: null, rate: 1, volume: 1, muted: false },
          capabilities: { seek: false, rate: false, next: false, previous: false } }
        return snapshot
      }),
      observe: vi.fn(async (state, capabilities) => { if (snapshot) snapshot = { ...snapshot, state, capabilities: capabilities ?? snapshot.capabilities } }),
      updateMetadata: vi.fn(async patch => { if (snapshot) snapshot = { ...snapshot, descriptor: { ...snapshot.descriptor, ...patch } }; return snapshot }),
      getSnapshot: async () => snapshot,
      onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      onAction: () => () => {},
      prepareNext: async () => {},
      unload: vi.fn(async () => { const previous = snapshot; snapshot = null; return previous }),
      play: () => command({ type: 'play' }), pause: () => command({ type: 'pause' }), stop: () => command({ type: 'stop' }),
      toggle: () => command({ type: snapshot?.state.status === 'playing' ? 'pause' : 'play' }),
      seek: seconds => command({ type: 'seek', seconds }), setRate: rate => command({ type: 'setRate', rate }),
      setVolume: volume => command({ type: 'setVolume', volume }), setMuted: muted => command({ type: 'setMuted', muted }),
      dispose: vi.fn(async () => { if (closed) return; if (snapshot) await command({ type: 'pause' }); closed = true; listeners.clear() })
    }
    mediaPlayers.push(player)
    return player
  })
  return { ...mock, mediaPlayers, storage }
}
