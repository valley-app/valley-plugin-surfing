import { watchBrowserCosmetics } from './browserCosmetics'
/**
 * Web embeds in notes.
 *
 * Base fence:
 *   ```surfing
 *   https://example.com
 *   height: 420
 *   ```
 *
 * Providers (Settings → Surfing → Embeds) map a selector after `surfing` to a
 * URL template with a `{value}` placeholder. The built-in providers accept the
 * real share URL directly:
 *   ```surfing youtube
 *   https://www.youtube.com/watch?v=dQw4w9WgXcQ
 *   ```
 *   ```surfing X
 *   https://x.com/jack/status/20
 *   ```
 * (the value may sit in the body or right in the fence info string).
 *
 * Pages render in a real Electron `<webview>` (the renderer CSP blocks
 * iframes) in the active profile's session, mounted lazily when scrolled into
 * view and torn down on re-render — the fence disposer owns the guest.
 */
import codeBlockExamples from './codeBlockExamples.json'
import { api, React } from './runtime'
import { fenceInt, parseFenceParams } from '@valley/plugin-sdk/fenceParams'
import type { PluginBrowserGuestEvent } from '@valley/plugin-sdk'
import { createWebMedia } from './media'
import { partitionFor } from './profiles'
import { getStore } from './store'
import { uiText } from './localization'
import {
  EMBEDS_REL_DIR,
  WEB_FENCE_LANGUAGE,
  loadEmbedProviders,
  type EmbedProvider,
  type EmbedProviderConfiguration
} from './embedProviders'
import { embedRendererForProvider, embedRendererForUrl } from './embeds/registry'

const STYLE_ID = 'notes-web-fence-styles'
const DEFAULT_EMBED_HEIGHT = 360
const X_EMBED_HEIGHT = 180
const EMBED_HTTP_REFERRER = 'https://localhost/'

