import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Ajv from 'ajv'
import type { MountedPluginView } from '@valley/plugin-sdk'
import type { CommandContext } from '@valley/plugin-sdk/commands'
import { createMockValleyApi } from './mock'
import { initRuntime } from '../src/runtime'
import { UrlFileView } from '../src/UrlFileView'
import { HarFileView, MhtmlFileView } from '../src/ArchiveFileViews'
import { registerSurfingFileCommands } from '../src/fileCommands'

const disposals: Array<() => void> = []
afterEach(() => { cleanup(); disposals.splice(0).reverse().forEach(dispose => dispose()); vi.restoreAllMocks() })
const targetFor = (path: string, mountId = 'surfing-file'): MountedPluginView => ({ mountId, generation: 1, area: 'main', paneId: 'pane', tabId: mountId, filePath: path, pluginId: 'surfing' })
type Observation = { revision: string; view: Record<string, unknown> }
function setup(files: Record<string, string>, path: string) {
  const mock = createMockValleyApi({ files }), target = targetFor(path)
  initRuntime(mock.api); disposals.push(registerSurfingFileCommands(mock.api))
  vi.spyOn(mock.api.drivers.browser, 'execute')
  vi.mocked(mock.api.backend.callOperation).mockImplementation(async (method, input) => { if (method !== 'archive.readChunk') throw new Error('Unexpected archive operation'); const bytes = new TextEncoder().encode(files[(input as { relPath: string }).relPath]); return { base64: Buffer.from(bytes).toString('base64'), nextOffset: bytes.length, done: true, size: bytes.length, mtimeMs: 1 } as never })
  const command = (id: string) => mock.commands.find(command => command.id === id || command.id.endsWith(`:${id}`))!
  const ajv = new Ajv({ strict: true }), validator = ajv.compile(command('file-view-inspect').outputSchema!)
  const inspect = async (exact = target): Promise<Observation> => { const definition = command('file-view-inspect'), value = await definition.run(definition.input!.parse({ target: { mountId: exact.mountId, generation: exact.generation } }), { caller: 'agent' }); expect(validator(value), JSON.stringify(validator.errors)).toBe(true); return value as Observation }
  const invoke = async (action: unknown, route = 'control', context: Partial<CommandContext> = {}, expectedRevision?: string) => { const current = await inspect(), definition = command(`file-view-${route}`); let failure: unknown; await act(async () => { try { await definition.run(definition.input!.parse({ target: { mountId: target.mountId, generation: 1 }, expectedRevision: expectedRevision ?? current.revision, action }), { caller: 'agent', validateBeforeRun: async () => true, ...context }) } catch (cause) { failure = cause } }); if (failure) throw failure }
  return { mock, target, inspect, invoke, command }
}

