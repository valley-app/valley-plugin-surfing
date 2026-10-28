import { publishSurfingFileDetails } from './workspaceDetails'
import type { WebTabState } from './store'
import type { PluginBrowserGuestEvent, PluginFileView } from '@valley/plugin-sdk'
import type { TextFileWithBaseline } from '@valley/plugin-sdk/types'
import { React, api } from './runtime'
import { useSurfingFileCommands } from './fileCommands'
import { useWeb } from './hooks'
import { partitionFor } from './profiles'
import { uiText } from './localization'
import { createWebMedia } from './media'

function ShortcutGuest({ src, partition, onEvent }: { src: string; partition: string; onEvent(event: PluginBrowserGuestEvent): void }): React.ReactElement {
  const [entry] = React.useState(() => {
    const instanceId = `shortcut-${crypto.randomUUID()}`
    let guestId: string | undefined, document = 0, current = true
    const media = createWebMedia(api, {
      id: instanceId, active: () => current && !!guestId, document: () => document, page: () => ({ url: src }),
      execute: async script => {
        if (!guestId) throw new Error('Web shortcut is unavailable')
        const result = await api.drivers.browser.execute(guestId, script)
        if (!result.ok) throw new Error(result.error)
        return result.data
      },
      mute: async muted => {
        if (!guestId) return
        const result = await api.drivers.browser.setAudioMuted(guestId, muted)
        if (!result.ok || result.data?.muted !== muted) throw new Error('Web audio output change was not confirmed')
      }
    })
    return {
      instanceId,
      event(event: PluginBrowserGuestEvent) {
        if (!current) return
        if (event.guestId) guestId = event.guestId
        if (event.type === 'ready' || event.type === 'navigate') document++
        if (event.type === 'ready') void media.sync(true, event.playing)
        if (event.type === 'media') { if (event.playing) void media.sync(true, true); else media.pause() }
        if (event.type === 'console') media.message(event.message)
      },
      async dispose() {
        current = false
        try { await media.dispose() } finally { if (guestId) await api.drivers.browser.close(guestId) }
      }
    }
  })
  React.useEffect(() => () => { void entry.dispose().catch(() => {}) }, [entry])
  return <api.ui.BrowserGuest instanceId={entry.instanceId} src={src} partition={partition} requestFilter="filter.request" audioManaged onEvent={event => { entry.event(event); onEvent(event) }} />
}

function shortcutFields(content: string) {
  const parts = content.split(/(\r\n|\n|\r)/)
  const urls: number[] = []
  let section = false
  let header = -1
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index].trim()
    if (/^\[.*\]$/.test(line)) {
      section = /^\[InternetShortcut\]$/i.test(line)
      if (section && header < 0) header = index
    } else if (section && /^URL\s*=/i.test(line)) urls.push(index)
  }
  return { parts, urls, header }
}

export function readShortcutUrl(content: string): string {
  const { parts, urls } = shortcutFields(content)
  return urls.length ? parts[urls[0]].slice(parts[urls[0]].indexOf('=') + 1).trim() : ''
}

export function isWebUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false
  try { return !!new URL(value).hostname } catch { return false }
}

export function writeShortcutUrl(content: string, value: string): string {
  const url = value.trim()
  if (!isWebUrl(url)) throw new Error(uiText('surfing.shortcut.invalid'))
  const { parts, urls, header } = shortcutFields(content)
  if (urls.length) {
    for (const index of urls) parts[index] = parts[index].replace(/^(\s*URL\s*=\s*).*?(\s*)$/i, (_line, prefix, suffix) => `${prefix}${url}${suffix}`)
    return parts.join('')
  }
  const newline = parts[1] || '\r\n'
  if (header >= 0) {
    if (parts[header + 1]) parts.splice(header + 2, 0, `URL=${url}`, newline)
    else parts.push(newline, `URL=${url}`, newline)
    return parts.join('')
  }
  return `${content}${content && !/[\r\n]$/.test(content) ? newline : ''}[InternetShortcut]${newline}URL=${url}${newline}`
}

