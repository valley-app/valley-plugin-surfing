import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { BrowserAutomationService } from '@valley/plugin-sdk'
import config from '../config.json'
import { createMockValleyApi } from './mock'
import { register } from '../src/index'
import { initRuntime } from '../src/runtime'
import { createStore, disposeStore, getStore, type WebStore } from '../src/store'
import { registerWebCommands } from '../src/commands'
import { registerBrowserAgentCommands, surfingAgentTools } from '../src/agentTools'
import { createWebFetcher, formatFetchResult, htmlToMarkdown, responseDocument, type WebFetchPage } from '../src/webFetch'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const bytes = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)))
const ARTICLE = `<html><head><title>Forest field notes</title></head><body><nav>Menu</nav><article><h1>Forest field notes</h1><p>${'Moss, ferns and lichens grow on the northern slope. '.repeat(12)}<a href="/species/moss">Moss species</a></p></article></body></html>`
const disposers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  cleanup()
  while (disposers.length) await disposers.pop()!()
  vi.restoreAllMocks()
})

function setup() {
  const mock = createMockValleyApi()
  initRuntime(mock.api)
  const store = createStore(mock.api)
  const fetcher = createWebFetcher(mock.api, store)
  const responses = new Map<string, unknown>()
  vi.mocked(mock.api.backend.callOperation).mockImplementation(async (method: string, payload?: unknown) => {
    if (method !== 'fetch.url') throw new Error(`unexpected ${method}`)
    const url = (payload as { url: string }).url
    return (responses.get(url) ?? { error: 'network', message: 'offline' }) as never
  })
  disposers.push(() => disposeStore(mock.api, store))
  return { mock, store, fetcher, responses }
}

describe('fetched content conversion', () => {
  it('reduces HTML to the readable article with absolute links', () => {
    const page = htmlToMarkdown(ARTICLE, 'https://forest.example/notes/')
    expect(page.title).toBe('Forest field notes')
    expect(page.article).toBe(true)
    expect(page.markdown).toContain('[Moss species](https://forest.example/species/moss)')
    expect(page.markdown).not.toContain('Menu')
  })

  it('pretty-prints JSON, decodes declared charsets and refuses binary bodies', () => {
    const json = responseDocument({ url: 'https://api.example/birds', status: 200, contentType: 'application/json', bytes: 0, bodyBase64: bytes('{"species":["wren"]}') })
    expect(json.text).toBe('{\n  "species": [\n    "wren"\n  ]\n}')
    const latin = responseDocument({ url: 'https://forest.example/f', status: 200, contentType: 'text/plain; charset=iso-8859-1', bytes: 0, bodyBase64: btoa('F\xf6hre') })
    expect(latin.text).toBe('Föhre')
    const pdf = responseDocument({ url: 'https://forest.example/map.pdf', status: 200, contentType: 'application/pdf', bytes: 0, bodyBase64: btoa('%PDF\0') })
    expect(pdf.text).toMatch(/^Unsupported content type application\/pdf/)
  })
})

