import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { createWebMedia } from './media'
import { createUiText } from './localization'

export function createGuestLifetime(api: ValleyPluginApi, options: {
  instanceId: string
  guestId: string
  profileId: string
  current(): boolean
  page(): { url: string; title: string } | undefined
  audible(): boolean
  document(): number
}) {
  const text = createUiText(api)
  const work = new Set<Promise<unknown>>()
  let closed = false
  let disposal: Promise<void> | undefined
  const active = (): boolean => !closed && options.current()
  const run = <T,>(operation: () => Promise<T>): Promise<T> => {
    if (!active()) return Promise.reject(new Error(text('surfing.error.liveTab', { value: options.instanceId })))
    const accepted = (async () => operation())()
    work.add(accepted)
    void accepted.then(() => work.delete(accepted), () => work.delete(accepted))
    return accepted
  }
  const media = createWebMedia(api, {
    id: `web:${options.instanceId}`, active, document: options.document, page: options.page,
    execute: async script => {
      const accepted = api.drivers.browser.execute(options.guestId, script, false)
      work.add(accepted)
      try {
        const result = await accepted
        if (!result.ok) throw new Error(result.error)
        return result.data
      } finally { work.delete(accepted) }
    },
    mute: async muted => {
      const result = await api.drivers.browser.setAudioMuted(options.guestId, muted)
      if (!result.ok || result.data?.muted !== muted) throw new Error('Web audio output change was not confirmed')
    }
  })
  return {
    profileId: options.profileId,
    active,
    run,
    message: media.message,
    ready(playing?: boolean): void { void media.sync(true, playing) },
    play(): void { void media.sync(true, true) },
    pause(): void { media.pause() },
    dispose(cleanup?: () => void | Promise<void>): Promise<void> {
      if (disposal) return disposal
      closed = true
      const stopped = Promise.resolve().then(() => cleanup?.())
      return disposal = (async () => {
        const cleanupResult = await Promise.allSettled([stopped, media.dispose()])
        while (work.size) await Promise.allSettled([...work])
        const result = await api.drivers.browser.close(options.guestId)
        if (!result.ok) throw new Error(result.error || text('surfing.error.liveTab', { value: options.instanceId }))
        if (cleanupResult[0].status === 'rejected') throw cleanupResult[0].reason
        if (cleanupResult[1].status === 'rejected') throw cleanupResult[1].reason
      })()
    }
  }
}

export type GuestLifetime = ReturnType<typeof createGuestLifetime>
