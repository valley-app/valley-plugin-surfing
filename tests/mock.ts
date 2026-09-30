import { createMockValleyApi as createApi } from '@valley/plugin-testkit'
import { vi } from 'vitest'
import type { ValleyPluginApi } from '@valley/plugin-sdk'

type ExternalPlayer = Awaited<ReturnType<ValleyPluginApi['playback']['createExternalPlayer']>>
type MediaSnapshot = NonNullable<Awaited<ReturnType<ExternalPlayer['getSnapshot']>>>
type MediaExecutor = Parameters<ValleyPluginApi['playback']['createExternalPlayer']>[1]

export function createMockValleyApi(options: Parameters<typeof createApi>[0] = {}) {
  const mock = createApi({ ...options, manifest: { id: 'surfing', ...options.manifest } })
  mock.api.ui.ContentLoader = ({ label }) => mock.api.React.createElement('span', { role: 'status', 'aria-label': label }, label)
  vi.mocked(mock.api.backend.call).mockImplementation(async () => ({ styles: '', scripts: [] }) as never)
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
        snapshot = { descriptor, target: { sessionId: player.sessionId, vaultGeneration: 1, sessionGeneration: 1, sourceGeneration: (snapshot?.target.sourceGeneration ?? 0) + 1 },
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
      play: () => command({ type: 'play' }), pause: () => command({ type: 'pause' }), stop: () => command({ type: 'stop' }),
      toggle: () => command({ type: snapshot?.state.status === 'playing' ? 'pause' : 'play' }),
      seek: seconds => command({ type: 'seek', seconds }), setRate: rate => command({ type: 'setRate', rate }),
      setVolume: volume => command({ type: 'setVolume', volume }), setMuted: muted => command({ type: 'setMuted', muted }),
      dispose: vi.fn(async () => { if (closed) return; await command({ type: 'pause' }); closed = true; listeners.clear() })
    }
    mediaPlayers.push(player)
    return player
  })
  return { ...mock, mediaPlayers }
}
