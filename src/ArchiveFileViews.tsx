import type { PluginFileView } from '@valley/plugin-sdk'
import { valleyCancellationOf } from '@valley/plugin-sdk/valleyCancellation'
import { React, api } from './runtime'
import { uiText } from './localization'
import { ARCHIVE_MAX_BYTES, ArchiveError, fromBase64, parseHar, parseMhtml, harBody, type ArchiveFailure, type ArchiveReadResult, type HarEntry } from './archives'
import { archiveDocument } from './archivePreview'
import { readSurfingFileBookmark, subscribeSurfingFileBookmarks, updateSurfingFileBookmark } from './workspaceDetails'
import { useSurfingFileCommands } from './fileCommands'

export async function loadArchive(relPath: string, controller: AbortController): Promise<Uint8Array> {
  const cancellation = valleyCancellationOf(controller)
  let offset = 0
  let expected: { size: number; mtimeMs: number } | undefined
  let bytes: Uint8Array | undefined
  while (true) {
    cancellation.throwIfAborted()
    const result = await api.backend.callOperation<ArchiveReadResult | { error: ArchiveFailure }>('archive.readChunk', { relPath, offset, ...(expected ? { expected } : {}) }, { cancellation })
    cancellation.throwIfAborted()
    if ('error' in result) throw new ArchiveError(result.error)
    if (!Number.isSafeInteger(result.size) || result.size < 0 || result.size > ARCHIVE_MAX_BYTES) throw new ArchiveError('tooLarge')
    if (expected && (result.size !== expected.size || result.mtimeMs !== expected.mtimeMs)) throw new ArchiveError('changed')
    expected = { size: result.size, mtimeMs: result.mtimeMs }
    bytes ??= new Uint8Array(result.size)
    const chunk = fromBase64(result.base64)
    if (result.nextOffset !== offset + chunk.length || result.nextOffset > bytes.length || (!result.done && !chunk.length)) throw new ArchiveError('readError')
    bytes.set(chunk, offset)
    offset = result.nextOffset
    if (result.done) {
      if (offset !== bytes.length) throw new ArchiveError('changed')
      return bytes
    }
  }
}

function useArchive<T>(relPath: string, parse: (bytes: Uint8Array) => T) {
  const [state, setState] = React.useState<{ value?: T; error?: ArchiveFailure; loading: boolean; documentRevision: number }>({ loading: true, documentRevision: 0 })
  const generation = React.useRef(0)
  const [revision, reload] = React.useReducer(value => value + 1, 0)
  React.useEffect(() => {
    let active = true
    let controller: AbortController | undefined
    const read = async () => {
      controller?.abort()
      const request = new AbortController()
      controller = request
      const documentRevision = ++generation.current
      setState({ loading: true, documentRevision })
      try {
        const bytes = await loadArchive(relPath, request)
        if (active && !valleyCancellationOf(request).aborted) setState({ value: parse(bytes), loading: false, documentRevision })
      } catch (error) {
        if (active && !valleyCancellationOf(request).aborted) setState({ error: error instanceof ArchiveError ? error.code : 'readError', loading: false, documentRevision })
      }
    }
    void read()
    const off = api.realm.onChanged(info => {
      if (info.full || info.changes.some(change => change.relPath === relPath)) void read()
    })
    return () => { active = false; controller?.abort(); off() }
  }, [relPath, parse, revision])
  return { ...state, reload }
}

function ArchiveMessage({ loading, error }: { loading: boolean; error?: ArchiveFailure }) {
  return loading || error ? <div className="web-shortcut-message" role={error ? 'alert' : 'status'}>{uiText(error ? `surfing.archive.${error}` : 'surfing.embed.loading')}</div> : null
}

