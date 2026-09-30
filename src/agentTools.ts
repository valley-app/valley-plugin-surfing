import { uiText } from './localization'
import {
  createAgentToolProvider,
  type AgentToolDefinition,
  type AgentToolOutput,
  type AgentToolProvider,
  type ValleyPluginApi,
  type BrowserAutomationService
} from '@valley/plugin-sdk'
import { FETCH_INPUT_SCHEMA, parseFetchInput } from './commands'
import { formatFetchResult, type WebFetcher, type WebFetchPage } from './webFetch'

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false
})
const text = (description: string) => ({ type: 'string', description })
const str = (value: unknown) => value == null ? '' : String(value)
const tabId = (args: Record<string, unknown>) => str(args.instanceId).trim()
const error = (message?: string) => `Failed: ${message || 'browser action failed'}`
const action = async (promise: Promise<{ ok: boolean; error?: string; data?: { info?: string } }>) => {
  const result = await promise
  return result.ok ? result.data?.info ?? 'Done.' : error(result.error)
}
const clip = (value: string, max = 8000) => value.length > max ? `${value.slice(0, max)}\n…(truncated)` : value
const FETCH_TOOL = 'browser_fetch_url'

/** Canonical English palette labels; `surfing.command.<command id>` localizes them. */
const COMMAND_LABELS: Record<string, string> = {
  browser_list_tabs: 'Surfing: List browser tabs',
  browser_open_tab: 'Surfing: Open a URL in a new browser tab',
  browser_switch_tab: 'Surfing: Reveal a browser tab',
  browser_close_tab: 'Surfing: Close a browser tab',
  browser_snapshot: 'Surfing: Read the interactive page snapshot',
  browser_read_page: 'Surfing: Read visible page text',
  browser_screenshot: 'Surfing: Capture a page screenshot',
  browser_navigate: 'Surfing: Navigate a browser tab',
  browser_back: 'Surfing: Go back in a browser tab',
  browser_forward: 'Surfing: Go forward in a browser tab',
  browser_reload: 'Surfing: Reload a browser tab',
  browser_click: 'Surfing: Click a page element',
  browser_type: 'Surfing: Type into a page element',
  browser_select: 'Surfing: Select a dropdown option',
  browser_scroll: 'Surfing: Scroll a browser tab',
  browser_press_key: 'Surfing: Press a key in a browser tab'
}

function fetchTool(run: AgentToolDefinition['run']): AgentToolDefinition {
  return {
    name: FETCH_TOOL,
    description: 'Fetch a web page or text resource by URL and return its readable content as Markdown. HTML is reduced to the main article with absolute links; JSON, Markdown and plain text pass through. Runs in the background without cookies and appears live in the Surfing sidebar. Long results are paged: pass the reported startIndex to continue. Set render to true only when a page needs JavaScript to show its content; it then loads in a visible Surfing tab and may need confirmation.',
    parameters: schema({ ...FETCH_INPUT_SCHEMA.properties, render: { type: 'boolean', description: 'Load the page in a visible Surfing tab and read the rendered result' } }, ['url']),
    sideEffect: 'read',
    commandDispatch: 'dynamic',
    timeoutMs: 120_000,
    run
  }
}

function fetchInput(args: Record<string, unknown>) {
  const { render: _render, ...input } = args
  return parseFetchInput(input)
}

