import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebMedia, WEB_MEDIA_SAMPLE } from '../src/media'
import { createMockValleyApi } from './mock'

const observation = () => ({ title: 'Canopy', source: 'https://media.example.test/canopy.mp4',
  state: { status: 'playing', positionSeconds: 12, durationSeconds: 240, rate: 1, volume: 0.8, muted: false },
  capabilities: { seek: true, rate: true, next: false, previous: false } })

function fixture(opaque = false) {
  const mock = createMockValleyApi()
  let generation = 0
  let active = true
  const execute = vi.fn(async (_script: string) => opaque ? null : observation())
  const mute = vi.fn(async () => {})
  const media = createWebMedia(mock.api, { id: 'web:canopy', active: () => active, document: () => generation,
    page: () => ({ url: 'https://example.test/canopy', title: 'Canopy' }), execute, mute })
  return { ...mock, media, execute, mute, navigate: () => { generation++ }, close: () => { active = false; return media.dispose() } }
}

afterEach(() => vi.useRealTimers())

describe('external web media adapter', () => {
  it('keeps discovery and unsolicited samples muted until an explicit play claim completes', async () => {
    const f = fixture()
    await f.media.sync()
    expect(f.mute).toHaveBeenLastCalledWith(true)
    expect(await f.mediaPlayers[0].getSnapshot()).toMatchObject({ primary: false, state: { status: 'paused' } })
    let release!: () => void, dispatched = false
    const gate = new Promise<void>(resolve => { release = resolve })
    f.execute.mockImplementation(async script => {
      if (script.includes('"type":"play"')) { dispatched = true; await gate }
      return observation()
    })
    const claiming = f.media.sync(true, true)
    await vi.waitFor(() => expect(dispatched).toBe(true))
    expect(f.mute).not.toHaveBeenCalledWith(false)
    release(); await claiming
    expect(f.mute).toHaveBeenLastCalledWith(false)
    await f.close()
  })

  it('silences native output before awaiting a DOM pause acknowledgement', async () => {
    const f = fixture()
    await f.media.sync(true, true)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.execute.mockImplementation(async script => {
      if (script.includes('"type":"pause"')) await gate
      return { ...observation(), state: { ...observation().state, status: 'paused' } }
    })
    const paused = f.mediaPlayers[0].pause()
    await vi.waitFor(() => expect(f.mute).toHaveBeenLastCalledWith(true))
    release(); await paused; await f.close()
  })

  it('publishes capabilities and one-second samples through the host player', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.media.sync(true, true)
    const player = f.mediaPlayers[0]
    expect(await player.getSnapshot()).toMatchObject({ primary: true, state: { status: 'playing', positionSeconds: 12 }, capabilities: { seek: true, rate: true, next: false } })
    f.execute.mockClear()
    await vi.advanceTimersByTimeAsync(2999)
    expect(f.execute.mock.calls.filter(call => call[0].startsWith(WEB_MEDIA_SAMPLE))).toHaveLength(2)
    await f.close()
    expect(f.mute).toHaveBeenLastCalledWith(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(f.execute.mock.calls.filter(call => call[0].startsWith(WEB_MEDIA_SAMPLE))).toHaveLength(2)
  })

  it('reports unknown after a lost command confirmation and never retries it', async () => {
    const f = fixture()
    await f.media.sync(true, true)
    f.execute.mockRejectedValueOnce(new Error('guest disappeared'))
    expect(await f.mediaPlayers[0].seek(30)).toMatchObject({ status: 'unknown' })
    expect(f.execute.mock.calls.filter(call => String(call[0]).includes('"type":"seek"'))).toHaveLength(1)
    await f.close()
  })

  it('publishes media event boundaries immediately without waiting for a periodic sample', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.media.sync(true, true)
    const watch = f.execute.mock.calls.find(call => call[0].includes('AbortController'))?.[0] ?? ''
    const marker = watch.match(/const key = "([^"]+)"/)?.[1]
    expect(marker).toBeTruthy()
    f.execute.mockResolvedValueOnce({ ...observation(), state: { ...observation().state, status: 'paused', positionSeconds: 40 } })
    f.media.message(marker)
    await vi.waitFor(async () => expect(await f.mediaPlayers[0].getSnapshot()).toMatchObject({ state: { status: 'paused', positionSeconds: 40 } }))
    f.execute.mockClear()
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.execute).not.toHaveBeenCalled()
    await f.close()
  })

  it('rejects a stale document command before executing JavaScript', async () => {
    const f = fixture()
    await f.media.sync(true, true)
    f.navigate()
    f.execute.mockClear()
    expect(await f.mediaPlayers[0].seek(30)).toMatchObject({ status: 'failed' })
    expect(f.execute).not.toHaveBeenCalled()
    await f.close()
  })

  it('silences opaque audio through the native guest and never advertises seek or rate', async () => {
    const f = fixture(true)
    await f.media.sync(true, true)
    const player = f.mediaPlayers[0]
    expect(await player.getSnapshot()).toMatchObject({ capabilities: { seek: false, rate: false } })
    await player.setVolume(0.8)
    expect(f.mute).toHaveBeenLastCalledWith(false)
    await player.setVolume(0.16)
    expect(f.mute).toHaveBeenLastCalledWith(false)
    expect(await player.getSnapshot()).toMatchObject({ descriptor: { restorationData: { outputControl: 'mute' } }, state: { volume: 1 } })
    expect(await player.seek(30)).toMatchObject({ status: 'failed' })
    expect(await player.pause()).toMatchObject({ status: 'observed' })
    expect(f.mute).toHaveBeenLastCalledWith(true)
    expect(await player.getSnapshot()).toMatchObject({ state: { status: 'paused', muted: true } })
    await player.setVolume(0.8)
    expect(f.mute).toHaveBeenLastCalledWith(true)
    await f.close()
  })

  it('silences a closing surface immediately while source discovery is still pending', async () => {
    const f = fixture()
    let resolve!: (value: ReturnType<typeof observation>) => void
    f.execute.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const sampling = f.media.sync(true, true)
    const disposing = f.close()
    await disposing
    expect(f.mute).toHaveBeenCalledWith(true)
    resolve(observation())
    await sampling
    expect(f.mediaPlayers).toHaveLength(0)
  })
})