const parsePage = (bytes: Uint8Array): string => archiveDocument(parseMhtml(bytes))
const MhtmlView: PluginFileView = ({ relPath, mountedView }) => {
  const state = useArchive(relPath, parsePage)
  const cleanup = React.useRef<(() => void) | undefined>(undefined)
  const archiveDocumentRef = React.useRef<Document | null>(null), currentAnchor = React.useRef<string | null>(null)
  React.useLayoutEffect(() => () => { cleanup.current?.(); cleanup.current = undefined; archiveDocumentRef.current = null; currentAnchor.current = null }, [state.value])
  useSurfingFileCommands(mountedView, {
    snapshot: () => { const anchors = [...(archiveDocumentRef.current?.querySelectorAll('[id]') ?? [])].map(element => element.id); if (anchors.length > 1000) throw Object.assign(new Error('The complete MHTML anchor list exceeds its observation bound.'), { code: 'OUTPUT_TOO_LARGE', outcome: 'not-applied' }); return { kind: 'mhtml', loading: state.loading, error: state.error ?? null, documentRevision: state.documentRevision, anchors, currentAnchor: currentAnchor.current } },
    run: (action) => {
      if (action.type === 'reload') state.reload()
      else if (action.type === 'anchor') { const target = archiveDocumentRef.current?.getElementById(action.value); if (state.loading || state.error || !target) throw Object.assign(new Error('This exact loaded MHTML anchor is unavailable.'), { outcome: 'not-applied' }); target.scrollIntoView(); currentAnchor.current = action.value }
      else throw Object.assign(new Error('This control is unavailable for offline MHTML.'), { outcome: 'not-applied' })
    }
  })
  return <div className="web-page web-archive">
    <div className="web-toolbar"><span className="web-archive-label">{uiText('surfing.archive.offline')}</span><button className="web-link-btn" onClick={state.reload}>{uiText('surfing.shortcut.reload')}</button></div>
    <ArchiveMessage {...state} />
    {state.value !== undefined && <iframe className="web-archive-frame" title={uiText('surfing.archive.mhtml')} sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={state.value} onLoad={event => {
      cleanup.current?.()
      const doc = event.currentTarget.contentDocument
      if (!doc) return
      archiveDocumentRef.current = doc
      const navigate = (event: MouseEvent) => {
        const link = (event.target as Element | null)?.closest('a[href]')
        if (!link) return
        event.preventDefault()
        const href = link.getAttribute('href') ?? ''
        if (href.startsWith('#')) {
          try { const id = decodeURIComponent(href.slice(1)), target = doc.getElementById(id); if (target) { target.scrollIntoView(); currentAnchor.current = id } } catch { /* Invalid fragment. */ }
        }
      }
      doc.addEventListener('click', navigate)
      cleanup.current = () => doc.removeEventListener('click', navigate)
    }} />}
  </div>
}

const unavailable = (): string => uiText('surfing.archive.unavailable')
const measured = (value: number | undefined, unit: string): string => value === undefined || value < 0 ? unavailable() : `${Number(value.toFixed(2))} ${unit}`
const fields = ['method', 'url', 'status', 'type', 'size', 'duration'] as const
function Pairs({ title, values }: { title: string; values: { name: string; value: string }[] }) {
  return <section><h3>{uiText(`surfing.har.${title}`)}</h3>{values.length ? <dl className="web-har-pairs">{values.map((pair, index) => <React.Fragment key={index}><dt>{pair.name}</dt><dd>{pair.value}</dd></React.Fragment>)}</dl> : <p>{unavailable()}</p>}</section>
}

function HarDetails({ entry }: { entry: HarEntry }) {
  const body = harBody(entry)
  const payload = entry.request.postData
  return <div className="web-har-details" aria-label={uiText('surfing.har.details')}>
    <h2>{entry.request.method} {entry.request.url}</h2>
    <p>{entry.response.status} {entry.response.statusText} · {entry.startedDateTime ?? unavailable()}</p>
    <Pairs title="requestHeaders" values={entry.request.headers} />
    <Pairs title="responseHeaders" values={entry.response.headers} />
    <Pairs title="requestCookies" values={entry.request.cookies} />
    <Pairs title="responseCookies" values={entry.response.cookies} />
    <Pairs title="query" values={entry.request.queryString} />
    <section><h3>{uiText('surfing.har.payload')}</h3><pre>{payload?.text ?? (payload?.params ? JSON.stringify(payload.params, null, 2) : unavailable())}</pre></section>
    <section><h3>{uiText('surfing.har.body')}</h3>{body.kind === 'text' ? <pre>{body.text}</pre> : <p>{uiText(`surfing.har.body.${body.kind}`)}</p>}</section>
    <section><h3>{uiText('surfing.har.timings')}</h3><dl className="web-har-pairs">{(['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive'] as const).map(key => <React.Fragment key={key}><dt>{uiText(`surfing.har.${key}`)}</dt><dd>{measured(entry.timings?.[key], 'ms')}</dd></React.Fragment>)}</dl><p>{uiText('surfing.har.sslIncluded')}</p></section>
  </div>
}