function browserTools(service: BrowserAutomationService, fetcher?: WebFetcher): AgentToolProvider {
  const unknownTab = async (instanceId: string): Promise<string> => {
    const result = await service.list()
    const open = result.ok ? (result.data?.tabs ?? []).map((tab) => tab.instanceId) : []
    return open.length
      ? `Failed: no tab "${instanceId}". Open tabs: ${open.join(', ')}. Use browser_list_tabs or browser_open_tab.`
      : `Failed: no tab "${instanceId}", and no tabs are open. Use browser_open_tab first.`
  }
  const tabAction = async (
    instanceId: string,
    promise: Promise<{ ok: boolean; error?: string; data?: { info?: string } }>
  ): Promise<string> => {
    const result = await promise
    if (result.ok) return result.data?.info ?? 'Done.'
    return /\bno (?:live web )?tab\b/i.test(result.error ?? '')
      ? unknownTab(instanceId)
      : error(result.error)
  }
  const requireTab = (args: Record<string, unknown>): string | null =>
    tabId(args) ? null : 'Failed: provide an instanceId from browser_list_tabs or browser_open_tab.'
  const tabTool = (
    name: string,
    description: string,
    run: (id: string, args: Record<string, unknown>) => Promise<AgentToolOutput>,
    properties: Record<string, unknown> = {},
    required: string[] = []
  ) => ({
    name, description,
    parameters: schema({ instanceId: text('Browser tab instanceId'), ...properties }, ['instanceId', ...required]),
    sideEffect: 'write' as const,
    timeoutMs: 120_000,
    run: async (args: Record<string, unknown>) => requireTab(args) ?? run(tabId(args), args)
  })

  return createAgentToolProvider([
    {
      name: 'browser_list_tabs', description: 'List Surfing browser tabs and their public instance ids.',
      parameters: schema({}), sideEffect: 'read', timeoutMs: 120_000,
      run: async () => {
        const result = await service.list()
        if (!result.ok) return error(result.error)
        const tabs = result.data?.tabs ?? []
        return tabs.length
          ? tabs.map((tab) => `${tab.instanceId} — ${tab.title || '(untitled)'} <${tab.url}>`).join('\n')
          : 'No browser tabs are open.'
      }
    },
    {
      name: 'browser_open_tab', description: 'Open a URL or search query in a new Surfing tab.',
      parameters: schema({ url: text('URL or search query') }, ['url']), sideEffect: 'write', timeoutMs: 120_000,
      run: async (args) => {
        const result = await service.open(str(args.url).trim())
        if (!result.ok || !result.data) return error(result.error)
        return `Opened tab ${result.data.instanceId} at ${result.data.url}.`
      }
    },
    tabTool('browser_switch_tab', 'Bring a Surfing tab to the front.', (id) => tabAction(id, service.switch(id))),
    tabTool('browser_close_tab', 'Close a Surfing tab.', (id) => tabAction(id, service.close(id))),
    {
      ...tabTool('browser_snapshot', 'Read the numbered interactive DOM snapshot for a Surfing tab.', async (id) => {
        const result = await service.snapshot(id)
        if (!result.ok || !result.data) return error(result.error)
        return clip(`Page: ${result.data.title} <${result.data.url}> — ${result.data.count} interactive elements\n${result.data.text}`)
      }),
      sideEffect: 'read' as const
    },
    {
      ...tabTool('browser_read_page', 'Read visible page text from a Surfing tab.', async (id) => {
        const result = await service.readText(id)
        return result.ok ? clip(result.data?.text ?? '') : error(result.error)
      }),
      sideEffect: 'read' as const
    },
    {
      ...tabTool('browser_screenshot', 'Capture a Surfing tab screenshot for visual inspection.', async (id) => {
        const result = await service.screenshot(id)
        if (!result.ok || !result.data) return error(result.error)
        return {
          text: `Screenshot of tab ${id}.`,
          attachment: { mime: result.data.mime, dataBase64: result.data.dataBase64 }
        }
      }),
      sideEffect: 'read' as const
    },
    tabTool('browser_navigate', 'Navigate a Surfing tab to an absolute URL.',
      (id, args) => action(service.navigate(id, str(args.url).trim())), { url: text('Absolute URL') }, ['url']),
    tabTool('browser_back', 'Go back in a Surfing tab history.', (id) => action(service.back(id))),
    tabTool('browser_forward', 'Go forward in a Surfing tab history.', (id) => action(service.forward(id))),
    tabTool('browser_reload', 'Reload a Surfing tab.', (id) => action(service.reload(id))),
    tabTool('browser_click', 'Click an element ref from browser_snapshot.',
      (id, args) => action(service.click(id, Number(args.ref))), { ref: { type: 'number' } }, ['ref']),
    tabTool('browser_type', 'Type into an element ref from browser_snapshot.',
      (id, args) => action(service.type(id, Number(args.ref), str(args.text), Boolean(args.submit))),
      { ref: { type: 'number' }, text: text('Text to type'), submit: { type: 'boolean' } }, ['ref', 'text']),
    tabTool('browser_select', 'Select an option in a dropdown ref from browser_snapshot.',
      (id, args) => action(service.select(id, Number(args.ref), str(args.value))),
      { ref: { type: 'number' }, value: text('Option value') }, ['ref', 'value']),
    tabTool('browser_scroll', 'Scroll a Surfing tab by a pixel delta.',
      (id, args) => action(service.scroll(id, Number(args.dx) || 0, args.dy == null ? 600 : Number(args.dy))),
      { dx: { type: 'number' }, dy: { type: 'number' } }),
    tabTool('browser_press_key', 'Send a key to the focused element in a Surfing tab.',
      (id, args) => action(service.pressKey(id, str(args.key))), { key: text('Key name') }, ['key']),
    ...(fetcher ? [fetchTool(async (args) => {
      try {
        const input = fetchInput(args)
        return formatFetchResult(await (args.render === true ? fetcher.fetchRendered(input) : fetcher.fetch(input)))
      } catch (failure) {
        return error(failure instanceof Error ? failure.message : String(failure))
      }
    })] : [])
  ])
}

