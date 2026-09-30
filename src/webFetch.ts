import { Readability } from '@mozilla/readability'
import DOMPurify from 'dompurify'
import TurndownService from 'turndown'
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { ValleyCancellation } from '@valley/plugin-sdk/valleyCancellation'
import { contentType as parseContentType, fromBase64 } from './archives'
import type { WebStore } from './store'
import { fetchTarget, type WebFetchFailure, type WebFetchResponse } from './webFetchContract'

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
const SANITIZE = { FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'], FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload'] }
const CACHE_LIMIT = 32
const CACHE_TTL_MS = 10 * 60 * 1000
const RENDER_TIMEOUT_MS = 30_000
const RENDER_SETTLE_MS = 750
export const FETCH_DEFAULT_CHARS = 12_000
export const FETCH_MAX_CHARS = 50_000

export type WebFetchMode = 'fetch' | 'rendered'
export interface WebFetchInput { url: string; maxChars?: number; startIndex?: number }
export interface WebFetchPage {
  url: string
  title: string
  status: number | null
  contentType: string
  bytes: number
  durationMs: number
  mode: WebFetchMode
  cached: boolean
  startIndex: number
  nextStartIndex: number | null
  totalChars: number
  content: string
  instanceId?: string
}
type FetchedDocument = Omit<WebFetchPage, 'durationMs' | 'cached' | 'startIndex' | 'nextStartIndex' | 'totalChars' | 'content' | 'mode'> & { text: string }

export type WebFetchErrorCode = WebFetchFailure | 'render'
const FAILURE_TEXT: Record<WebFetchErrorCode, string> = {
  url: 'Use an absolute http or https URL without credentials.',
  blocked: 'The address is blocked: private, local and plaintext hosts cannot be fetched.',
  timeout: 'The request timed out.',
  tooLarge: 'The response is larger than 4 MiB.',
  redirect: 'The redirect was refused or exceeded the redirect limit.',
  network: 'The network request failed.',
  render: 'The page could not be loaded in a browser tab.'
}

export class WebFetchError extends Error {
  constructor(readonly code: WebFetchErrorCode, detail?: string) {
    super(code === 'network' || code === 'render' ? `${FAILURE_TEXT[code]}${detail ? ` ${detail}` : ''}` : FAILURE_TEXT[code])
  }
}

/** Readable Markdown for an HTML page; links and images keep absolute URLs. */
export function htmlToMarkdown(html: string, baseUrl: string): { title: string; markdown: string; article: boolean } {
  const document = new DOMParser().parseFromString(html, 'text/html')
  for (const [selector, attribute] of [['a[href]', 'href'], ['img[src]', 'src']] as const) {
    for (const element of document.querySelectorAll(selector)) {
      try { element.setAttribute(attribute, new URL(element.getAttribute(attribute) ?? '', baseUrl).href) } catch { element.removeAttribute(attribute) }
    }
  }
  const pageTitle = document.title.trim()
  const article = new Readability(document.cloneNode(true) as typeof document).parse()
  const source = article?.content || document.body?.innerHTML || ''
  const markdown = turndown.turndown(DOMPurify.sanitize(source, SANITIZE)).trim()
  return { title: article?.title?.trim() || pageTitle, markdown, article: Boolean(article?.content) }
}

function charsetOf(bytes: Uint8Array, declared?: string): string {
  if (declared) return declared
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048))
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8'
}

function decode(bytes: Uint8Array, charset: string): string {
  try { return new TextDecoder(charset).decode(bytes) } catch { return new TextDecoder().decode(bytes) }
}

function binary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 1024).includes(0)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Convert a fetched response to the text an agent reads. */
export function responseDocument(response: WebFetchResponse): FetchedDocument {
  const { type, parameters } = parseContentType(response.contentType)
  const bytes = fromBase64(response.bodyBase64)
  const base = { url: response.url, status: response.status, contentType: type || 'unknown', bytes: bytes.length }
  const html = type === 'text/html' || type === 'application/xhtml+xml'
  const textual = html || type.startsWith('text/') || /(?:json|xml|javascript|ecmascript|yaml|csv|markdown)/.test(type)
  if ((!textual && type) || binary(bytes)) {
    return { ...base, title: '', text: `Unsupported content type ${base.contentType} (${formatBytes(bytes.length)}); no text was extracted.` }
  }
  const text = decode(bytes, charsetOf(bytes, parameters.charset))
  if (html || (!type && /<html[\s>]/i.test(text.slice(0, 4096)))) {
    const page = htmlToMarkdown(text, response.url)
    return { ...base, contentType: type || 'text/html', title: page.title, text: page.markdown }
  }
  if (type === 'application/json' || type.endsWith('+json')) {
    try { return { ...base, title: '', text: JSON.stringify(JSON.parse(text), null, 2) } } catch { /* keep the original text */ }
  }
  return { ...base, title: '', text }
}

