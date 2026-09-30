import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMockValleyApi } from './mock'
import { initRuntime } from '../src/runtime'
import { isWebUrl, readShortcutUrl, writeShortcutUrl, UrlFileView } from '../src/UrlFileView'
import { register } from '../src/index'
import config from '../config.json'

afterEach(cleanup)

const original = '\uFEFF[InternetShortcut]\r\nURL=https://example.test/old?q=a=b#section\r\nIconIndex=0\r\nIconFile=favicon.ico\r\n'
const path = 'Links/Website.url'

function setup(content = original) {
  const mock = createMockValleyApi({ files: { [path]: content } })
  initRuntime(mock.api)
  const view = render(<UrlFileView relPath={path} />)
  return { ...mock, ...view }
}

async function address() {
  const input = screen.getByRole('textbox', { name: 'Shortcut URL' })
  await waitFor(() => expect(input).not.toBeDisabled())
  return input
}

describe('Internet shortcut files', () => {
  it('uses managed audio and closes its guest when the file surface unmounts', async () => {
    const mock = createMockValleyApi({ files: { [path]: original } })
    const close = vi.spyOn(mock.api.drivers.browser, 'close')
    let props: React.ComponentProps<typeof mock.api.ui.BrowserGuest> | undefined
    mock.api.ui.BrowserGuest = value => { props = value; return <div /> }
    initRuntime(mock.api)
    const view = render(<UrlFileView relPath={path} />)
    await waitFor(() => expect(props?.audioManaged).toBe(true))
    act(() => props?.onEvent?.({ type: 'ready', guestId: 'shortcut-guest', url: readShortcutUrl(original) }))
    view.unmount()
    await waitFor(() => expect(close).toHaveBeenCalledWith('shortcut-guest'))
    expect(mock.api.drivers.browser.setAudioMuted).toHaveBeenCalledWith('shortcut-guest', true)
  })

  it('reads only the shortcut section, tolerating BOM, case, whitespace and line endings', () => {
    expect(readShortcutUrl(original)).toBe('https://example.test/old?q=a=b#section')
    expect(readShortcutUrl('[Other]\nURL=https://wrong.test\n [internetshortcut] \n url = https://example.test/über?q=1=2 \n')).toBe('https://example.test/über?q=1=2')
    expect(readShortcutUrl('[InternetShortcut]\rIconIndex=0\r[Other]\rURL=https://wrong.test')).toBe('')
  })

  it('preserves metadata, BOM and exact line endings when editing the URL', () => {
    expect(writeShortcutUrl(original, 'https://new.test/path?x=1&y=2#top')).toBe(original.replace('https://example.test/old?q=a=b#section', 'https://new.test/path?x=1&y=2#top'))
    const content = '[Other]\nURL=untouched\n[internetshortcut]\n url = https://old.test  \nURL=https://duplicate.test\n'
    expect(writeShortcutUrl(content, 'https://new.test')).toBe('[Other]\nURL=untouched\n[internetshortcut]\n url = https://new.test  \nURL=https://new.test\n')
  })

  it('repairs empty shortcuts and missing URL fields without deleting existing fields', () => {
    expect(writeShortcutUrl('', 'https://example.test')).toBe('[InternetShortcut]\r\nURL=https://example.test\r\n')
    expect(writeShortcutUrl('[InternetShortcut]\nIconIndex=0\n[Other]\nURL=other', 'https://example.test')).toBe('[InternetShortcut]\nURL=https://example.test\nIconIndex=0\n[Other]\nURL=other')
    expect(writeShortcutUrl('[InternetShortcut]', 'https://example.test')).toBe('[InternetShortcut]\r\nURL=https://example.test\r\n')
  })

  it.each(['javascript:alert(1)', 'file:///tmp/site.html', 'data:text/html,hello', 'https://', 'https://site.test\nURL=https://other.test', 'https://site.test\\path', 'search words'])('does not load or save a non-web address: %s', value => {
    expect(isWebUrl(value)).toBe(false)
    expect(() => writeShortcutUrl(original, value)).toThrow()
  })

  it('registers an editable .url file view', async () => {
    const mock = createMockValleyApi()
    const registered = vi.spyOn(mock.api, 'registerView')
    const dispose = register(mock.api)
    try {
      expect(config.fileViews['.url']).toMatchObject({ view: 'surfing.url', editable: true })
      expect(registered).toHaveBeenCalledWith('surfing.url', UrlFileView)
    } finally { await dispose() }
  })

  it('renders the saved page and persists explicit edits before changing the preview', async () => {
    const mock = setup()
    const input = await address()
    await waitFor(() => expect(mock.container.querySelector('[data-src]')?.getAttribute('data-src')).toBe(readShortcutUrl(original)))
    expect(mock.api.backend.call).toHaveBeenCalledWith('filter.prepare', { partition: 'persist:web-default' })
    fireEvent.change(input, { target: { value: 'https://new.test/über?x=1=2' } })
    expect(mock.container.querySelector('[data-src]')?.getAttribute('data-src')).toBe(readShortcutUrl(original))
    fireEvent.click(screen.getByRole('button', { name: 'Save URL' }))
    await waitFor(() => expect(mock.container.querySelector('[data-src]')?.getAttribute('data-src')).toBe('https://new.test/über?x=1=2'))
    expect(await mock.api.vault.readFile(path)).toBe(original.replace(readShortcutUrl(original), 'https://new.test/über?x=1=2'))
    expect(screen.getByRole('button', { name: 'Save URL' })).toBeDisabled()
  })

  it('allows an invalid shortcut to be repaired without loading its original target', async () => {
    const mock = setup('[InternetShortcut]\nURL=javascript:alert(1)\nIconIndex=0\n')
    const input = await address()
    expect(mock.container.querySelector('[data-src]')).toBeNull()
    fireEvent.change(input, { target: { value: 'https://fixed.test' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(mock.container.querySelector('[data-src]')?.getAttribute('data-src')).toBe('https://fixed.test'))
  })

  it('keeps invalid edits in the input and never writes them', async () => {
    const mock = setup()
    fireEvent.change(await address(), { target: { value: 'file:///tmp/file.html' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save URL' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('valid HTTP or HTTPS URL')
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    expect(await mock.api.vault.readFile(path)).toBe(original)
  })

  it('preserves unsaved edits and refuses to overwrite an externally changed file', async () => {
    const mock = setup()
    const input = await address()
    fireEvent.change(input, { target: { value: 'https://mine.test' } })
    const external = original.replace(readShortcutUrl(original), 'https://external.test')
    await mock.api.vault.writeFile(path, external)
    act(() => mock.emitVaultChanged({ changes: [{ relPath: path, kind: 'change' }] }))
    expect(input).toHaveValue('https://mine.test')
    fireEvent.click(screen.getByRole('button', { name: 'Save URL' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('changed outside this view')
    expect(await mock.api.vault.readFile(path)).toBe(external)
    expect(input).toHaveValue('https://mine.test')
    fireEvent.click(screen.getByRole('button', { name: 'Reload file' }))
    await waitFor(() => expect(input).toHaveValue('https://external.test'))
  })

  it('reloads clean views on relevant external changes', async () => {
    const mock = setup()
    const input = await address()
    await mock.api.vault.writeFile(path, '[InternetShortcut]\nURL=https://external.test')
    act(() => mock.emitVaultChanged({ changes: [{ relPath: 'Unrelated.url', kind: 'change' }] }))
    expect(input).toHaveValue(readShortcutUrl(original))
    act(() => mock.emitVaultChanged({ full: true }))
    await waitFor(() => expect(input).toHaveValue('https://external.test'))
  })

  it('retains the draft and old preview when saving fails, then permits retry', async () => {
    const mock = setup()
    const input = await address()
    vi.mocked(mock.api.vault.writeFileGuarded).mockRejectedValueOnce(new Error('disk full'))
    fireEvent.change(input, { target: { value: 'https://mine.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save URL' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save')
    expect(input).toHaveValue('https://mine.test')
    expect(mock.container.querySelector('[data-src]')?.getAttribute('data-src')).toBe(readShortcutUrl(original))
    fireEvent.click(screen.getByRole('button', { name: 'Save URL' }))
    await waitFor(() => expect(mock.container.querySelector('[data-src]')?.getAttribute('data-src')).toBe('https://mine.test'))
  })

  it('ignores a late read after switching files', async () => {
    const mock = createMockValleyApi({ files: { 'Next.url': '[InternetShortcut]\nURL=https://next.test' } })
    initRuntime(mock.api)
    let resolve!: (file: Awaited<ReturnType<typeof mock.api.vault.readFileBaseline>>) => void
    vi.spyOn(mock.api.vault, 'readFileBaseline').mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const view = render(<UrlFileView relPath={path} />)
    view.rerender(<UrlFileView relPath="Next.url" />)
    const input = await address()
    expect(input).toHaveValue('https://next.test')
    await act(async () => resolve({ content: original, baseline: null } as never))
    expect(input).toHaveValue('https://next.test')
  })
})