describe('Surfing URL fetcher', () => {
  it('pages long content, caches the download and records the activity', async () => {
    const { store, fetcher, responses, mock } = setup()
    const text = 'lichen '.repeat(400)
    responses.set('https://forest.example/list.txt', { url: 'https://forest.example/list.txt', status: 200, contentType: 'text/plain', bytes: text.length, bodyBase64: bytes(text) })
    const first = await fetcher.fetch({ url: 'http://forest.example/list.txt', maxChars: 1000 })
    expect(first).toMatchObject({ url: 'https://forest.example/list.txt', status: 200, startIndex: 0, nextStartIndex: 1000, totalChars: text.length, cached: false })
    expect(formatFetchResult(first)).toMatch(/^Fetched https:\/\/forest\.example\/list\.txt · 200 · text\/plain · 2\.7 KB · \d+ ms\n\[Showing characters 0–1000 of 2800\. Call again with startIndex 1000 for more\.\]/)
    const second = await fetcher.fetch({ url: 'https://forest.example/list.txt', maxChars: 1000, startIndex: 2500 })
    expect(second).toMatchObject({ cached: true, startIndex: 2500, nextStartIndex: null, content: text.slice(2500) })
    expect(mock.api.backend.callOperation).toHaveBeenCalledTimes(1)
    const activity = store.getSnapshot().agentActivity
    expect(activity.map((entry) => [entry.state, entry.cached])).toEqual([['done', true], ['done', false]])
  })

  it('marks blocked fetches as failed with a readable error', async () => {
    const { store, fetcher, responses } = setup()
    responses.set('https://intranet.example/', { error: 'blocked', message: 'Endpoint address is not allowed' })
    await expect(fetcher.fetch({ url: 'https://intranet.example/' })).rejects.toThrow('The address is blocked')
    expect(store.getSnapshot().agentActivity[0]).toMatchObject({ state: 'error', error: 'blocked', url: 'https://intranet.example/' })
  })

  it('reads a rendered page from the visible assistant tab after it loads', async () => {
    const { store, fetcher, mock } = setup()
    const openAgentTab = vi.spyOn(store, 'openAgentTab').mockReturnValue('web-agent')
    vi.spyOn(store, 'waitForLoad').mockResolvedValue('load')
    vi.spyOn(store, 'browserReadHtml').mockResolvedValue({ ok: true, data: { url: 'https://forest.example/app', title: 'App', html: ARTICLE } })
    const page = await fetcher.fetchRendered({ url: 'https://forest.example/app' })
    expect(openAgentTab).toHaveBeenCalledWith('https://forest.example/app')
    expect(page).toMatchObject({ mode: 'rendered', status: null, instanceId: 'web-agent', title: 'Forest field notes' })
    expect(mock.api.backend.callOperation).not.toHaveBeenCalled()
    expect(store.getSnapshot().agentActivity[0]).toMatchObject({ mode: 'rendered', state: 'done', instanceId: 'web-agent' })
  })

  it('waits for the guest load event, a timeout or cancellation', async () => {
    const { store, mock } = setup()
    store.ensureTab('web-1')
    const guestId = crypto.randomUUID()
    vi.spyOn(mock.api.drivers.browser, 'list').mockResolvedValue({ ok: true, data: { guests: [{ guestId, url: 'https://forest.example', title: 'Forest' }] } })
    store.readyGuest('web-1', { type: 'ready', guestId, url: 'https://forest.example' })
    const loaded = store.waitForLoad('web-1', 5000)
    store.guestEvent('web-1', { type: 'load', guestId })
    await expect(loaded).resolves.toBe('load')
    await expect(store.waitForLoad('web-1', 5)).resolves.toBe('timeout')
    const controller = new AbortController()
    const cancelled = store.waitForLoad('web-1', 5000, controller.signal)
    controller.abort(new Error('Stopped'))
    await expect(cancelled).rejects.toThrow('Stopped')
  })
})

