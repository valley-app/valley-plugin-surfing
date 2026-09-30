import { publishSurfingFileDetails } from './workspaceDetails'
import type { WebTabState } from './store'
import type { PluginBrowserGuestEvent, PluginFileView } from '@valley/plugin-sdk'
import type { TextFileWithBaseline } from '@valley/plugin-sdk/types'
import { React, api } from './runtime'
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

const ShortcutEditor: PluginFileView = ({ relPath, tab }) => {
  const { snap } = useWeb()
  const [detailsApi] = React.useState(() => api)
  const [profileId] = React.useState(snap.activeProfileId)
  const [partition] = React.useState(() => partitionFor(profileId))
  const [details, setDetails] = React.useState<WebTabState>({ url: '', title: '', profileId })
  React.useEffect(() => publishSurfingFileDetails(detailsApi, { instanceId: tab?.id, filePath: relPath }, details), [detailsApi, tab?.id, relPath, details])
  const [file, setFile] = React.useState<TextFileWithBaseline | null>(null)
  const [draft, setDraft] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [browserReady, setBrowserReady] = React.useState(false)
  const [browserError, setBrowserError] = React.useState('')
  const state = React.useRef({ active: false, dirty: false, saving: false, revision: 0, refresh: false })
  const savedUrl = file ? readShortcutUrl(file.content) : ''
  React.useEffect(() => { setDetails({ url: savedUrl, title: '', profileId }) }, [savedUrl, profileId])

  const load = React.useCallback(async () => {
    const revision = ++state.current.revision
    setLoading(true)
    try {
      const next = await api.vault.readFileBaseline(relPath)
      if (!state.current.active || revision !== state.current.revision) return
      if (!next) throw new Error(uiText('surfing.shortcut.readError'))
      setFile(next)
      setDraft(readShortcutUrl(next.content))
      state.current.dirty = false
      setError('')
    } catch {
      if (state.current.active && revision === state.current.revision) setError(uiText('surfing.shortcut.readError'))
    } finally {
      if (state.current.active && revision === state.current.revision) setLoading(false)
    }
  }, [relPath])

  React.useEffect(() => {
    state.current.active = true
    void load()
    const off = api.vault.onChanged(info => {
      if (!info.full && !info.changes.some(change => change.relPath === relPath)) return
      if (state.current.saving) { state.current.refresh = true; return }
      if (!state.current.dirty) void load()
    })
    return () => { state.current.active = false; state.current.revision++; off() }
  }, [relPath, load])

  React.useEffect(() => {
    let active = true
    void api.backend.call('filter.prepare', { partition }).then(() => {
      if (active) setBrowserReady(true)
    }).catch(() => { if (active) setBrowserError(uiText('surfing.shortcut.browserError')) })
    return () => { active = false }
  }, [partition])

  const save = async () => {
    if (!file || loading || state.current.saving) return
    const url = draft.trim()
    if (!isWebUrl(url)) { setError(uiText('surfing.shortcut.invalid')); return }
    state.current.saving = true
    setSaving(true)
    setError('')
    try {
      const content = writeShortcutUrl(file.content, url)
      const result = await api.vault.writeFileGuarded(relPath, content, file.baseline)
      if (!state.current.active) return
      if (!result.ok) {
        setError(uiText(result.reason === 'conflict' ? 'surfing.shortcut.conflict' : 'surfing.shortcut.saveError'))
        return
      }
      setFile({ content, baseline: result.baseline })
      setDraft(url)
      state.current.dirty = false
    } catch {
      if (state.current.active) setError(uiText('surfing.shortcut.saveError'))
    } finally {
      state.current.saving = false
      if (state.current.active) {
        setSaving(false)
        if (state.current.refresh && !state.current.dirty) void load()
      }
      state.current.refresh = false
    }
  }

  return <div className="web-page">
    <form className="web-toolbar" onSubmit={event => { event.preventDefault(); void save() }}>
      <input className="web-address" aria-label={uiText('surfing.shortcut.address')} placeholder="https://example.com"
        value={draft} spellCheck={false} disabled={loading || saving || !file}
        onChange={event => { setDraft(event.target.value); state.current.dirty = event.target.value !== savedUrl }} />
      <button className="web-link-btn" type="submit" disabled={loading || saving || !file || draft === savedUrl}>{uiText('surfing.shortcut.save')}</button>
      <button className="web-link-btn" type="button" disabled={loading || saving} onClick={() => { void load() }}>{uiText('surfing.shortcut.reload')}</button>
    </form>
    {error && <div className="web-shortcut-message" role="alert">{error}</div>}
    <div className="web-host">
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
