import { createUiText, uiText } from './localization'
import type { BrowserAutomationService, BrowserActionResult, ValleyPluginApi } from '@valley/plugin-sdk'
import type { TextDocumentRead } from '@valley/plugin-sdk/types'
import type { WebStore } from './store'
import { FETCH_MAX_CHARS, formatFetchResult, htmlToMarkdown, type WebFetcher, type WebFetchInput, type WebFetchPage } from './webFetch'

interface ClipInput {
  instanceId: string
  collision: 'keep-both' | 'overwrite' | 'cancel'
}

type ClipResult = { cancelled: true } | { relPath: string; url: string; title: string }

function safeClipName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled clipping'
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

const unavailableTab = (instanceId: string): BrowserActionResult => ({
  ok: false,
  error: uiText('surfing.error.liveTab', { value: instanceId })
})

export function createBrowserAutomationService(
  api: ValleyPluginApi,
  store: WebStore
): BrowserAutomationService {
  return {
    list: () => store.listBrowserTabs(),
    open: async (url) => {
      const instanceId = store.openTab(url)
      api.workspace.openMainTab({ instanceId, title: url.trim() || uiText('auto.6f23a36f0aa1') })
      const tab = store.getTab(instanceId)
      return { ok: true, data: { instanceId, url: tab?.url ?? '', title: tab?.title } }
    },
    switch: async (instanceId) => {
      if (!store.getTab(instanceId)) return unavailableTab(instanceId)
      api.workspace.openMainTab({ instanceId })
      return { ok: true, data: { info: `Revealed tab ${instanceId}.` } }
    },
    close: async (instanceId) => {
      if (!store.getTab(instanceId)) return unavailableTab(instanceId)
      api.workspace.closeMainTab(instanceId)
      store.closeTab(instanceId)
      return { ok: true, data: { info: `Closed tab ${instanceId}.` } }
    },
    snapshot: (instanceId) => store.browserSnapshot(instanceId),
    readText: (instanceId, maxChars) => store.browserReadText(instanceId, maxChars),
    readHtml: (instanceId) => store.browserReadHtml(instanceId),
    screenshot: (instanceId) => store.browserScreenshot(instanceId),
    navigate: (instanceId, url) => store.browserNavigate(instanceId, url),
    back: (instanceId) => store.browserBack(instanceId),
    forward: (instanceId) => store.browserForward(instanceId),
    reload: (instanceId) => store.browserReload(instanceId),
    click: (instanceId, ref) => store.browserClick(instanceId, ref),
    type: (instanceId, ref, text, submit) => store.browserType(instanceId, ref, text, submit),
    select: (instanceId, ref, value) => store.browserSelect(instanceId, ref, value),
    scroll: (instanceId, dx, dy) => store.browserScroll(instanceId, dx, dy),
    pressKey: (instanceId, key) => store.browserPressKey(instanceId, key)
  }
}

async function clippingPath(
  api: ValleyPluginApi,
  title: string,
  collision: 'keep-both' | 'overwrite' | 'cancel',
  assertActive: () => void
): Promise<{ relPath: string; previous: TextDocumentRead | null } | null> {
  const stem = safeClipName(title)
  const initial = `Clippings/${stem}.md`
  const exists = await api.vault.stat(initial)
  assertActive()
  if (!exists) return { relPath: initial, previous: null }
  if (collision === 'cancel') return null
  if (collision === 'overwrite') {
    const previous = await api.vault.readTextDocument(initial)
    assertActive()
    if (!previous) throw new Error(createUiText(api)('surfing.error.readPage'))
    return { relPath: initial, previous }
  }
  for (let index = 2; index < 10_000; index++) {
    const relPath = `Clippings/${stem} (${index}).md`
    const occupied = await api.vault.stat(relPath)
    assertActive()
    if (!occupied) return { relPath, previous: null }
  }
  throw new Error(uiText('surfing.error.clipName'))
}

export const FETCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', minLength: 1, description: 'Absolute http(s) URL; http is upgraded to https' },
    maxChars: { type: 'integer', minimum: 500, maximum: FETCH_MAX_CHARS, description: 'Characters to return (default 12000)' },
    startIndex: { type: 'integer', minimum: 0, description: 'Character offset to continue from, as reported by the previous result' }
  },
  required: ['url'],
  additionalProperties: false
} as const