describe('exact Surfing file owners', () => {
  it('changes one raw shortcut draft and uses its mounted save while preserving metadata and the other copy', async () => {
    const path = 'Links/Website.url', original = '\uFEFF[InternetShortcut]\r\nURL=https://example.test/old\r\nIconIndex=0\r\n'
    const fixture = setup({ [path]: original }, path), other = targetFor(path, 'other')
    const rendered = render(<><UrlFileView relPath={path} mountedView={fixture.target} /><UrlFileView relPath={path} mountedView={other} /></>)
    await waitFor(async () => expect((await fixture.inspect()).view.loading).toBe(false))
    const initial = await fixture.inspect()
    await fixture.invoke({ type: 'draft', value: 'https://new.test/über' }); expect(screen.getAllByRole('textbox', { name: 'Shortcut URL' })[0]).toHaveValue('https://new.test/über'); expect((await fixture.inspect(other)).view.draft).toBe('https://example.test/old'); expect(await fixture.mock.api.vault.readFile(path)).toBe(original)
    await expect(fixture.invoke({ type: 'save' }, 'save', {}, initial.revision)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await fixture.invoke({ type: 'save' }, 'save'); expect(await fixture.mock.api.vault.readFile(path)).toBe(original.replace('https://example.test/old', 'https://new.test/über')); expect(fixture.mock.api.vault.editors.save).toHaveBeenCalledWith(fixture.target, expect.stringContaining('https://new.test/über'), expect.any(Object), expect.any(String))
    await fixture.invoke({ type: 'draft', value: 'https://discard.test' }); await fixture.invoke({ type: 'reload' }); expect((await fixture.inspect()).view.draft).toBe('https://new.test/über')
    rendered.unmount(); await expect(fixture.inspect()).rejects.toMatchObject({ code: 'TARGET_REPLACED' })
  })

  it('retains an unacknowledged shortcut save and refuses denied or unsupported writes', async () => {
    const path = 'Links/Website.url', original = '[InternetShortcut]\nURL=https://example.test\n', fixture = setup({ [path]: original }, path)
    render(<UrlFileView relPath={path} mountedView={fixture.target} />); await waitFor(async () => expect((await fixture.inspect()).view.loading).toBe(false))
    await expect(fixture.invoke({ type: 'draft', value: 'https://denied.test' }, 'control', { validateBeforeRun: async () => false })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', outcome: 'not-applied' })
    await fixture.invoke({ type: 'draft', value: 'file:///tmp/not-web' }); await expect(fixture.invoke({ type: 'save' }, 'save')).rejects.toMatchObject({ outcome: 'not-applied' }); expect(await fixture.mock.api.vault.readFile(path)).toBe(original)
    await fixture.invoke({ type: 'draft', value: 'https://retained.test' }); vi.mocked(fixture.mock.api.vault.editors.save).mockRejectedValueOnce(new Error('Lost acknowledgement'))
    await expect(fixture.invoke({ type: 'save' }, 'save')).rejects.toMatchObject({ code: 'EFFECT_UNVERIFIED', outcome: 'unknown', retryable: false }); expect((await fixture.inspect()).view).toMatchObject({ draft: 'https://retained.test', dirty: true }); expect(await fixture.mock.api.vault.readFile(path)).toBe(original)
  })

  it('searches, pages, selects and reloads read-only HAR requests without replaying them', async () => {
    const path = 'capture.har', entries = Array.from({ length: 101 }, (_, i) => ({ request: { method: 'GET', url: `https://example.test/request${i}` }, response: { status: 200, content: { mimeType: 'text/plain', text: `Body ${i}` } } })), original = JSON.stringify({ log: { entries } }), fixture = setup({ [path]: original }, path)
    render(<HarFileView relPath={path} mountedView={fixture.target} />); await waitFor(async () => expect((await fixture.inspect()).view.loading).toBe(false))
    expect((await fixture.inspect()).view.requests).toHaveLength(100)
    await fixture.invoke({ type: 'next' }); expect((await fixture.inspect()).view).toMatchObject({ page: 1, pageCount: 2 }); expect(screen.getByRole('button', { name: 'https://example.test/request100' })).toBeInTheDocument()
    await fixture.invoke({ type: 'previous' }); expect((await fixture.inspect()).view.page).toBe(0)
    await fixture.invoke({ type: 'search', value: 'request100' }); const row = ((await fixture.inspect()).view.requests as { key: string }[])[0]
    await fixture.invoke({ type: 'select', value: row.key }); expect(screen.getByText('Body 100')).toBeInTheDocument(); expect((await fixture.inspect()).view.selected).toBe(row.key)
    const calls = vi.mocked(fixture.mock.api.backend.callOperation).mock.calls.length
    await fixture.invoke({ type: 'reload' }); await waitFor(() => expect(fixture.mock.api.backend.callOperation).toHaveBeenCalledTimes(calls + 1)); await waitFor(async () => expect((await fixture.inspect()).view.loading).toBe(false))
    expect(await fixture.mock.api.vault.readFile(path)).toBe(original); expect(fixture.mock.api.drivers.browser.execute).not.toHaveBeenCalled(); expect(fixture.mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
  })

  it('scrolls only a loaded offline MHTML anchor and reloads the owning archive', async () => {
    const path = 'capture.mhtml', original = 'Content-Type: text/html; charset=utf-8\r\nContent-Location: https://example.test/\r\n\r\n<html><body><a href="#target">Open</a><h2 id="target">Captured heading</h2></body></html>', fixture = setup({ [path]: original }, path)
    const rendered = render(<MhtmlFileView relPath={path} mountedView={fixture.target} />); const frame = await screen.findByTitle('Saved web page') as HTMLIFrameElement
    frame.contentDocument!.body.innerHTML = '<a href="#target">Open</a><h2 id="target">Captured heading</h2>'
    const scroll = vi.fn(); frame.contentDocument!.getElementById('target')!.scrollIntoView = scroll
    fireEvent.load(frame); expect((await fixture.inspect()).view.anchors).toEqual(['target'])
    await fixture.invoke({ type: 'anchor', value: 'target' }); expect(scroll).toHaveBeenCalledOnce(); expect((await fixture.inspect()).view.currentAnchor).toBe('target')
    await expect(fixture.invoke({ type: 'anchor', value: 'https://external.test' })).rejects.toMatchObject({ outcome: 'not-applied' }); expect(scroll).toHaveBeenCalledOnce()
    const calls = vi.mocked(fixture.mock.api.backend.callOperation).mock.calls.length; await fixture.invoke({ type: 'reload' }); await waitFor(() => expect(fixture.mock.api.backend.callOperation).toHaveBeenCalledTimes(calls + 1)); expect(await fixture.mock.api.vault.readFile(path)).toBe(original)
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin'); rendered.unmount()
  })

  it('declares strict schemas and rejects cross-effect routes or unknown target fields', () => {
    const fixture = setup({}, 'capture.har'), ajv = new Ajv({ strict: true })
    for (const command of fixture.mock.commands) { expect(() => ajv.compile(command.input!.schema!)).not.toThrow(); expect(() => ajv.compile(command.outputSchema!)).not.toThrow() }
    const definition = fixture.command('file-view-control'), input = { target: { mountId: fixture.target.mountId, generation: 1 }, expectedRevision: 'r' }
    for (const action of [{ type: 'save' }, { type: 'search', value: 1 }, { type: 'next', extra: true }]) expect(() => definition.input!.parse({ ...input, action })).toThrow()
    expect(() => definition.input!.parse({ ...input, target: { ...input.target, path: 'capture.har' }, action: { type: 'next' } })).toThrow(); expect(fixture.command('file-view-save')).toMatchObject({ recovery: 'non-replayable', idempotent: false })
  })
})