const ShortcutEditor: PluginFileView = ({ relPath, tab, mountedView }) => {
  const { snap } = useWeb()
  const [detailsApi] = React.useState(() => api)
  const [profileId] = React.useState(snap.activeProfileId)
  const [partition] = React.useState(() => partitionFor(profileId))
  const [details, setDetails] = React.useState<WebTabState>({ url: '', title: '', profileId })
  React.useEffect(() => publishSurfingFileDetails(detailsApi, { instanceId: tab?.id, filePath: relPath }, details), [detailsApi, tab?.id, relPath, details])
  const [file, setFile] = React.useState<TextFileWithBaseline | null>(null)
  const [draft, setDraft] = React.useState('')
  const draftValue = React.useRef(draft)
  draftValue.current = draft
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [browserReady, setBrowserReady] = React.useState(false)
  const [browserError, setBrowserError] = React.useState('')
  const [prepared, setPrepared] = React.useState(false)
  const state = React.useRef({ active: false, dirty: false, saving: false, loaded: false, uncertain: false, revision: 0, refresh: false, fences: 0 })
  const draftListeners = React.useRef(new Set<() => void>())
  const mountedKey = mountedView ? JSON.stringify([mountedView.mountId, mountedView.generation, mountedView.area, mountedView.paneId, mountedView.tabId, mountedView.filePath, mountedView.pluginId]) : ''
  const mounted = React.useRef(mountedView)
  mounted.current = mountedView
  const announceDraft = React.useCallback(() => { for (const listener of draftListeners.current) listener() }, [])
  const savedUrl = file ? readShortcutUrl(file.content) : ''
  React.useEffect(() => { setDetails({ url: savedUrl, title: '', profileId }) }, [savedUrl, profileId])

  const load = React.useCallback(async () => {
    if (!state.current.active) return
    if (state.current.fences) { state.current.refresh = true; return }
    const revision = ++state.current.revision
    state.current.loaded = false
    state.current.uncertain = false
    announceDraft()
    setLoading(true)
    try {
      const next = await api.vault.readFileBaseline(relPath)
      if (!state.current.active || revision !== state.current.revision) return
      if (!next) throw new Error(uiText('surfing.shortcut.readError'))
      setFile(next)
      setDraft(readShortcutUrl(next.content))
      draftValue.current = readShortcutUrl(next.content)
      state.current.dirty = false
      state.current.loaded = true
      setError('')
    } catch {
      if (state.current.active && revision === state.current.revision) { state.current.uncertain = true; setError(uiText('surfing.shortcut.readError')) }
    } finally {
      if (state.current.active && revision === state.current.revision) { setLoading(false); announceDraft() }
    }
  }, [relPath, announceDraft])

  React.useEffect(() => {
    state.current.active = true
    void load()
    const off = api.vault.onChanged(info => {
      if (!info.full && !info.changes.some(change => change.relPath === relPath)) return
      if (state.current.saving || state.current.fences) { state.current.refresh = true; return }
      if (!state.current.dirty) void load()
    })
    return () => { state.current.active = false; state.current.revision++; off() }
  }, [relPath, load])

  React.useEffect(() => {
    const view = mounted.current
    if (!view) return
    const snapshot = () => ({ revision: String(state.current.revision), dirty: state.current.dirty, readiness: state.current.uncertain ? 'uncertain' as const : state.current.saving ? 'saving' as const : state.current.loaded ? 'ready' as const : 'loading' as const })
    return api.vault.editors.register(view, {
      getSnapshot: snapshot,
      subscribe: listener => { draftListeners.current.add(listener); return () => { draftListeners.current.delete(listener) } },
      prepare: (expected, request) => {
        const observed = snapshot()
        if (!state.current.active || observed.revision !== expected || observed.dirty && !request.ownSave || observed.readiness !== 'ready' && !(request.ownSave && observed.readiness === 'saving')) throw new Error('The shortcut draft changed before preparation')
        state.current.fences++
        setPrepared(true)
        let released = false
        return { validate: snapshot, release: () => {
          if (released) return
          released = true
          state.current.fences--
          if (!state.current.fences && state.current.active) {
            setPrepared(false)
            if (state.current.refresh && !state.current.dirty && !state.current.saving) { state.current.refresh = false; void load() }
          }
        } }
      }
    })
  }, [mountedKey, load])

  React.useEffect(() => {
    let active = true
    void api.backend.call('filter.prepare', { partition }).then(() => {
      if (active) setBrowserReady(true)
    }).catch(() => { if (active) setBrowserError(uiText('surfing.shortcut.browserError')) })
    return () => { active = false }
  }, [partition])

  const save = async (validateBeforeEffect?: () => Promise<void>) => {
    if (!state.current.active || !file || loading || state.current.saving || state.current.fences) { if (validateBeforeEffect) throw Object.assign(new Error('The exact shortcut editor is unavailable.'), { outcome: 'not-applied' }); return }
    const url = draft.trim()
    if (!isWebUrl(url)) { setError(uiText('surfing.shortcut.invalid')); if (validateBeforeEffect) throw Object.assign(new Error('Expected a valid HTTP or HTTPS shortcut URL.'), { outcome: 'not-applied' }); return }
    state.current.saving = true
    const revision = String(state.current.revision)
    announceDraft()
    setSaving(true)
    setError('')
    try {
      const content = writeShortcutUrl(file.content, url)
      await validateBeforeEffect?.()
      if (!state.current.active || state.current.fences || String(state.current.revision) !== revision) throw Object.assign(new Error('The shortcut draft changed before saving.'), { outcome: 'not-applied' })
      const result = mountedView
        ? await api.vault.editors.save(mountedView, content, file.baseline, revision)
        : await api.vault.writeFileGuarded(relPath, content, file.baseline)
      if (!state.current.active) { if (validateBeforeEffect) throw new Error('The shortcut view disappeared after its save was dispatched.'); return }
      if (!result.ok) {
        setError(uiText(result.reason === 'conflict' ? 'surfing.shortcut.conflict' : 'surfing.shortcut.saveError'))
        if (validateBeforeEffect) throw new Error('The shortcut save was not confirmed; its raw draft is retained.')
        return
      }
      setFile({ content, baseline: result.baseline })
      setDraft(url)
      draftValue.current = url
      state.current.dirty = false
    } catch (cause) {
      if (state.current.active) setError(uiText('surfing.shortcut.saveError'))
      if (validateBeforeEffect) throw cause
    } finally {
      state.current.saving = false
      announceDraft()
      if (state.current.active) {
        setSaving(false)
        if (state.current.refresh && !state.current.dirty) void load()
      }
      state.current.refresh = false
    }
  }
  const changeDraft = (value: string): void => { if (!state.current.active || state.current.fences || state.current.saving || !state.current.loaded) throw Object.assign(new Error('The shortcut draft is unavailable or frozen.'), { outcome: 'not-applied' }); draftValue.current = value; setDraft(value); state.current.dirty = value !== savedUrl; state.current.revision++; announceDraft() }
  useSurfingFileCommands(mountedView, {
    snapshot: () => ({ kind: 'shortcut', loading: !state.current.loaded, saving: state.current.saving, prepared: state.current.fences > 0, draft: draftValue.current, savedUrl, editorRevision: state.current.revision, dirty: state.current.dirty, uncertain: state.current.uncertain }),
    run: async (action, validate) => {
      if (action.type === 'draft') changeDraft(action.value)
      else if (action.type === 'save') await save(validate)
      else if (action.type === 'reload') { if (!state.current.active || state.current.fences || state.current.saving) throw Object.assign(new Error('The shortcut cannot be reloaded now.'), { outcome: 'not-applied' }); await validate(); await load() }
      else throw Object.assign(new Error('This control is unavailable for Internet shortcuts.'), { outcome: 'not-applied' })
    }
  })

  return <div className="web-page web-shortcut">
    <form className="web-toolbar" onSubmit={event => { event.preventDefault(); void save() }}>
      <input className="web-address" aria-label={uiText('surfing.shortcut.address')} placeholder="https://example.com"
        value={draft} spellCheck={false} disabled={loading || saving || !file}
        readOnly={prepared}
        onChange={event => { if (!state.current.active || state.current.fences || state.current.saving || !state.current.loaded) return; changeDraft(event.target.value) }} />
      <button className="web-link-btn web-shortcut-action" type="submit" aria-label={uiText('surfing.shortcut.save')} title={uiText('surfing.shortcut.save')} disabled={loading || saving || prepared || !file || draft === savedUrl}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
        <span>{uiText('surfing.shortcut.save')}</span>
      </button>
      <button className="web-link-btn web-shortcut-action" type="button" aria-label={uiText('surfing.shortcut.reload')} title={uiText('surfing.shortcut.reload')} disabled={loading || saving || prepared} onClick={() => { void load() }}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
        <span>{uiText('surfing.shortcut.reload')}</span>
      </button>
    </form>
    {error && <div className="web-shortcut-message" role="alert">{error}</div>}
    <div className="web-host" data-plugin-widget-layout="fill">
      {loading ? <api.ui.ContentLoader label={uiText('surfing.embed.loading')} />
        : !file ? null
        : !isWebUrl(savedUrl) ? <div className="web-shortcut-message" role="status">{uiText('surfing.shortcut.invalid')}</div>
        : browserError ? <div className="web-shortcut-message" role="alert">{browserError}</div>
        : browserReady ? <ShortcutGuest key={savedUrl} src={savedUrl} partition={partition} onEvent={event => { setDetails(current => ({ ...current, ...(event.url ? { url: event.url } : {}), ...(event.title ? { title: event.title } : {}), ...(event.connection ? { connection: event.connection } : {}) })) }} />
        : <api.ui.ContentLoader label={uiText('surfing.embed.loading')} />}
    </div>
  </div>
}

export const UrlFileView: PluginFileView = props => <ShortcutEditor key={props.relPath} {...props} />