export function parseFetchInput(raw: unknown): WebFetchInput {
  const value = raw ?? {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(uiText('surfing.error.input'))
  const input = value as Record<string, unknown>
  for (const key of Object.keys(input)) if (!(key in FETCH_INPUT_SCHEMA.properties)) throw new Error(uiText('surfing.error.invalid', { value: key }))
  if (typeof input.url !== 'string' || !input.url.trim()) throw new Error(uiText('surfing.error.required', { value: 'url' }))
  const count = (key: 'maxChars' | 'startIndex'): number | undefined => {
    const item = input[key]
    if (item === undefined) return undefined
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) throw new Error(uiText('surfing.error.invalid', { value: key }))
    return Math.floor(item)
  }
  const maxChars = count('maxChars'), startIndex = count('startIndex')
  return { url: input.url.trim(), ...(maxChars === undefined ? {} : { maxChars }), ...(startIndex === undefined ? {} : { startIndex }) }
}

const fetchFromCli = (args: string[], flags: Record<string, string | boolean>): unknown => ({
  url: args.join(' ').trim(),
  ...(flags['max-chars'] === undefined ? {} : { maxChars: Number(flags['max-chars']) }),
  ...(flags['start-index'] === undefined ? {} : { startIndex: Number(flags['start-index']) })
})

/**
 * Register the user-facing `surfing:*` command-bus commands for ⌘P and CLI. Plugin
 * automation uses the separately registered `browser.automation` service.
 */
