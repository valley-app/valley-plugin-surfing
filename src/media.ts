import type { ValleyPluginApi } from '@valley/plugin-sdk'

type Player = Awaited<ReturnType<ValleyPluginApi['playback']['createExternalPlayer']>>
type Action = Parameters<Parameters<ValleyPluginApi['playback']['createExternalPlayer']>[1]>[0]
type Result = Awaited<ReturnType<Parameters<ValleyPluginApi['playback']['createExternalPlayer']>[1]>>
type State = Parameters<Player['observe']>[0]
type Capabilities = NonNullable<Parameters<Player['observe']>[1]>

interface Sample {
  title: string
  source: string
  state: State
  capabilities: Capabilities
}

const READ_STATE = `const duration = Number.isFinite(active.duration) && active.duration > 0 ? active.duration : null;
const position = Number.isFinite(active.currentTime) ? Math.max(0, Math.min(active.currentTime, duration ?? Infinity)) : 0;
return { title: document.title || location.hostname, source: active.currentSrc || active.src || '',
  state: { status: active.error ? 'error' : active.ended ? 'ended' : active.seeking ? 'seeking' : active.paused ? 'paused' : active.readyState < 3 ? 'buffering' : 'playing',
    positionSeconds: position, durationSeconds: duration, rate: active.playbackRate, volume: active.volume, muted: active.muted },
  capabilities: { seek: duration !== null && active.seekable.length > 0, rate: Number.isFinite(active.playbackRate), next: false, previous: false } };`

export const WEB_MEDIA_SAMPLE = `(preferred => {
  const media = [...document.querySelectorAll('video,audio')];
  const active = media.find(element => !element.paused && !element.ended) || media.find(element => (element.currentSrc || element.src || '') === preferred) || media[0];
  if (!active) return null;
  ${READ_STATE}
})`
export const WEB_MEDIA_PAUSE = `document.querySelectorAll('video,audio').forEach(element => element.pause())`

function sample(value: unknown): Sample | null {
  if (!value || typeof value !== 'object') return null
  const result = value as Partial<Sample>
  const state = result.state
  if (!state || typeof result.source !== 'string' || typeof result.title !== 'string' || !result.capabilities
    || !['playing', 'paused', 'buffering', 'seeking', 'ended', 'error', 'stopped'].includes(state.status)
    || !Number.isFinite(state.positionSeconds) || state.positionSeconds < 0
    || state.durationSeconds !== null && (!Number.isFinite(state.durationSeconds) || state.durationSeconds < 0)
    || !Number.isFinite(state.rate) || state.rate < 0.25 || state.rate > 4
    || !Number.isFinite(state.volume) || state.volume < 0 || state.volume > 1 || typeof state.muted !== 'boolean'
    || !['seek', 'rate', 'next', 'previous'].every(key => typeof result.capabilities?.[key as keyof Capabilities] === 'boolean')) return null
  return result as Sample
}