const HarView: PluginFileView = ({ relPath, mountedView }) => {
  const state = useArchive(relPath, parseHar)
  const { search, selected, page } = React.useSyncExternalStore(listener => subscribeSurfingFileBookmarks(api, listener), () => readSurfingFileBookmark(api, relPath))
  const setSearch = (search: string) => updateSurfingFileBookmark(api, relPath, { search })
  const select = (selected: string) => updateSurfingFileBookmark(api, relPath, { selected })
  const setPage = (page: number) => updateSurfingFileBookmark(api, relPath, { page })
  const entryKey = (entry: HarEntry): string => JSON.stringify([entry.startedDateTime ?? '', entry.request.method, entry.request.url])
  const rows = React.useMemo(() => (state.value ?? []).map((entry, index) => ({ entry, index })).filter(({ entry }) =>
    `${entry.request.method} ${entry.request.url} ${entry.response.status} ${entry.response.content.mimeType ?? ''}`.toLowerCase().includes(search.toLowerCase())
  ), [state.value, search])
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 100) - 1))
  const selectedEntry = selected === null ? undefined : rows.find(row => entryKey(row.entry) === selected)?.entry
  useSurfingFileCommands(mountedView, {
    snapshot: () => {
      const live = readSurfingFileBookmark(api, relPath), filtered = (state.value ?? []).map((entry, index) => ({ entry, index })).filter(({ entry }) => `${entry.request.method} ${entry.request.url} ${entry.response.status} ${entry.response.content.mimeType ?? ''}`.toLowerCase().includes(live.search.toLowerCase()))
      const pageCount = Math.max(1, Math.ceil(filtered.length / 100)), page = Math.min(live.page, pageCount - 1)
      return { kind: 'har', loading: state.loading, error: state.error ?? null, documentRevision: state.documentRevision, search: live.search, page, pageCount, selected: live.selected, requests: filtered.slice(page * 100, (page + 1) * 100).map(({ entry, index }) => ({ key: entryKey(entry), index, method: entry.request.method, url: entry.request.url, status: entry.response.status })) }
    },
    run: action => {
      if (action.type === 'reload') { state.reload(); return }
      if (state.loading || state.error || !state.value) throw Object.assign(new Error('The exact HAR source is unavailable.'), { outcome: 'not-applied' })
      if (action.type === 'search') { setSearch(action.value); setPage(0) }
      else if (action.type === 'previous' || action.type === 'next') { const page = currentPage + (action.type === 'previous' ? -1 : 1); if (page < 0 || page >= Math.max(1, Math.ceil(rows.length / 100))) throw Object.assign(new Error('This HAR page is unavailable.'), { outcome: 'not-applied' }); setPage(page) }
      else if (action.type === 'select') { if (!rows.slice(currentPage * 100, (currentPage + 1) * 100).some(row => entryKey(row.entry) === action.value)) throw Object.assign(new Error('This exact visible HAR request is unavailable.'), { outcome: 'not-applied' }); select(action.value) }
      else throw Object.assign(new Error('This control is unavailable for the read-only HAR inspector.'), { outcome: 'not-applied' })
    }
  })
  return <div className="web-page web-archive">
    <div className="web-toolbar"><input type="search" className="web-address" aria-label={uiText('surfing.har.search')} placeholder={uiText('surfing.har.search')} value={search} onChange={event => { setSearch(event.target.value); setPage(0) }} /><button className="web-link-btn" onClick={state.reload}>{uiText('surfing.shortcut.reload')}</button></div>
    <ArchiveMessage {...state} />
    {state.value && <>
      <div className="web-har-pagination"><span>{uiText('surfing.har.count', { count: rows.length })}</span><button className="web-link-btn" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>{uiText('surfing.har.previous')}</button><span>{currentPage + 1} / {Math.max(1, Math.ceil(rows.length / 100))}</span><button className="web-link-btn" disabled={(currentPage + 1) * 100 >= rows.length} onClick={() => setPage(currentPage + 1)}>{uiText('surfing.har.next')}</button></div>
      {!rows.length ? <div className="web-shortcut-message" role="status">{uiText(state.value.length ? 'surfing.har.noMatches' : 'surfing.har.empty')}</div> : <div className="web-har-content">
        <div className="web-har-list"><table aria-label={uiText('surfing.har.requests')}><thead><tr>{fields.map(field => <th key={field}>{uiText(`surfing.har.${field}`)}</th>)}</tr></thead><tbody>{rows.slice(currentPage * 100, (currentPage + 1) * 100).map(({ entry, index }) => <tr key={index} className={entryKey(entry) === selected ? 'is-selected' : undefined} onClick={() => select(entryKey(entry))}>
          <td>{entry.request.method}</td><td><button className="web-har-url" aria-pressed={entryKey(entry) === selected} onClick={() => select(entryKey(entry))}>{entry.request.url}</button></td><td>{entry.response.status}</td><td>{entry.response.content.mimeType ?? unavailable()}</td><td>{measured(entry.response.bodySize, 'B')}</td><td>{measured(entry.time, 'ms')}</td>
        </tr>)}</tbody></table></div>
        {selectedEntry && <HarDetails entry={selectedEntry} />}
      </div>}
    </>}
  </div>
}

export const MhtmlFileView: PluginFileView = props => <MhtmlView key={props.relPath} {...props} />
export const HarFileView: PluginFileView = props => <HarView key={props.relPath} {...props} />