function ensureStyles(document: Document): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.web-fence { position: relative; width: 100%; max-width: none; margin: 0.5em 0; border: 1px solid var(--border-light); border-radius: var(--radius); background: var(--container-color); overflow: hidden; }
.web-fence--provider { isolation: isolate; margin: 0.25em 0; border: 0; border-radius: 10px; background: transparent; overflow: visible; }
.web-fence-bar { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-bottom: 1px solid var(--border-light); }
.web-fence--provider .web-fence-bar { position: absolute; z-index: 3; inset: calc(100% + 6px) 8px auto; border: 1px solid var(--border-light); border-radius: 7px; background: var(--surface-color); box-shadow: 0 1px 5px rgba(0,0,0,.18); opacity: 0; visibility: hidden; pointer-events: none; transition: opacity 120ms ease, visibility 120ms ease; }
.web-fence--provider .web-fence-bar::after { content: ''; position: absolute; inset: auto -1px 100%; height: 8px; }
.web-fence--provider:hover .web-fence-bar, .web-fence--provider.is-hovered .web-fence-bar, .web-fence--provider:focus-within .web-fence-bar { opacity: 1; visibility: visible; pointer-events: auto; }
.web-fence-bar .url { flex: 1; min-width: 0; font-size: var(--small-font-size); color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.web-fence-bar button { flex: none; border: none; background: none; padding: 2px 6px; border-radius: var(--radius-sm); color: var(--text-secondary); cursor: pointer; font-size: var(--small-font-size); }
.web-fence-bar button:hover, .web-fence-bar button:focus-visible { background: var(--hover-bg); color: var(--text-color); outline: 2px solid var(--primary-color); outline-offset: 1px; }
.web-fence-body { position: relative; z-index: 0; background: var(--surface-color); }
.web-fence--provider .web-fence-body { background: transparent; }
.web-fence-body webview { position: absolute; inset: 0; width: 100%; height: 100%; }
.web-fence-hint { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-secondary); font-size: var(--small-font-size); }
@media (hover: none), (max-width: 520px) {
  .web-fence--provider .web-fence-bar { inset: calc(100% + 4px) 6px auto auto; min-width: 44px; min-height: 44px; padding: 4px; opacity: 1; visibility: visible; pointer-events: auto; }
  .web-fence--provider .web-fence-bar .url { display: none; }
  .web-fence--provider .web-fence-bar button { min-width: 44px; min-height: 44px; }
}
`
  document.head.appendChild(style)
}

function activeEmbedTheme(): 'light' | 'dark' {
  const theme = document.documentElement.dataset.theme
  if (theme === 'light' || theme === 'dark') return theme
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function resolveProviderUrl(provider: EmbedProvider, value: string, theme = activeEmbedTheme()): string {
  const resolved = embedRendererForProvider(provider).parseValue(value.trim())
  const rawUrl = provider.template.includes('{value}')
    ? provider.template.replaceAll('{value}', resolved)
    : provider.template.trim()
      ? resolved ? provider.template + resolved : provider.template
      : resolved
  if (!provider.theme) return rawUrl
  try {
    const url = new URL(rawUrl)
    url.searchParams.set(provider.theme.queryParameter, provider.theme.values[theme])
    return url.toString()
  } catch {
    return rawUrl
  }
}

export function embedPresentation(url: string, requestedHeight?: number): {
  height: number
  autoSize: boolean
  httpReferrer?: string
} {
  const renderer = embedRendererForUrl(url)
  const youtube = renderer.kind === 'youtube'
  const x = renderer.kind === 'x'
  return {
    height: requestedHeight ?? (x ? X_EMBED_HEIGHT : DEFAULT_EMBED_HEIGHT),
    autoSize: x && requestedHeight === undefined,
    ...(youtube ? { httpReferrer: EMBED_HTTP_REFERRER } : {})
  }
}

type EmbedWebview = HTMLElement & {
  executeJavaScript?: (code: string) => Promise<unknown>
  setZoomFactor?: (factor: number) => void
}

let hoverBridgeCounter = 0

function renderEmbed(el: HTMLElement, url: string, requestedHeight?: number, provider?: EmbedProvider, sourceValue?: string, relPath?: string | null): (() => void) | void {
  const document = el.ownerDocument
  const window = document.defaultView!
  ensureStyles(document)
  el.classList.add('web-fence')
  if (provider) el.classList.add('web-fence--provider', `web-fence--${provider.kind}`)
  if (!/^https?:\/\//i.test(url)) {
    el.innerHTML = ''
    const hint = document.createElement('div')
    hint.className = 'web-fence-hint'
    hint.style.padding = '10px'
    hint.textContent = url ? `Not a web URL: ${url}` : 'Add a URL (body or ``` web <url>).'
    el.appendChild(hint)
    return
  }
  let activeUrl = url
  const renderer = provider ? embedRendererForProvider(provider) : embedRendererForUrl(url)

  const bar = document.createElement('div')
  bar.className = 'web-fence-bar'
  const urlLabel = document.createElement('span')
  urlLabel.className = 'url'
  urlLabel.textContent = url
  const openBtn = document.createElement('button')
  openBtn.textContent = uiText('surfing.embed.open')
  openBtn.title = uiText('surfing.embed.openDescription')
  openBtn.setAttribute('aria-label', uiText('surfing.embed.openLabel', { p0: provider?.displayName ?? url }))
  openBtn.addEventListener('click', () => {
    const store = getStore()
    if (!store) return
    const id = store.openTab(activeUrl)
    api.workspace.openMainTab({ instanceId: id })
  })
  bar.append(urlLabel, openBtn)

  const body = document.createElement('div')
  body.className = 'web-fence-body'
  const presentation = provider
    ? {
        height: requestedHeight ?? provider.presentation.initialHeight,
        autoSize: provider.presentation.autoSize && requestedHeight === undefined,
        ...(provider.presentation.httpReferrer ? { httpReferrer: provider.presentation.httpReferrer } : {})
      }
    : embedPresentation(url, requestedHeight)
  if (requestedHeight !== undefined) body.dataset.explicitHeight = 'true'
  if (provider?.presentation.aspectRatio && requestedHeight === undefined) {
    body.style.aspectRatio = provider.presentation.aspectRatio
  } else {
    body.style.height = `${presentation.height}px`
  }
  const hint = document.createElement('div')
  hint.className = 'web-fence-hint'
  hint.textContent = uiText('surfing.embed.loading')
  body.appendChild(hint)

  el.innerHTML = ''
  el.append(bar, body)

  let guest: EmbedWebview | null = null
  let releaseGuest: (() => void) | undefined
  let stopCosmetics: (() => void) | undefined
  let guestId: string | undefined
  let guestZoom = 1
  let disposed = false
  let hoverTimer: number | null = null
  let widthObserver: ResizeObserver | null = null
  let mediaDocument = 0
  const media = createWebMedia(api, {
    id: `embed:${crypto.randomUUID()}`,
    active: () => !disposed && guest !== null,
    document: () => mediaDocument,
    page: () => ({ url: activeUrl, title: provider?.displayName ?? activeUrl }),
    execute: async script => {
      if (!guest?.executeJavaScript) throw new Error('Web embed is unavailable')
      return guest.executeJavaScript(script)
    },
    mute: async muted => {
      if (!guestId) return
      const result = await api.drivers.browser.setAudioMuted(guestId, muted)
      if (!result.ok || result.data?.muted !== muted) throw new Error('Web audio output change was not confirmed')
    }
  })
  const resizeTimers = new Set<number>()
  const showChrome = (): void => {
    if (hoverTimer !== null) window.clearTimeout(hoverTimer)
    hoverTimer = null
    for (const active of document.querySelectorAll('.web-fence--provider.is-hovered')) {
      if (active !== el) active.classList.remove('is-hovered')
    }
    el.classList.add('is-hovered')
  }
  const hideChrome = (): void => {
    if (hoverTimer !== null) window.clearTimeout(hoverTimer)
    hoverTimer = window.setTimeout(() => {
      hoverTimer = null
      el.classList.remove('is-hovered')
    }, 120)
  }
  const hideChromeOutside = (event: PointerEvent): void => {
    if (el.classList.contains('is-hovered') && !!event.target && typeof event.target === 'object' && 'nodeType' in event.target && !el.contains(event.target as Node)) hideChrome()
  }
  bar.addEventListener('mouseenter', showChrome)
  bar.addEventListener('mouseleave', hideChrome)
  document.addEventListener('pointermove', hideChromeOutside, true)
  window.addEventListener('blur', hideChrome)
  const themeObserver = provider?.theme && sourceValue !== undefined
    ? new MutationObserver(() => {
        const nextUrl = resolveProviderUrl(provider, sourceValue)
        if (nextUrl === activeUrl) return
        activeUrl = nextUrl
        urlLabel.textContent = nextUrl
        guest?.setAttribute('src', nextUrl)
      })
    : null
  themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const io = new IntersectionObserver(
    (records) => {
      if (!records.some((r) => r.isIntersecting) || guest) return
      io.disconnect()
      const store = getStore()
      const partition = partitionFor(store?.getSnapshot().activeProfileId ?? 'default')
      const webview = document.createElement('div') as EmbedWebview
      Object.assign(webview.style, { position: 'absolute', inset: '0', height: '100%', width: '100%' })
      const instanceId = `embed-${crypto.randomUUID()}`
      let updateZoom: ((zoom: number) => void) | undefined
      webview.executeJavaScript = async (script) => {
        if (!guestId) throw new Error(uiText('surfing.error.guestReady'))
        const result = await api.drivers.browser.execute(guestId, script)
        if (!result.ok) throw new Error(result.error)
        return result.data
      }
      webview.setZoomFactor = (factor) => updateZoom?.(factor)
      const setAttribute = webview.setAttribute.bind(webview)
      webview.setAttribute = (name, value) => { setAttribute(name, value); if (name === 'src' && guestId) void api.drivers.browser.navigate(guestId, value) }
      const emitGuest = (event: PluginBrowserGuestEvent): void => {
        if (disposed) return
        if (event.guestId) guestId = event.guestId
        if (event.type === 'ready' || event.type === 'load' || event.type === 'navigate') mediaDocument++
        if (event.type === 'ready' && guestId) { stopCosmetics?.(); stopCosmetics = watchBrowserCosmetics(api, guestId, partition); void media.sync(true, event.playing) }
        const name = event.type === 'load' || event.type === 'ready' ? 'did-finish-load' : event.type === 'media' ? event.playing ? 'media-started-playing' : 'media-paused' : event.type === 'console' ? 'console-message' : null
        if (name) { const outgoing = new Event(name); Object.assign(outgoing, { message: event.message }); webview.dispatchEvent(outgoing) }
      }
      const Guest = (): React.ReactElement => {
        const [zoom, setZoom] = React.useState(guestZoom)
        const [ready, setReady] = React.useState(false)
        const [error, setError] = React.useState('')
        updateZoom = setZoom
        React.useEffect(() => { let active = true; void api.backend.call('filter.prepare', { partition }).then(() => { if (active) setReady(true) }).catch((error) => { if (active) setError(String(error)) }); return () => { active = false } }, [])
        return error ? <div role="alert">{error}</div> : ready ? <api.ui.BrowserGuest instanceId={instanceId} src={activeUrl} partition={partition} requestFilter="filter.request" httpReferrer={presentation.httpReferrer} zoomFactor={zoom} audioManaged onReady={emitGuest} onEvent={(event) => { if (event.type !== 'ready') emitGuest(event) }} /> : <div role="status">{uiText('surfing.embed.loading')}</div>
      }
      const hoverBridge = `__valley_embed_hover_${++hoverBridgeCounter}_`
      webview.addEventListener('console-message', (event: Event) => {
        const message = (event as Event & { message?: string }).message
        media.message(message)
        if (message === `${hoverBridge}enter`) showChrome()
        if (message === `${hoverBridge}leave`) hideChrome()
      })
      webview.addEventListener('media-started-playing', () => { void media.sync(true, true) })
      webview.addEventListener('media-paused', () => media.pause())
      webview.setAttribute('partition', partition)
      if (presentation.httpReferrer) webview.setAttribute('httpreferrer', presentation.httpReferrer)
      webview.setAttribute('src', activeUrl)
      const resize = (): void => {
        if (!presentation.autoSize || disposed || !webview.executeJavaScript) return
        void webview.executeJavaScript(`(() => {
          const root = ${renderer.measureRootScript}
          if (!root) return 0
          const rect = root.getBoundingClientRect()
          return Math.ceil(Math.max(0, rect.bottom - Math.min(0, rect.top)))
        })()`).then((value) => {
          if (disposed || typeof value !== 'number' || !Number.isFinite(value)) return
          const minimum = provider?.presentation.minHeight ?? X_EMBED_HEIGHT
          const maximum = provider?.presentation.maxHeight ?? 1200
          body.style.height = `${Math.max(minimum, Math.min(maximum, Math.ceil(value * guestZoom)))}px`
        }).catch(() => undefined)
      }
      webview.addEventListener('did-finish-load', () => {
        void media.sync(true)
        if (webview.executeJavaScript) {
          void webview.executeJavaScript(`(() => {
            document.addEventListener('mouseenter', () => console.debug(${JSON.stringify(`${hoverBridge}enter`)}), true)
            document.addEventListener('mouseleave', () => console.debug(${JSON.stringify(`${hoverBridge}leave`)}), true)
          })()`).catch(() => undefined)
        }
        const fitWidth = provider?.presentation.fitWidth
        if (fitWidth && provider.presentation.fullWidth && webview.setZoomFactor) {
          const fitGuestWidth = (): void => {
            const availableWidth = body.getBoundingClientRect().width
            const renderedWidth = Math.min(availableWidth, fitWidth.naturalWidth * fitWidth.maxScale)
            guestZoom = Math.max(1, renderedWidth / fitWidth.naturalWidth)
            webview.style.width = `${renderedWidth}px`
            webview.style.left = '50%'
            webview.style.right = 'auto'
            webview.style.transform = 'translateX(-50%)'
            webview.setZoomFactor?.(guestZoom)
          }
          fitGuestWidth()
          widthObserver?.disconnect()
          widthObserver = new (window as Window & typeof globalThis).ResizeObserver(fitGuestWidth)
          widthObserver.observe(body)
        }
        const prepare = provider?.presentation.fullWidth && webview.executeJavaScript
          ? webview.executeJavaScript(`(() => {
              const style = document.createElement('style')
              style.dataset.valleyEmbed = 'full-width'
              style.textContent = ${JSON.stringify(renderer.fullWidthCss)}
              document.head?.appendChild(style)
              const article = document.querySelector('article')
              let node = article?.parentElement
              while (node && node !== document.body) {
                node.style.setProperty('width', '100%', 'important')
                node.style.setProperty('max-width', 'none', 'important')
                node = node.parentElement
              }
              return true
            })()`).catch(() => undefined)
          : Promise.resolve()
        void prepare.then(() => {
          if (!presentation.autoSize) return
          for (const delay of [0, 250, 800, 1800, 3500]) {
            const timer = window.setTimeout(() => {
              resizeTimers.delete(timer)
              resize()
            }, delay)
            resizeTimers.add(timer)
          }
        })
      })
      guest = webview
      body.innerHTML = ''
      body.appendChild(webview)
      releaseGuest = api.ui.renderReact(webview, <Guest />)
    },
    { rootMargin: '160px' }
  )
  io.observe(body)

  return () => {
    disposed = true
    io.disconnect()
    themeObserver?.disconnect()
    widthObserver?.disconnect()
    widthObserver = null
    for (const timer of resizeTimers) window.clearTimeout(timer)
    resizeTimers.clear()
    if (hoverTimer !== null) window.clearTimeout(hoverTimer)
    hoverTimer = null
    el.classList.remove('is-hovered')
    document.removeEventListener('pointermove', hideChromeOutside, true)
    window.removeEventListener('blur', hideChrome)
    stopCosmetics?.()
    void media.dispose().finally(() => {
      releaseGuest?.()
      if (guestId) void api.drivers.browser.close(guestId)
      guest?.remove()
      guest = null
    }).catch(() => {})
  }
}

