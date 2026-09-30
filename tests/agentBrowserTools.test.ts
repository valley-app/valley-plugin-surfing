import { describe, expect, it, vi } from 'vitest'
import { type AgentToolProvider, type BrowserAutomationService } from '@valley/plugin-sdk'
import { createMockValleyApi } from './mock'
type MockValleyApi = ReturnType<typeof createMockValleyApi>
import { surfingAgentTools } from '../src/agentTools'
const providers = new WeakMap<object, AgentToolProvider>()
const buildTools = (api: MockValleyApi['api']) => { const provider = providers.get(api)!; return provider.tools.map((descriptor) => ({ ...descriptor, run: (input: Record<string, unknown>) => provider.execute(descriptor.name, input) })) }

function tool(mock: MockValleyApi, name: string) {
  const t = buildTools(mock.api).find((x) => x.name === name)
  if (!t) throw new Error(`no such tool: ${name}`)
  return t
}

function installSurfingTools(
  mock: MockValleyApi,
  options: { tabs?: { instanceId: string; url: string; title: string }[]; fail?: string[] } = {}
) {
  const tabs = options.tabs ?? [{ instanceId: 'web-1', url: 'https://bird.test', title: 'Bird' }]
  const fail = new Set(options.fail ?? [])
  const invoke = vi.fn(async (method: keyof BrowserAutomationService & string, args: readonly unknown[] = []) => {
    if (fail.has(method)) return { ok: false, error: 'No live web tab.' }
    if (method === 'list') return { ok: true, data: { tabs } }
    if (method === 'open') return { ok: true, data: { instanceId: 'web-1', url: String(args[0] ?? '') } }
    if (method === 'snapshot') {
      return { ok: true, data: { url: tabs[0]?.url ?? '', title: tabs[0]?.title ?? '', count: 0, text: '', elements: [] } }
    }
    if (method === 'readText') return { ok: true, data: { text: 'Forest canopy' } }
    if (method === 'readHtml') return { ok: true, data: { url: tabs[0]?.url ?? '', title: tabs[0]?.title ?? '', html: '<main>Forest canopy</main>' } }
    if (method === 'screenshot') return { ok: true, data: { dataBase64: 'Zm9yZXN0', mime: 'image/png' } }
    return { ok: true, data: { info: 'done' } }
  })
  const service = new Proxy({} as BrowserAutomationService, {
    get: (_target, property) => (...args: unknown[]) =>
      invoke(property as keyof BrowserAutomationService & string, args)
  })
  providers.set(mock.api, surfingAgentTools(service))
  const dispose = () => { providers.delete(mock.api) }
  return { invoke, dispose }
}

describe('Surfing-owned agent browser tools', () => {
  it('registers the DOM-first browser surface', () => {
    const mock = createMockValleyApi()
    installSurfingTools(mock)
    const names = buildTools(mock.api).map((t) => t.name)
    for (const n of [
      'browser_list_tabs',
      'browser_open_tab',
      'browser_switch_tab',
      'browser_close_tab',
      'browser_snapshot',
      'browser_read_page',
      'browser_screenshot',
      'browser_navigate',
      'browser_back',
      'browser_forward',
      'browser_reload',
      'browser_click',
      'browser_type',
      'browser_select',
      'browser_scroll',
      'browser_press_key'
    ]) {
      expect(names).toContain(n)
    }
  })

  it('marks reads free and page actions as writes', () => {
    const mock = createMockValleyApi()
    installSurfingTools(mock)
    const byName = Object.fromEntries(buildTools(mock.api).map((t) => [t.name, t.sideEffect]))
    expect(byName.browser_snapshot).toBe('read')
    expect(byName.browser_list_tabs).toBe('read')
    expect(byName.browser_read_page).toBe('read')
    expect(byName.browser_screenshot).toBe('read')
    expect(byName.browser_navigate).toBe('write')
    expect(byName.browser_click).toBe('write')
    expect(byName.browser_type).toBe('write')
    expect(byName.browser_open_tab).toBe('write')
  })

  it('opens, reveals, and closes through Surfing-owned automation', async () => {
    const mock = createMockValleyApi()
    const { invoke } = installSurfingTools(mock)
    await tool(mock, 'browser_open_tab').run({ url: 'bird.test' })
    await tool(mock, 'browser_switch_tab').run({ instanceId: 'web-1' })
    await tool(mock, 'browser_close_tab').run({ instanceId: 'web-1' })
    expect(invoke).toHaveBeenCalledWith('open', ['bird.test'])
    expect(invoke).toHaveBeenCalledWith('switch', ['web-1'])
    expect(invoke).toHaveBeenCalledWith('close', ['web-1'])
  })

  it('perceives and acts only through Surfing-owned automation', async () => {
    const mock = createMockValleyApi()
    const { invoke } = installSurfingTools(mock)
    await tool(mock, 'browser_list_tabs').run({})
    await tool(mock, 'browser_snapshot').run({ instanceId: 'web-1' })
    await tool(mock, 'browser_click').run({ instanceId: 'web-1', ref: 3 })
    await tool(mock, 'browser_type').run({ instanceId: 'web-1', ref: 4, text: 'hi', submit: true })
    expect(invoke).toHaveBeenCalledWith('list', [])
    expect(invoke).toHaveBeenCalledWith('snapshot', ['web-1'])
    expect(invoke).toHaveBeenCalledWith('click', ['web-1', 3])
    expect(invoke).toHaveBeenCalledWith('type', ['web-1', 4, 'hi', true])
    expect(mock.driverCalls.some((call) => call.driver === 'browser')).toBe(false)
  })

  it('returns a screenshot as an inline image attachment', async () => {
    const mock = createMockValleyApi()
    installSurfingTools(mock)
    const res = await tool(mock, 'browser_screenshot').run({ instanceId: 'web-1' })
    expect(typeof res).toBe('object')
    expect((res as { attachment?: { mime: string } }).attachment?.mime).toBe('image/png')
  })

  it('refuses a page action with no instanceId', async () => {
    const mock = createMockValleyApi()
    installSurfingTools(mock)
    const res = await tool(mock, 'browser_click').run({ ref: 1 })
    expect(String(res)).toMatch(/instanceId/i)
  })

  it('enriches an unknown tab failure with the provider-owned tab list', async () => {
    const mock = createMockValleyApi()
    installSurfingTools(mock, {
      tabs: [{ instanceId: 'web-7', url: 'https://fungi.test', title: 'Fungi' }],
      fail: ['switch']
    })
    const res = await tool(mock, 'browser_switch_tab').run({ instanceId: 'nope' })
    expect(String(res)).toMatch(/no tab "nope"/)
    expect(String(res)).toMatch(/web-7/)
  })

})