const commandId = (name: string): string => name.replaceAll('_', '-')

function usage(name: string, parameters: Record<string, unknown>): string {
  const properties = parameters.properties as Record<string, { type?: string }>
  const required = new Set(parameters.required as string[])
  const parts = Object.entries(properties).map(([key, field]) => {
    if (key === 'instanceId') return '<instanceId>'
    const flag = `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}${field.type === 'boolean' ? '' : ` <${key}>`}`
    return required.has(key) ? flag : `[${flag}]`
  })
  return ['surfing', commandId(name), ...parts].join(' ')
}

function fromCli(parameters: Record<string, unknown>) {
  const properties = parameters.properties as Record<string, { type?: string }>
  const names = new Map(Object.keys(properties).map((key) => [key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), key]))
  return (args: string[], flags: Record<string, string | boolean>): unknown => {
    const input: Record<string, unknown> = 'instanceId' in properties && args[0] !== undefined ? { instanceId: args[0] } : {}
    for (const [flag, raw] of Object.entries(flags)) {
      const key = names.get(flag) ?? flag
      const type = properties[key]?.type
      input[key] = type === 'number' ? Number(raw) : type === 'boolean' ? raw === true || raw === 'true' : raw
    }
    return input
  }
}

export function registerBrowserAgentCommands(api: ValleyPluginApi, service: BrowserAutomationService): () => void {
  const provider = browserTools(service)
  const actions: Record<string, (input: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; data?: unknown }>> = {
    browser_list_tabs: () => service.list(), browser_open_tab: (input) => service.open(str(input.url)),
    browser_switch_tab: (input) => service.switch(tabId(input)), browser_close_tab: (input) => service.close(tabId(input)),
    browser_snapshot: (input) => service.snapshot(tabId(input)), browser_read_page: (input) => service.readText(tabId(input)),
    browser_screenshot: (input) => service.screenshot(tabId(input)), browser_navigate: (input) => service.navigate(tabId(input), str(input.url)),
    browser_back: (input) => service.back(tabId(input)), browser_forward: (input) => service.forward(tabId(input)), browser_reload: (input) => service.reload(tabId(input)),
    browser_click: (input) => service.click(tabId(input), Number(input.ref)),
    browser_type: (input) => service.type(tabId(input), Number(input.ref), str(input.text), Boolean(input.submit)),
    browser_select: (input) => service.select(tabId(input), Number(input.ref), str(input.value)),
    browser_scroll: (input) => service.scroll(tabId(input), Number(input.dx) || 0, input.dy === undefined ? 600 : Number(input.dy)),
    browser_press_key: (input) => service.pressKey(tabId(input), str(input.key))
  }
  const offs = provider.tools.map((tool) => api.commands.register({
    id: commandId(tool.name), label: COMMAND_LABELS[tool.name], labelKey: `surfing.command.${commandId(tool.name)}`,
    paletteSafe: false, agentVisibility: 'hidden', sideEffect: tool.sideEffect, timeoutMs: tool.timeoutMs, usage: usage(tool.name, tool.parameters),
    input: { schema: tool.parameters, fromCli: fromCli(tool.parameters), parse: (raw) => {
      const value = raw === undefined ? {} : raw
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(uiText('surfing.error.input'))
      const input = value as Record<string, unknown>
      const fields = tool.parameters.properties as Record<string, { type?: string }>
      for (const key of tool.parameters.required as string[] ?? []) if (input[key] === undefined || (key === 'instanceId' && !input[key])) throw new Error(uiText('surfing.error.required', { value: key }))
      for (const [key, item] of Object.entries(input)) {
        const field = fields[key]
        if (!field) throw new Error(uiText('surfing.error.invalid', { value: key }))
        if (field.type && typeof item !== field.type) throw new Error(uiText('surfing.error.invalid', { value: key }))
        if (field.type === 'number' && !Number.isFinite(item)) throw new Error(uiText('surfing.error.invalid', { value: key }))
      }
      return structuredClone(input)
    } },
    preview: (input) => ({ action: commandId(tool.name), ...input }),
    revision: async (input) => {
      if (!input.instanceId) return null
      const result = await service.list()
      if (!result.ok) throw new Error(result.error || uiText('surfing.error.listTabs'))
      const tab = result.data?.tabs.find((item) => item.instanceId === input.instanceId)
      if (!tab) throw new Error(uiText('surfing.error.closedTab'))
      return tab
    },
    run: async (input) => {
      const result = await actions[tool.name](input)
      if (!result.ok) throw new Error(result.error || uiText('surfing.error.action'))
      const value = result.data ?? { done: true }
      return tool.sideEffect === 'write' ? { value, revert: null } : value
    }
  }))
  return () => offs.forEach((off) => off())
}

export function surfingAgentTools(service: BrowserAutomationService, api?: ValleyPluginApi, fetcher?: WebFetcher): AgentToolProvider {
  const provider = browserTools(service, fetcher)
  if (!api) return provider
  return createAgentToolProvider(provider.tools.map((tool) => tool.name === FETCH_TOOL ? fetchTool(async (args, context) => {
    const result = await api.commands.executeOwn(args.render === true ? 'fetch-rendered' : 'fetch', fetchInput(args), { ...context, autonomous: true })
    if (!result.ok) throw new Error(result.error.message)
    return formatFetchResult(result.value as WebFetchPage)
  }) : ({
    ...tool, commandId: commandId(tool.name),
    run: async (input, context) => {
      const result = await api.commands.executeOwn(commandId(tool.name), input, { ...context, autonomous: true })
      if (!result.ok) throw new Error(result.error.message)
      if (tool.name === 'browser_screenshot' && result.value && typeof result.value === 'object' && 'mime' in result.value && 'dataBase64' in result.value) return { text: `Screenshot of tab ${tabId(input)}.`, attachment: { mime: String(result.value.mime), dataBase64: String(result.value.dataBase64) } }
      return typeof result.value === 'string' ? result.value : JSON.stringify(result.value)
    }
  })))
}