const heightOf = (code: string): number | undefined => fenceInt(parseFenceParams(code), 'height', 2000) ?? undefined

export function registerWebFences(initialProviders: Promise<EmbedProviderConfiguration> = loadEmbedProviders()): () => void {
  let active = true
  let providers: EmbedProvider[] = []
  const render: Parameters<typeof api.markdown.registerCodeBlockRenderer>[1] = (code, el, ctx) => {
    const params = parseFenceParams(code)
    const meta = ctx.meta?.trim() ?? ''
    const [selector = ''] = meta.split(/\s+/, 1)
    const provider = providers.find(entry => entry.language.toLowerCase() === selector.toLowerCase())
    if (provider) {
      const value = meta.slice(selector.length).trim() || params.values.url || params.bare || ''
      return renderEmbed(el, resolveProviderUrl(provider, value), heightOf(code), provider, value, ctx.path)
    }
    const url = (params.values.url ?? params.bare ?? meta).trim()
    return renderEmbed(el, url, heightOf(code), undefined, undefined, ctx.path)
  }
  let offFence = api.markdown.registerCodeBlockRenderer(WEB_FENCE_LANGUAGE, render, { examples: codeBlockExamples.surfing })
  let lastSignature = ''
  const applyProviders = (configuration: EmbedProviderConfiguration): void => {
    if (!active) return
    const signature = JSON.stringify([configuration.providers, configuration.rendererStamp ?? ''])
    if (signature === lastSignature) return
    lastSignature = signature
    providers = configuration.providers
    const examples = [
      ...codeBlockExamples.surfing,
      ...providers.flatMap(provider => (
        provider.kind === 'youtube' ? codeBlockExamples.youtube : provider.kind === 'x' ? codeBlockExamples.x : [
          { id: provider.id, label: provider.displayName, code: provider.template.replace('{value}', 'example') }
        ]
      ).map(example => ({ ...example, id: `${provider.id}:${example.id}`, meta: provider.language })))
    ]
    offFence()
    offFence = api.markdown.registerCodeBlockRenderer(WEB_FENCE_LANGUAGE, render, { examples })
  }
  let revision = 0
  let pending = false
  let running = false
  let initial: Promise<EmbedProviderConfiguration> | undefined = initialProviders
  const refresh = (): void => {
    revision++
    pending = true
    if (running) return
    running = true
    void (async () => {
      try {
        while (active && pending) {
          pending = false
          const currentRevision = revision
          const source = initial
          initial = undefined
          const configuration = await (source ?? loadEmbedProviders())
          if (!active || currentRevision !== revision) continue
          applyProviders(configuration)
        }
      } catch (error) {
        if (active) console.error('Could not refresh embed providers:', error)
      } finally {
        running = false
        if (active && pending) refresh()
      }
    })()
  }
  refresh()
  const offProviders = api.data.files.onChanged((relPath) => {
    if (relPath === EMBEDS_REL_DIR || relPath.startsWith(`${EMBEDS_REL_DIR}/`)) {
      refresh()
    }
  })

  return () => {
    active = false
    offFence()
    offProviders()
    document.getElementById(STYLE_ID)?.remove()
  }
}