export function createWebMedia(api: ValleyPluginApi, options: {
  id: string
  active(): boolean
  document(): number
  page(): { url: string; title?: string } | undefined
  execute(script: string): Promise<unknown>
  mute(muted: boolean): Promise<void>
}) {
  let player: Player | undefined
  let opening: Promise<Player> | undefined
  let last: Sample | null = null
  let loadedDocument = -1
  let loadedSource = ''
  let serial = 0
  let closed = false
  let disposal: Promise<void> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let sampling: Promise<void> | undefined
  let pendingClaim = false
  let opaque = false
  let opaquePaused = false
  let opaqueMuted = false
  let opaqueGainMuted = false
  let outputMuted = true
  let granted = false
  let hintedPlaying = false
  let watchedDocument = -1
  const marker = `__valley_media_${crypto.randomUUID().replaceAll('-', '')}`
  const active = () => !closed && options.active()
  const clearTimer = () => { if (timer !== undefined) clearInterval(timer); timer = undefined }
  const output = async (muted: boolean) => { await options.mute(muted); outputMuted = muted }
  const fallback = (): Sample => ({
    title: options.page()?.title ?? 'Web audio', source: 'opaque',
    state: { status: outputMuted || !hintedPlaying ? 'paused' : 'playing', positionSeconds: 0, durationSeconds: null, rate: 1, volume: 1, muted: outputMuted },
    capabilities: { seek: false, rate: false, next: false, previous: false }
  })

  const execute = async (action: Action): Promise<Result> => {
    if (closed) {
      if (action.type !== 'pause' && action.type !== 'stop') return { status: 'failed', error: 'Web media surface closed' }
      try { await output(true); return { status: 'observed', state: { ...(last?.state ?? fallback().state), status: 'paused', muted: true } } }
      catch { return { status: 'unknown', error: 'Web media silence was not confirmed' } }
    }
    if (!options.active() || loadedDocument !== options.document()) return { status: 'failed', error: 'Web media document changed' }
    if (['next', 'previous', 'setAudioTrack'].includes(action.type) || action.type === 'seek' && !last?.capabilities.seek || action.type === 'setRate' && !last?.capabilities.rate) return { status: 'failed', error: 'This web player does not support that control' }
    if (action.type === 'pause' || action.type === 'stop') { pendingClaim = false; clearTimer() }
    try {
      if (opaque) {
        if (action.type === 'pause' || action.type === 'stop') opaquePaused = true
        if (action.type === 'play') opaquePaused = false
        if (action.type === 'setMuted') opaqueMuted = action.muted
        if (action.type === 'setVolume') opaqueGainMuted = action.volume === 0
        if (action.type === 'play') granted = true
        if (action.type === 'pause' || action.type === 'stop') granted = false
        await output(!granted || opaquePaused || opaqueMuted || opaqueGainMuted)
        last = fallback()
        return { status: 'observed', state: last.state }
      }
      if (action.type === 'pause' || action.type === 'stop') { granted = false; await output(true) }
      const capturedDocument = options.document()
      const script = `(async () => {
        const media = [...document.querySelectorAll('video,audio')];
        const active = media.find(element => (element.currentSrc || element.src || '') === ${JSON.stringify(loadedSource)});
        if (!active) return { stale: true };
        const action = ${JSON.stringify(action)};
        if (action.type === 'play') await active.play();
        else if (action.type === 'pause' || action.type === 'stop') { media.forEach(element => element.pause()); if (action.type === 'stop') active.currentTime = 0; }
        else if (action.type === 'seek') {
          active.currentTime = Math.min(action.seconds, Number.isFinite(active.duration) ? active.duration : Infinity);
          if (active.seeking) await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { active.removeEventListener('seeked', done); reject(new Error('Seek confirmation timed out')); }, 8000);
            const done = () => { clearTimeout(timer); resolve(); }; active.addEventListener('seeked', done, { once: true });
          });
        }
        else if (action.type === 'setRate') active.playbackRate = action.rate;
        else if (action.type === 'setVolume') media.forEach(element => { element.volume = action.volume; });
        else if (action.type === 'setMuted') media.forEach(element => { element.muted = action.muted; });
        return (() => { ${READ_STATE} })();
      })()`
      const value = await options.execute(script)
      if (capturedDocument !== options.document() || !active()) return { status: 'unknown', error: 'Web media document changed after command dispatch' }
      if (value && typeof value === 'object' && 'stale' in value) return { status: 'failed', error: 'Web media source changed before command execution' }
      const observed = sample(value)
      if (!observed) return { status: 'unknown', error: 'Web media command confirmation is unavailable' }
      last = observed
      if (action.type === 'play') { granted = true; await output(false) }
      return { status: 'observed', state: observed.state }
    } catch { return { status: 'unknown', error: 'Web media command outcome is unknown; it was not retried' } }
  }

  const ensure = () => opening ??= api.playback.createExternalPlayer({ id: options.id }, execute).then(value => { player = value; return value })
  const sync = (claim = false, playingHint?: boolean): Promise<void> => {
    if (!active()) return Promise.resolve()
    if (playingHint !== undefined) hintedPlaying = playingHint
    pendingClaim ||= claim && (!granted || loadedDocument !== options.document() || last?.state.status !== 'playing' && last?.state.status !== 'buffering')
    if (sampling) return sampling
    const generation = options.document()
    sampling = (async () => {
      if (watchedDocument !== generation) {
        await options.execute(`(() => {
          const key = ${JSON.stringify(marker)};
          globalThis[key]?.abort();
          const controller = globalThis[key] = new AbortController();
          for (const type of ['playing', 'pause', 'ended', 'waiting', 'seeking', 'seeked', 'ratechange', 'durationchange', 'volumechange', 'error']) {
            document.addEventListener(type, event => { if (event.target instanceof HTMLMediaElement) console.debug(key + ':' + type); }, { capture: true, signal: controller.signal });
          }
        })()`)
        if (!active() || generation !== options.document()) return
        watchedDocument = generation
      }
      let observed = sample(await options.execute(`${WEB_MEDIA_SAMPLE}(${JSON.stringify(loadedSource)})`))
      if (!active() || generation !== options.document()) return
      opaque = !observed
      if (!observed && !hintedPlaying && !player) return
      observed ??= { ...fallback(), state: { ...fallback().state, status: hintedPlaying ? 'playing' : 'paused', muted: opaqueMuted } }
      last = observed
      const handle = await ensure()
      if (!active() || generation !== options.document()) return
      if (loadedDocument !== generation || loadedSource !== observed.source) {
        granted = false
        await output(true)
        if (!active() || generation !== options.document()) return
        loadedDocument = generation
        loadedSource = observed.source
        const page = options.page()
        await handle.load({ key: `${options.id}:${++serial}`, providerId: api.pluginId, sourceId: options.id, kind: 'audio', path: page?.url ?? '', title: observed.title || page?.title || 'Web audio', artists: [], feat: [], restorationData: { outputControl: opaque ? 'mute' : 'volume' } }, { autoplay: false })
      }
      if (!active() || generation !== options.document()) return
      await handle.observe(granted ? observed.state : { ...observed.state, status: 'paused' }, observed.capabilities)
      if (pendingClaim && (observed.state.status === 'playing' || observed.state.status === 'buffering') && !observed.state.muted) {
        pendingClaim = false
        const receipt = await handle.play()
        if (receipt.status !== 'observed') { await output(true); clearTimer(); return }
      }
      if ((observed.state.status === 'playing' || observed.state.status === 'buffering') && timer === undefined) timer = setInterval(() => { void sync() }, 1000)
      else if (observed.state.status !== 'playing' && observed.state.status !== 'buffering') clearTimer()
    })().catch(() => {}).finally(() => { sampling = undefined })
    return sampling
  }
  return {
    sync,
    message(value?: string): void {
      if (!value?.startsWith(marker) || !active()) return
      const claim = value === `${marker}:playing` || value === `${marker}:volumechange`
      if (sampling) void sampling.then(() => sync(claim))
      else void sync(claim)
    },
    pause(): void { hintedPlaying = false; pendingClaim = false; clearTimer(); void sync(false, false) },
    dispose(): Promise<void> {
      if (disposal) return disposal
      closed = true
      pendingClaim = false
      clearTimer()
      return disposal = (async () => {
        await output(true)
        if (!opening) return
        await options.execute(`${WEB_MEDIA_PAUSE}; globalThis[${JSON.stringify(marker)}]?.abort(); delete globalThis[${JSON.stringify(marker)}]`).catch(() => {})
        await sampling
        const handle = player ?? await opening
        await handle.dispose()
      })()
    }
  }
}