export function registerWebCommands(api: ValleyPluginApi, store: WebStore, fetcher: WebFetcher): () => Promise<void> {
  const uiText = createUiText(api)
  const root = api.getState().vault?.path
  const pending = new Set<Promise<unknown>>()
  let active = true
  let revoked = false
  let disposal: Promise<void> | undefined
  const offVault = api.subscribeState(['vault'], ({ state }) => { if (state.vault?.path !== root) revoked = true })
  const assertActive = (): void => {
    if (!active || revoked || api.getState().vault?.path !== root) throw new Error(uiText('surfing.error.saveClip'))
  }
  const accept = <T>(operation: () => Promise<T>): Promise<T> => {
    try { assertActive() } catch (error) { return Promise.reject(error) }
    const task = Promise.resolve().then(operation)
    pending.add(task)
    void task.then(() => pending.delete(task), () => pending.delete(task))
    return task
  }
  const browser = createBrowserAutomationService(api, store)
  const offs = [
    api.commands.register({
      id: 'open',
      label: 'Surfing: Open a website in a new tab', labelKey: 'auto.e4ab509cac59',
      paletteSafe: true,
      sideEffect: 'write',
      input: {
        schema: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false },
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          return { url: typeof o.url === 'string' ? o.url : '' }
        },
        fromCli: (args) => ({ url: args.join(' ').trim() })
      },
      preview: (input) => input,
      run: async ({ url }) => {
        const result = await browser.open(url)
        if (!result.ok || !result.data) throw new Error(result.error || uiText('surfing.error.openTab'))
        return { value: result.data, revert: null }
      },
      formatCli: (v) => `Opened ${v.url || 'a new tab'} (${v.instanceId}).`
    }),
    api.commands.register({
      id: 'list',
      label: 'Surfing: list open tabs', labelKey: 'auto.f5734ca3ccaf',
      paletteSafe: false,
      sideEffect: 'read',
      usage: 'surfing list',
      run: () => {
        const snap = store.getSnapshot()
        const tabs = Object.entries(snap.tabs).map(([instanceId, tab]) => ({
          instanceId,
          url: tab.url,
          title: tab.title,
          profileId: tab.profileId
        }))
        return { tabs }
      },
      formatCli: (v) => {
        const { tabs } = v as { tabs: { instanceId: string; url: string; title: string }[] }
        if (!tabs.length) return 'No web tabs open.'
        return tabs.map((t) => `- ${t.title || t.url || 'New tab'} (${t.instanceId}) — ${t.url}`).join('\n')
      }
    }),
    api.commands.register({
      id: 'switch',
      label: 'Surfing: Reveal a browser tab', labelKey: 'auto.f135c4de2eb1',
      paletteSafe: false,
      sideEffect: 'read',
      input: {
        schema: { type: 'object', properties: { instanceId: { type: 'string', minLength: 1 } }, required: ['instanceId'], additionalProperties: false },
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const instanceId = typeof o.instanceId === 'string' ? o.instanceId.trim() : ''
          if (!instanceId) throw new Error(uiText('surfing.error.usage', { value: 'surfing switch <instanceId>' }))
          return { instanceId }
        },
        fromCli: (args) => ({ instanceId: args.join(' ').trim() })
      },
      run: ({ instanceId }) => {
        if (!store.getTab(instanceId)) throw new Error(uiText('surfing.error.liveTab', { value: instanceId }))
        api.workspace.openMainTab({ instanceId })
        return { instanceId }
      },
      formatCli: (v) => `Revealed tab ${v.instanceId}.`
    }),
    api.commands.register({
      id: 'close',
      label: 'Surfing: Close a browser tab', labelKey: 'auto.09b21c342d80',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: { type: 'object', properties: { instanceId: { type: 'string', minLength: 1 } }, required: ['instanceId'], additionalProperties: false },
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const instanceId = typeof o.instanceId === 'string' ? o.instanceId.trim() : ''
          if (!instanceId) throw new Error(uiText('surfing.error.usage', { value: 'surfing close <instanceId>' }))
          return { instanceId }
        },
        fromCli: (args) => ({ instanceId: args.join(' ').trim() })
      },
      preview: (input) => input,
      revision: ({ instanceId }) => store.getTab(instanceId),
      run: async ({ instanceId }) => {
        const result = await browser.close(instanceId)
        if (!result.ok) throw new Error(result.error || uiText('surfing.error.closeTab'))
        return { value: { instanceId }, revert: null }
      },
      formatCli: (v) => `Closed tab ${v.instanceId}.`
    }),
    api.commands.register<ClipInput, ClipResult, 'write'>({
      id: 'clip',
      label: 'Surfing: Clip page to Markdown…', labelKey: 'auto.72f4410a7ff5',
      paletteSafe: false,
      sideEffect: 'write',
      usage: 'surfing clip <instanceId> [--collision keep-both|overwrite|cancel]',
      input: {
        schema: { type: 'object', properties: { instanceId: { type: 'string', minLength: 1 }, collision: { type: 'string', enum: ['keep-both', 'overwrite', 'cancel'], default: 'keep-both' } }, required: ['instanceId'], additionalProperties: false },
        parse: (raw) => {
          const value = (raw ?? {}) as Record<string, unknown>
          if (typeof value.instanceId !== 'string' || !value.instanceId.trim()) throw new Error(uiText('surfing.error.required', { value: 'instanceId' }))
          if (value.collision !== undefined && !['keep-both', 'overwrite', 'cancel'].includes(String(value.collision))) throw new Error(uiText('surfing.error.invalid', { value: 'collision (keep-both, overwrite, cancel)' }))
          const collision: ClipInput['collision'] = value.collision === 'overwrite' || value.collision === 'cancel'
            ? value.collision
            : 'keep-both'
          return {
            instanceId: value.instanceId.trim(),
            collision
          }
        },
        fromCli: (args, flags) => ({ instanceId: args[0] ?? '', collision: flags.collision })
      },
      preview: ({ instanceId, collision }) => ({
        action: 'clip-web-page',
        instanceId,
        targetFolder: 'Clippings',
        collision
      }),
      revision: async ({ instanceId }) => {
        const page = await store.browserReadHtml(instanceId)
        if (!page.ok) throw new Error(page.error || uiText('surfing.error.closedTab'))
        return page.data
      },
      run: ({ instanceId, collision }) => accept(async () => {
        assertActive()
        const response = await store.browserReadHtml(instanceId)
        assertActive()
        if (!response.ok || !response.data?.html) throw new Error(response.error || uiText('surfing.error.readPage'))
        const article = htmlToMarkdown(response.data.html, response.data.url)
        if (!article.article || !article.markdown) throw new Error(uiText('surfing.error.noArticle'))
        const markdown = article.markdown
        const title = article.title || response.data.title.trim() || 'Untitled clipping'
        const target = await clippingPath(api, title, collision, assertActive)
        if (!target) return { value: { cancelled: true as const }, revert: null }
        const content = [
          '---',
          `title: ${yamlString(title)}`,
          `source: ${yamlString(response.data.url)}`,
          `clippedAt: ${yamlString(new Date().toISOString())}`,
          '---',
          '',
          `# ${title}`,
          '',
          markdown,
          ''
        ].join('\n')
        assertActive()
        const written = target.previous
          ? await api.vault.writeTextDocumentGuarded(target.relPath, content, target.previous.revisionToken)
          : await api.vault.createTextDocumentGuarded(target.relPath, content)
        if (!written.ok) throw new Error(uiText('surfing.error.saveClip'))
        let receipt = 'revisionToken' in written ? written.revisionToken : null
        let state: 'applied' | 'reverted' | 'pending' = 'applied'
        const replay = (direction: 'undo' | 'redo'): Promise<void> => accept(async () => {
          assertActive()
          const expected = direction === 'undo' ? 'applied' : 'reverted'
          const key = direction === 'undo' ? 'surfing.error.restorePrevious' : 'surfing.error.restoreClip'
          if (state !== expected || ((direction === 'undo' || target.previous) && !receipt)) throw new Error(uiText(key))
          state = 'pending'
          if (target.previous) {
            const token = receipt!
            receipt = null
            const result = await api.vault.writeTextDocumentGuarded(target.relPath, direction === 'undo' ? target.previous.content : content, token)
            if (!result.ok) throw new Error(uiText(key))
            receipt = result.revisionToken
          } else if (direction === 'undo') {
            const token = receipt!
            receipt = null
            const removed = await api.vault.trashTextDocumentGuarded(target.relPath, token)
            if (!removed.ok) throw new Error(uiText('surfing.error.deleteClip'))
            if (removed.editorConflict || !removed.recoverySaved) throw new Error(uiText(removed.recoverySaved ? 'surfing.error.deletedWithDraft' : 'surfing.error.deletedRecoveryFailed'), { cause: removed })
          } else {
            const created = await api.vault.createTextDocumentGuarded(target.relPath, content)
            if (!created.ok) throw new Error(uiText(key))
            receipt = created.revisionToken
          }
          state = direction === 'undo' ? 'reverted' : 'applied'
        })
        return {
          value: { relPath: target.relPath, url: response.data.url, title },
          revert: {
            label: `Clip ${title}`,
            run: () => replay('undo'),
            reapply: () => replay('redo')
          }
        }
      }),
      formatCli: (value) => {
        const result = value as { cancelled?: boolean; relPath?: string }
        return result.cancelled ? 'Clipping cancelled.' : `Clipped page to ${result.relPath}.`
      }
    }),
    api.commands.register<WebFetchInput, WebFetchPage, 'read'>({
      id: 'fetch',
      label: 'Surfing: Fetch a web page as Markdown', labelKey: 'surfing.command.fetch',
      paletteSafe: false,
      agentVisibility: 'hidden',
      sideEffect: 'read',
      timeoutMs: 60_000,
      usage: 'surfing fetch <url> [--max-chars N] [--start-index N]',
      input: { schema: FETCH_INPUT_SCHEMA, parse: parseFetchInput, fromCli: fetchFromCli },
      run: (input, context) => fetcher.fetch(input, context.cancellation),
      formatCli: formatFetchResult
    }),
    api.commands.register<WebFetchInput, WebFetchPage, 'write'>({
      id: 'fetch-rendered',
      label: 'Surfing: Fetch a rendered web page in a visible tab', labelKey: 'surfing.command.fetch-rendered',
      paletteSafe: false,
      agentVisibility: 'hidden',
      sideEffect: 'write',
      timeoutMs: 90_000,
      usage: 'surfing fetch-rendered <url> [--max-chars N] [--start-index N]',
      input: { schema: FETCH_INPUT_SCHEMA, parse: parseFetchInput, fromCli: fetchFromCli },
      preview: (input) => ({ action: 'fetch-rendered', ...input }),
      run: async (input, context) => ({ value: await fetcher.fetchRendered(input, context.cancellation), revert: null }),
      formatCli: formatFetchResult
    })
  ]
  return () => {
    if (disposal) return disposal
    active = false
    offVault()
    for (const off of offs) off()
    return disposal = Promise.allSettled([...pending]).then(() => {})
  }
}