/** The one-line summary that starts every fetch result, followed by the page text. */
export function formatFetchResult(page: WebFetchPage): string {
  const facts = [page.status === null ? 'rendered in a Surfing tab' : String(page.status), page.contentType, formatBytes(page.bytes), `${page.durationMs} ms`]
  if (page.cached) facts.push('cached')
  const title = page.title ? ` — "${page.title}"` : ''
  const range = page.nextStartIndex === null
    ? page.startIndex > 0 ? `\n[Characters ${page.startIndex}–${page.totalChars} of ${page.totalChars}.]` : ''
    : `\n[Showing characters ${page.startIndex}–${page.nextStartIndex} of ${page.totalChars}. Call again with startIndex ${page.nextStartIndex} for more.]`
  return `Fetched ${page.url}${title} · ${facts.join(' · ')}${range}\n\n${page.content || '(no text content)'}`
}

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

export interface WebFetcher {
  fetch(input: WebFetchInput, cancellation?: ValleyCancellation): Promise<WebFetchPage>
  fetchRendered(input: WebFetchInput, cancellation?: ValleyCancellation): Promise<WebFetchPage>
}

export function createWebFetcher(api: ValleyPluginApi, store: WebStore): WebFetcher {
  const cache = new Map<string, { at: number; document: FetchedDocument }>()

  const download = async (url: string, cancellation?: ValleyCancellation): Promise<FetchedDocument> => {
    const response = await api.backend.callOperation<WebFetchResponse | { error: WebFetchFailure; message?: string }>('fetch.url', { url }, { cancellation })
    if ('error' in response) throw new WebFetchError(response.error, response.message)
    return responseDocument(response)
  }

  const render = async (url: string, cancellation?: ValleyCancellation): Promise<FetchedDocument> => {
    const instanceId = store.openAgentTab(url)
    if (await store.waitForLoad(instanceId, RENDER_TIMEOUT_MS, cancellation) === 'timeout') throw new WebFetchError('timeout')
    await new Promise((resolve) => window.setTimeout(resolve, RENDER_SETTLE_MS))
    cancellation?.throwIfAborted()
    const page = await store.browserReadHtml(instanceId)
    if (!page.ok || !page.data) throw new WebFetchError('render', page.error)
    const { title, markdown } = htmlToMarkdown(page.data.html, page.data.url)
    return { url: page.data.url, title: title || page.data.title, status: null, contentType: 'text/html', bytes: new TextEncoder().encode(page.data.html).length, text: markdown, instanceId }
  }

  const run = async (mode: WebFetchMode, input: WebFetchInput, cancellation?: ValleyCancellation): Promise<WebFetchPage> => {
    const url = fetchTarget(input.url)
    if (!url) throw new WebFetchError('url')
    const maxChars = Math.min(FETCH_MAX_CHARS, Math.max(500, Math.floor(input.maxChars ?? FETCH_DEFAULT_CHARS)))
    const key = `${mode}\n${url}`
    const started = Date.now()
    const activity = store.beginAgentActivity({ url, mode, title: hostOf(url) })
    try {
      const hit = cache.get(key)
      const cached = Boolean(hit && started - hit.at < CACHE_TTL_MS)
      const document = cached ? hit!.document : await (mode === 'fetch' ? download(url, cancellation) : render(url, cancellation))
      cache.delete(key)
      cache.set(key, cached ? hit! : { at: started, document })
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
      const totalChars = document.text.length
      const startIndex = Math.min(totalChars, Math.max(0, Math.floor(input.startIndex ?? 0)))
      const end = Math.min(totalChars, startIndex + maxChars)
      const { text, ...facts } = document
      const page: WebFetchPage = { ...facts, mode, cached, durationMs: Date.now() - started, startIndex, nextStartIndex: end < totalChars ? end : null, totalChars, content: text.slice(startIndex, end) }
      store.finishAgentActivity(activity, page)
      return page
    } catch (error) {
      store.failAgentActivity(activity, error instanceof WebFetchError ? error.code : null, Date.now() - started)
      throw error
    }
  }

  return {
    fetch: (input, cancellation) => run('fetch', input, cancellation),
    fetchRendered: (input, cancellation) => run('rendered', input, cancellation)
  }
}