describe('Surfing fetch commands and agent tool', () => {
  function commands(store: WebStore, mock: ReturnType<typeof createMockValleyApi>, fetcher: ReturnType<typeof createWebFetcher>) {
    const off = registerWebCommands(mock.api, store, fetcher)
    disposers.push(() => off())
  }

  it('registers a read fetch command and a gated rendered fetch command', async () => {
    const { store, fetcher, responses, mock } = setup()
    const registered = vi.spyOn(mock.api.commands, 'register')
    commands(store, mock, fetcher)
    const byId = Object.fromEntries(registered.mock.calls.map(([command]) => [command.id, command]))
    expect(byId.fetch).toMatchObject({ sideEffect: 'read', agentVisibility: 'hidden', labelKey: 'surfing.command.fetch', usage: expect.stringMatching(/^surfing fetch <url>/) })
    expect(byId['fetch-rendered']).toMatchObject({ sideEffect: 'write', agentVisibility: 'hidden', labelKey: 'surfing.command.fetch-rendered' })
    expect(byId.fetch.input!.fromCli!(['https://forest.example/'], { 'max-chars': '800' })).toEqual({ url: 'https://forest.example/', maxChars: 800 })
    responses.set('https://forest.example/', { url: 'https://forest.example/', status: 200, contentType: 'text/markdown', bytes: 6, bodyBase64: bytes('# Moss') })
    const result = await mock.api.commands.execute('surfing:fetch', { url: 'https://forest.example/' })
    expect(result).toMatchObject({ ok: true, value: { content: '# Moss', status: 200 } })
    expect(await mock.api.commands.execute('surfing:fetch', { url: 'https://forest.example/', depth: 2 })).toMatchObject({ ok: false })
  })

  it('exposes browser_fetch_url through the command bus with dynamic dispatch', async () => {
    const { store, fetcher, responses, mock } = setup()
    commands(store, mock, fetcher)
    const provider = surfingAgentTools({} as BrowserAutomationService, mock.api, fetcher)
    const descriptor = provider.tools.find((tool) => tool.name === 'browser_fetch_url')!
    expect(descriptor).toMatchObject({ sideEffect: 'read', commandDispatch: 'dynamic' })
    expect(descriptor.commandId).toBeUndefined()
    expect(Object.keys((descriptor.parameters as { properties: object }).properties)).toEqual(['url', 'maxChars', 'startIndex', 'render'])
    responses.set('https://forest.example/', { url: 'https://forest.example/', status: 200, contentType: 'text/html', bytes: ARTICLE.length, bodyBase64: bytes(ARTICLE) })
    const executeOwn = vi.spyOn(mock.api.commands, 'executeOwn')
    const output = await provider.execute('browser_fetch_url', { url: 'https://forest.example/', maxChars: 600 })
    expect(executeOwn).toHaveBeenCalledWith('fetch', { url: 'https://forest.example/', maxChars: 600 }, expect.objectContaining({ autonomous: true }))
    expect(String(output)).toMatch(/^Fetched https:\/\/forest\.example\/ — "Forest field notes" · 200 · text\/html/)
  })

  it('localizes the browser commands and keeps them out of agent discovery', () => {
    const { mock } = setup()
    const registered = vi.spyOn(mock.api.commands, 'register')
    const off = registerBrowserAgentCommands(mock.api, {} as BrowserAutomationService)
    disposers.push(off)
    const commandsById = Object.fromEntries(registered.mock.calls.map(([command]) => [command.id, command]))
    expect(commandsById['browser-fetch-url']).toBeUndefined()
    expect(commandsById['browser-click']).toMatchObject({
      label: 'Surfing: Click a page element',
      labelKey: 'surfing.command.browser-click',
      agentVisibility: 'hidden',
      usage: 'surfing browser-click <instanceId> --ref <ref>'
    })
    expect(commandsById['browser-click'].input!.fromCli!(['web-1'], { ref: '3' })).toEqual({ instanceId: 'web-1', ref: 3 })
  })

  it('lets every guard preset fetch in the background and gates the visible tab', () => {
    const decisions = Object.fromEntries(config.guardPresets.presets.map((preset) => [preset.id, [
      (preset.entries.tools as Record<string, { decision: string }>).browser_fetch_url.decision,
      (preset.entries as { commands: Record<string, { decision: string }> }).commands['fetch-rendered'].decision
    ]]))
    expect(decisions).toEqual({ recommended: ['allow', 'confirm'], 'allow-browsing': ['allow', 'allow'], 'read-only': ['allow', 'deny'] })
  })
})

describe('Surfing Assistant activity list', () => {
  it('shows live fetch rows and opens a fetched page', async () => {
    const mock = createMockValleyApi()
    const dispose = register(mock.api)
    disposers.push(dispose)
    await tick()
    const store = getStore()!
    const panel = (mock.api.registerView as unknown as { mock: { calls: [string, React.ComponentType][] } }).mock.calls.find(([id]) => id === 'surfing.panel')![1]
    render(React.createElement(panel))
    act(() => { store.beginAgentActivity({ url: 'https://forest.example/moss', mode: 'fetch', title: 'forest.example' }) })
    fireEvent.click(screen.getByLabelText('Assistant — fetching'))
    expect(screen.getByText('forest.example · Fetching…')).toBeTruthy()
    const done = store.getSnapshot().agentActivity[0]
    act(() => store.finishAgentActivity(done.id, { url: 'https://forest.example/moss', title: 'Moss', status: 200, contentType: 'text/html', bytes: 2048, durationMs: 180, mode: 'fetch', cached: false, startIndex: 0, nextStartIndex: null, totalChars: 10, content: '' } satisfies WebFetchPage))
    expect(screen.getByText('forest.example · 200 · 2.0 KB · 180 ms')).toBeTruthy()
    const openUrl = vi.spyOn(store, 'openUrl')
    fireEvent.click(screen.getByText('Moss'))
    expect(openUrl).toHaveBeenCalledWith('https://forest.example/moss', 'Moss')
    fireEvent.click(screen.getByText('Clear'))
    expect(screen.getByText('Pages the assistant fetches appear here.')).toBeTruthy()
  })
})
