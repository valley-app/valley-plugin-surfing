import { readdirSync, readFileSync as readStyleFile } from 'node:fs'
import { join as joinStylePath } from 'node:path'
import { DEFAULT_PALETTE } from '@valley/plugin-sdk/palette'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { initRuntime } from '../src/runtime'
import { registerWebFences } from '../src/embeds'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1, WORKSPACE_BOOKMARK_V1, type BookmarkCaptureResult } from '@valley/plugin-sdk'
import { readSurfingFileBookmark, updateSurfingFileBookmark } from '../src/workspaceDetails'
import { createMockValleyApi } from '@valley/plugin-testkit'
import * as plugin from '../src/index'
import manifest from '../manifest.json'
import config from '../config.json'
import { injectStyles } from '../src/styles'

const id = manifest.id
const withoutProperties = false
const requiresWritePreview = false
const declared = { ...manifest, ...config } as unknown as ValleyPluginManifest

afterEach(() => { document.head.querySelectorAll('style[id]').forEach((style) => style.remove()); delete document.documentElement.dataset.theme })

describe('package host contracts', () => {
  it('registers attributed command schemas and declared contextual surfaces', async () => {
    const mock = createMockValleyApi({ manifest: declared, indexEntries: [{ relPath: 'Unrelated.md', title: 'Unrelated', kind: 'note', mtimeMs: 1 }] })
    const observe = vi.spyOn(mock.api.index, 'observe')
    expect(mock.api.getState().indexEntries).toEqual([])
    mock.api.backend.call = vi.fn(async () => ({ ok: true })) as typeof mock.api.backend.call
    const dispose = plugin.register(mock.api)
    try {
      await Promise.resolve()
      const commands = mock.api.commands.list()
      expect(commands.length, `${id} did not register its commands`).toBeGreaterThan(0)
      expect(commands.filter((command) => command.acceptsInput && !command.inputSchema).map((command) => command.id)).toEqual([])
      expect(commands.every((command) => command.pluginId === id && command.id.startsWith(`${id}:`))).toBe(true)
      if (requiresWritePreview) {
        expect(mock.commands.filter((command) => command.sideEffect === 'write' && (!command.preview || !command.revision)).map((command) => command.id)).toEqual([])
      }
      const properties = mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)
      const declaredExtensions = (declared.provides ?? []).filter((contract) => contract.kind === 'extension').map((contract) => contract.id)
      if (withoutProperties) {
        expect(declaredExtensions).not.toContain(METADATA_PANEL_SEGMENT_V1.id)
        expect(properties).toEqual([])
      } else {
        expect(declaredExtensions).toContain(METADATA_PANEL_SEGMENT_V1.id)
        expect(properties.length, `${id} did not register contextual Properties`).toBeGreaterThan(0)
      }
      expect(declaredExtensions).toContain(PLUGIN_SURFACE_V1.id)
      for (const { extension } of properties) {
        expect(extension.pluginSurfaces === undefined || extension.pluginSurfaces.every((surface) => surface === 'main_workspace')).toBe(true)
        expect(extension.inspect, `${id}:${extension.id} is missing machine-readable Properties`).toBeTypeOf('function')
        if (extension.editCommand) {
          expect(extension.editCommand).not.toContain(':')
          expect(commands.find((command) => command.id === `${id}:${extension.editCommand}`), extension.editCommand).toMatchObject({ pluginId: id, sideEffect: 'write' })
        }
      }
      const providers = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)
      const snapshots = providers.map(({ extension }) => extension.getSnapshot())
      mock.emitState({ indexEntries: [{ relPath: 'Changed.md', title: 'Changed', kind: 'note', mtimeMs: 2 }] })
      expect(mock.api.getState().indexEntries).toEqual([])
      expect(providers.map(({ extension }) => extension.getSnapshot())).toEqual(snapshots)
      expect(observe).not.toHaveBeenCalled()
      const surfaces = providers.map(({ extension }) => extension.surface)
      const bookmarks = mock.api.interop.services.providers(WORKSPACE_BOOKMARK_V1)
      for (const surface of surfaces) {
        const provider = bookmarks.find(provider => (provider.metadata as { surface: string }).surface === surface)!
        expect(await provider.invoke('capture', [{ surface }])).toMatchObject({ ok: true, value: { status: 'ready' } })
      }
      const main = bookmarks.find(provider => (provider.metadata as { surface: string }).surface === 'main_workspace')!
      vi.spyOn(mock.api.vault, 'fileInfo').mockResolvedValue({} as never)
      for (const extension of Object.keys(config.fileViews)) {
        const path = `Archive/Canopy${extension}`
        const selected = JSON.stringify(['2026-09-30T12:00:00Z', 'GET', 'https://example.test/canopy'])
        updateSurfingFileBookmark(mock.api, path, { search: 'canopy', page: 2, selected })
        const capture = await main.invoke('capture', [{ surface: 'main_workspace', instanceId: path }])
        expect(capture).toMatchObject({ ok: true, value: { status: 'ready', bookmark: { itemId: selected, state: { path, search: 'canopy', page: 2, selected } } } })
        const result = capture.ok ? capture.value as BookmarkCaptureResult : null
        if (result?.status !== 'ready') throw new Error('Missing file capture')
        updateSurfingFileBookmark(mock.api, path, { search: '', page: 0, selected: null })
        expect(await main.invoke('restore', [result.bookmark])).toEqual({ ok: true, value: { status: 'restored' } })
        expect(readSurfingFileBookmark(mock.api, path)).toMatchObject({ search: 'canopy', page: 2, selected })
      }
      for (const surface of Object.keys(declared.uiSlots ?? {})) expect(surfaces, `${id}:${surface}`).toContain(surface)
      if (Object.keys(declared.fileViews ?? {}).length) expect(surfaces).toContain('main_workspace')
      if (properties.some(({ extension }) => extension.pluginSurfaces?.includes('main_workspace'))) expect(surfaces).toContain('main_workspace')
      expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length)
    } finally { dispose() }
  })
  it('owns and disposes its stylesheet in every theme', () => {
    for (const theme of ['dark', 'light']) {
      document.documentElement.dataset.theme = theme
      for (let pass = 0; pass < 2; pass++) {
        const dispose = injectStyles()
        expect(document.querySelectorAll('#notes-web-styles')).toHaveLength(1)
        dispose()
        expect(document.querySelectorAll('#notes-web-styles')).toHaveLength(0)
      }
    }
  })
})
  it('Surfing removes its lazily injected sheet and registrations', () => {
    const mock = createMockValleyApi()
    initRuntime(mock.api)
    const dispose = registerWebFences()
    mock.codeBlockRenderers.get('surfing')?.('', document.createElement('div'), { path: null, meta: null })
    expect(document.querySelectorAll('#notes-web-fence-styles')).toHaveLength(1)
    const css = document.getElementById('notes-web-fence-styles')?.textContent ?? ''
    expect(css).toMatch(/\.web-fence--provider \{[^}]*overflow: visible;/)
    expect(css).toMatch(/\.web-fence--provider \.web-fence-bar \{[^}]*position: absolute;[^}]*inset: calc\(100% \+ 6px\) 8px auto;[^}]*background: var\(--surface-color\);/)
    expect(css).toMatch(/\.web-fence--provider \.web-fence-bar::after \{[^}]*inset: auto -1px 100%;[^}]*height: 8px;/)
    expect(css).not.toMatch(/\.web-fence--provider \.web-fence-bar \{[^}]*background:[^;}]*transparent/)
    expect(css).toMatch(/\.web-fence--provider \.web-fence-body \{ background: transparent; \}/)
    dispose()
    expect(document.getElementById('notes-web-fence-styles')).toBeNull()
    expect(mock.codeBlockRenderers.has('surfing')).toBe(false)
  })



function styleSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink() || /claude/i.test(entry.name) || ['tests', '__tests__', 'node_modules'].includes(entry.name)) return []
    const file = joinStylePath(root, entry.name)
    return entry.isDirectory() ? styleSources(file) : /\.(?:css|ts|tsx)$/.test(entry.name) ? [file] : []
  })
}

it('keeps package styles tokenized, scalable, and consistent with SDK drop markers', () => {
  const hexes = new Set(DEFAULT_PALETTE.flatMap((color) => [color.light, color.dark]))
  hexes.delete('#3b82f6')
  const fixedGlyph = new RegExp('web-(?:profile-chevron|profile-mark|icon-btn|list-remove)')
  const retired = /var\(--(?:pink-color|danger-color|red-color|red|monospace-font|font-monospace|font-mono|code-font|ui-font|tint-blue-(?:bg|text))\b|--(?:pink-color|danger-color|red-color|red|monospace-font|font-monospace|font-mono|code-font|ui-font|tint-blue-(?:bg|text))\s*:/
  for (const file of styleSources(joinStylePath(process.cwd(), 'src'))) {
    const source = readStyleFile(file, 'utf8')
    expect(source, file).not.toMatch(retired)
    for (const hex of hexes) expect(source.toLowerCase(), file).not.toContain(hex)
    for (const [, selector, body] of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      if (/\.drop-(?:before|after)\b|\[data-drop-position|is-drop-target/.test(selector) && /\bheight:/.test(body)) expect(body, `${file}: ${selector}`).toContain('var(--drop-indicator-fill)')
      if (/(?<![-\w])font-size:\s*[0-9.]+px/.test(body)) expect(selector, file).toMatch(fixedGlyph)
    }
  }
})
