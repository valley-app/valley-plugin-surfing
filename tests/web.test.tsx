import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMockValleyApi } from './mock'
import { register } from '../src/index'
import { registerWebCommands } from '../src/commands'
import { createWebFetcher } from '../src/webFetch'
import { initRuntime } from '../src/runtime'
import { createStore, disposeStore, getStore, toUrl, WebStore } from '../src/store'
import { clearWebContext, publishWebContext, requestWebNoteFromSelection } from '../src/webContext'
import { embedPresentation, registerWebFences, resolveProviderUrl } from '../src/embeds'
import { ensureEmbedProviders, loadEmbedProviders, customizeEmbedProvider, createCustomEmbedProvider, type EmbedProvider, type EmbedProviderConfiguration } from '../src/embedProviders'
import { BUILT_IN_PROVIDERS, embedRenderer, installRuntimeEmbedRenderers } from '../src/embeds/registry'
import {
  TEXT_SELECTION_ACTION_V1,
  METADATA_PANEL_SEGMENT_V1,
  PLUGIN_SURFACE_V1,
  WEB_ACTIVE_CONTEXT_V1,
  WEB_NAVIGATOR_V1,
  type MainWorkspaceViewProps
} from '@valley/plugin-sdk'
import {
  DEFAULT_SETTINGS,
  INCOGNITO_PROFILE_ID,
  normalizeProfile,
  normalizeSavedPage,
  normalizeSettings,
  partitionFor,
  searchUrl
} from '../src/profiles'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const youtubeProvider: EmbedProvider = {
  schemaVersion: 1,
  id: 'youtube',
  displayName: 'YouTube',
  language: 'youtube',
  template: 'https://www.youtube.com/embed/{value}',
  kind: 'youtube',
  valueParser: 'youtube-video-id',
  presentation: { initialHeight: 360, autoSize: false, fullWidth: true, aspectRatio: '16 / 9', httpReferrer: 'https://localhost/' },
  order: 10,
  directory: 'youtube'
}

const xProvider: EmbedProvider = {
  schemaVersion: 1,
  id: 'x',
  displayName: 'X',
  language: 'X',
  template: 'https://platform.twitter.com/embed/Tweet.html?id={value}',
  kind: 'x',
  valueParser: 'x-post-id',
  presentation: { initialHeight: 180, autoSize: true, fullWidth: true, minHeight: 180, maxHeight: 1200, fitWidth: { naturalWidth: 515, maxScale: 1.3 } },
  theme: { queryParameter: 'theme', values: { light: 'light', dark: 'dark' } },
  order: 20,
  directory: 'x'
}

const providerFile = (provider: EmbedProvider): string => {
  const { directory: _directory, ...value } = provider
  return JSON.stringify(value)
}

describe('toUrl (address-bar URL vs query)', () => {
  it('passes a full URL through unchanged', () => {
    expect(toUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1')
    expect(toUrl('  http://localhost:3000/x ')).toBe('http://localhost:3000/x')
  })

  it('https-prefixes a bare domain', () => {
    expect(toUrl('example.com')).toBe('https://example.com')
    expect(toUrl('sub.example.co.uk/page')).toBe('https://sub.example.co.uk/page')
  })

  it('sends a plain query to the configured search engine', () => {
    expect(toUrl('fox habitat')).toBe(searchUrl('google', 'fox habitat'))
    expect(toUrl('fox habitat', 'duckduckgo')).toBe(searchUrl('duckduckgo', 'fox habitat'))
    expect(toUrl('fox habitat')).toMatch(/^https:\/\//)
  })

  it('returns empty for blank input', () => {
    expect(toUrl('   ')).toBe('')
  })
})

describe('web plugin', () => {
  it('loads the bundled provider definitions with their adjacent renderers', () => {
    expect(BUILT_IN_PROVIDERS.map((provider) => [provider.directory, provider.kind])).toEqual([
      ['youtube', 'youtube'],
      ['x', 'x']
    ])
    expect(embedRenderer('youtube').parseValue('https://youtu.be/M7lc1UVf-VE')).toBe('M7lc1UVf-VE')
    expect(embedRenderer('x').parseValue('https://x.com/jack/status/20')).toBe('20')
  })

  it('uses a runtime provider renderer ahead of the bundled fallback', () => {
    installRuntimeEmbedRenderers(new Map([['youtube', {
      ...embedRenderer('youtube'),
      parseValue: () => 'runtime-video'
    }]]))
    try {
      expect(resolveProviderUrl(youtubeProvider, 'https://youtu.be/M7lc1UVf-VE')).toBe(
        'https://www.youtube.com/embed/runtime-video'
      )
    } finally {
      installRuntimeEmbedRenderers(new Map())
    }
  })

  it('routes website, YouTube, X and custom selectors through the shared fence', async () => {
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
    })
    const mock = createMockValleyApi({ manifest: { id: 'surfing' } })
    initRuntime(mock.api)
    const custom = { ...youtubeProvider, id: 'field', directory: 'field', language: 'field', kind: 'generic' as const, valueParser: 'identity' as const, template: 'https://example.com/embed/{value}' }
    const dispose = registerWebFences(Promise.resolve({ providers: [youtubeProvider, xProvider, custom], customized: [], issues: [], revisions: {}, catalogRevision: 0 }))
    try {
      await tick()
      for (const [code, meta, expected, height] of [
        ['https://example.com', null, 'https://example.com'],
        ['', 'https://example.com/page', 'https://example.com/page'],
        ['https://youtu.be/M7lc1UVf-VE', 'youtube', 'https://www.youtube.com/embed/M7lc1UVf-VE'],
        ['', 'YouTube M7lc1UVf-VE', 'https://www.youtube.com/embed/M7lc1UVf-VE'],
        ['url: https://x.com/jack/status/20', 'x', 'https://platform.twitter.com/embed/Tweet.html?id=20'],
        ['', 'X https://x.com/jack/status/20', 'https://platform.twitter.com/embed/Tweet.html?id=20'],
        ['moss', 'field', 'https://example.com/embed/moss'],
        ['url: https://example.com\nheight: 480', null, 'https://example.com', '480px'],
        ['url: https://youtu.be/M7lc1UVf-VE\nheight: 480', 'youtube', 'https://www.youtube.com/embed/M7lc1UVf-VE', '480px'],
        ['url: https://x.com/jack/status/20\nheight: 500', 'X', 'https://platform.twitter.com/embed/Tweet.html?id=20', '500px']
      ]) {
        const element = document.createElement('div')
        const off = mock.codeBlockRenderers.get('surfing')!(code!, element, { path: null, meta })
        expect(element.querySelector('.url')?.textContent).toContain(expected)
        if (height) expect(element.querySelector<HTMLElement>('.web-fence-body')?.style.height).toBe(height)
        off?.()
      }
    } finally {
      dispose()
      vi.unstubAllGlobals()
    }
  })

  it('claims shared footer playback while an embed is playing', async () => {
    class ImmediateIntersectionObserver {
      readonly root = null
      readonly rootMargin = '0px'
      readonly thresholds = [0]
      constructor(private readonly callback: IntersectionObserverCallback) {}
      disconnect(): void {}
      observe(target: Element): void {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
      takeRecords(): IntersectionObserverEntry[] { return [] }
      unobserve(): void {}
    }
    vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver)
    const mock = createMockValleyApi({ manifest: { id: 'surfing' } })
    initRuntime(mock.api)
    const offFences = registerWebFences(Promise.resolve({ providers: [youtubeProvider], customized: [], issues: [], revisions: {}, catalogRevision: 0 }))
    let offEmbed: void | (() => void) = undefined
    try {
      await tick()
      const el = document.createElement('div')
      document.body.appendChild(el)
      offEmbed = mock.codeBlockRenderers.get('surfing')!(
        'https://www.youtube.com/watch?v=UF8uR6Z6KLc',
        el,
        { path: 'Research/Embed Demo.md', meta: 'youtube' }
      )
      const webview = el.querySelector('.web-fence-body > div') as HTMLElement & { executeJavaScript?: ReturnType<typeof vi.fn> }
      const executeJavaScript = vi.fn().mockResolvedValue({
        title: 'Canopy sounds', source: 'canopy.mp4',
        state: { status: 'playing', positionSeconds: 12, durationSeconds: 240, volume: 0.8, rate: 1, muted: false },
        capabilities: { seek: true, rate: true, next: false, previous: false }
      })
      webview.executeJavaScript = executeJavaScript
      webview.dispatchEvent(new Event('media-started-playing'))

      await waitFor(() => expect(mock.mediaPlayers).toHaveLength(1))
      await tick()
      expect(await mock.mediaPlayers[0].getSnapshot()).toMatchObject({
        descriptor: { title: 'Canopy sounds', path: expect.stringContaining('youtube.com') },
        state: { positionSeconds: 12, durationSeconds: 240, status: 'playing' },
        capabilities: { next: false }
      })
      await mock.mediaPlayers[0].toggle()
      expect(executeJavaScript.mock.calls.some(([code]) => String(code).includes('"type":"pause"'))).toBe(true)
      offEmbed?.()
      await tick()
      expect(mock.mediaPlayers[0].dispose).toHaveBeenCalled()
    } finally {
      offEmbed?.()
      offFences()
      vi.unstubAllGlobals()
      cleanup()
    }
  })

  it('renders fixed browser profile facts as Markdown rows, without disabled inputs', async () => {
    const { api } = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(api)
    try {
      const segment = api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)
        .find((provider) => provider.extension.id === 'surfing.profileProperties')!.extension
      const subject = { pluginId: 'surfing', surface: 'main_workspace' as const, view: { profileId: INCOGNITO_PROFILE_ID } }
      const { container } = render(React.createElement(React.Fragment, null, segment.render({ relPath: '', kind: 'unsupported', subject })))
      expect(await screen.findByText(INCOGNITO_PROFILE_ID, { selector: 'dd' })).toHaveClass('props-info-value')
      expect(screen.getByText('false')).toBeTruthy()
      expect([...container.querySelectorAll('.props-info-key')].map((element) => element.textContent)).toEqual(['Profile', 'Private', 'Hidden'])
      expect(container.querySelectorAll('.props-info-row')).toHaveLength(3)
      expect(container.querySelector('input, button, select')).not.toBeInTheDocument()
    } finally { cleanup(); dispose() }
  })

  it('restores explicit page and profile targets without focus, preserves private URLs, and returns structured browser results', async () => {
    const { api } = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(api)
    const store = getStore()!
    const surface = api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((provider) => provider.extension.surface === 'main_workspace')!.extension
    await surface.restore({ profileId: 'default', url: 'https://example.test/forest', title: 'Forest' }, 'saved-tab', { background: true })
    expect(store.getTab('saved-tab')).toMatchObject({ profileId: 'default', url: 'https://example.test/forest', title: 'Forest' })
    expect(api.workspace.openMainTab).not.toHaveBeenCalled()
    const snapshot = surface.getSnapshot('saved-tab')
    expect(snapshot?.item?.state).toMatchObject({ url: 'https://example.test/forest', profileId: 'default' })
    expect(snapshot?.bookmark).toMatchObject({ itemId: snapshot.item?.id, state: { url: 'https://example.test/forest', profileId: 'default' } })
    expect(snapshot?.actions?.[0]).toMatchObject({ id: 'reading-list', label: 'Add page to Reading list' })
    await snapshot?.actions?.[0].onSelect?.()
    expect(store.getSnapshot().readingList.map((page) => page.url)).toContain('https://example.test/forest')
    await expect(surface.restore({ profileId: 'deleted', url: 'https://example.test/forest' }, 'saved-tab')).rejects.toThrow('no longer exists')
    expect(store.getTab('saved-tab')?.profileId).toBe('default')
    await surface.restore({ profileId: INCOGNITO_PROFILE_ID, url: 'https://private.example.test/' }, 'private-tab', { background: true })
    store.navigate('private-tab', 'https://private.example.test/')
    expect(surface.getSnapshot('private-tab')?.item).toBeUndefined()
    const opened = await api.commands.executeOwn('browser-open-tab', { url: 'https://example.test/meadow' })
    expect(opened).toMatchObject({ ok: true, value: { instanceId: expect.any(String), url: 'https://example.test/meadow' } })
    expect(await api.commands.executeOwn('browser-list-tabs')).toMatchObject({ ok: true, value: { tabs: expect.any(Array) } })
    expect(await api.commands.executeOwn('browser-close-tab', { instanceId: 'deleted-tab' })).toMatchObject({ ok: false })
    expect(await api.commands.executeOwn('clip', {})).toMatchObject({ ok: false, error: { message: expect.stringContaining('instanceId is required') } })
    dispose()
  })

  it('registers its workspace + panel views via register(api)', () => {
    const { api } = createMockValleyApi()
    const dispose = register(api)
    const keys = (api.registerView as unknown as { mock: { calls: [string, unknown][] } }).mock.calls.map(
      (c) => c[0]
    )
    expect(keys).toContain('surfing.page')
    expect(keys).toContain('surfing.panel')
    dispose()
  })

  it('disposing register clears the session runtime store', () => {
    const { api } = createMockValleyApi()
    const dispose = register(api)
    expect(getStore()).not.toBeNull()
    dispose()
    expect(getStore()).toBeNull()
  })

  it('registers a host new-tab handler that creates a web tab', async () => {
    const { api, newTabHandlers } = createMockValleyApi()
    const dispose = register(api)
    await waitFor(() => expect(newTabHandlers).toHaveLength(1))
    await newTabHandlers[0]!({ paneId: 'pane-right' })
    expect(Object.keys(getStore()!.getSnapshot().tabs)).toHaveLength(1)
    expect(api.workspace.openMainTab).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'pane-right',
      newTab: true
    }))
    dispose()
    expect(newTabHandlers).toHaveLength(0)
  })

  it('unregisters the website new-tab handler when the General setting is off', async () => {
    const { api, newTabHandlers } = createMockValleyApi()
    const dispose = register(api)
    await waitFor(() => expect(newTabHandlers).toHaveLength(1))
    act(() => getStore()!.setSetting('openWebsiteOnNewTab', false))
    expect(newTabHandlers).toHaveLength(0)
    act(() => getStore()!.setSetting('openWebsiteOnNewTab', true))
    expect(newTabHandlers).toHaveLength(1)
    dispose()
  })

  it('shows the actual tab profile in the website toolbar', async () => {
    const { api } = createMockValleyApi()
    const dispose = register(api)
    await tick()
    const store = getStore()!
    store.renameProfile('default', 'Canopy')
    store.setProfileIcon('default', 'leaf')
    const instanceId = store.openTab('example.com', 'default')
    const call = (api.registerView as unknown as { mock: { calls: [string, React.ComponentType<MainWorkspaceViewProps>][] } }).mock.calls
      .find(([id]) => id === 'surfing.page')
    render(React.createElement(call![1], { instanceId, navigation: { setController: vi.fn() } }))
    const profile = screen.getByLabelText('Profile: Canopy')
    expect(profile).toHaveTextContent('Canopy')
    const toolbar = profile.closest('.web-toolbar')!
    expect(toolbar.children[0]).toBe(profile)
    expect(toolbar.children[1]).toHaveClass('web-address')
    expect(toolbar.children[2]).toHaveClass('web-nav-group')
    expect(toolbar.children[3]).toHaveClass('web-star')
    cleanup()
    dispose()
  })

  it('centres the page loader in a fill host on the right-sidebar content background', async () => {
    const { api } = createMockValleyApi()
    const dispose = register(api)
    await tick()
    const instanceId = getStore()!.openTab('example.com', 'default')
    const call = (api.registerView as unknown as { mock: { calls: [string, React.ComponentType<MainWorkspaceViewProps>][] } }).mock.calls
      .find(([id]) => id === 'surfing.page')
    render(React.createElement(call![1], { instanceId, navigation: { setController: vi.fn() } }))
    const loader = screen.getByRole('status', { name: 'Loads when visible…' })
    expect(loader.parentElement).toHaveClass('web-host')
    expect(loader.parentElement).toHaveAttribute('data-plugin-widget-layout', 'fill')
    const css = document.getElementById('notes-web-styles')?.textContent ?? ''
    expect(css).toMatch(/\.web-page \{[^}]*background:var\(--inspector-bg, var\(--container-color-alt\)\);/)
    expect(css).toMatch(/\.web-archive-frame \{[^}]*background:var\(--inspector-bg, var\(--container-color-alt\)\);/)
    cleanup()
    dispose()
  })

  it('uses eyeglasses for the Reading list tab', async () => {
    const { api } = createMockValleyApi()
    const dispose = register(api)
    await tick()
    const call = (api.registerView as unknown as { mock: { calls: [string, React.ComponentType][] } }).mock.calls
      .find(([id]) => id === 'surfing.panel')
    render(React.createElement(call![1]))
    const reading = screen.getByTitle('Reading list')
    expect(reading.querySelectorAll('circle')).toHaveLength(2)
    cleanup()
    dispose()
  })

  it('requires Cancel or Clear confirmation before clearing History', async () => {
    const { api, confirmations } = createMockValleyApi()
    const dispose = register(api)
    await tick()
    const store = getStore()!
    const tab = store.openTab('')
    store.reportUrl(tab, 'https://history.example/')
    await waitFor(() => expect(store.getSnapshot().history).toHaveLength(1))
    const call = (api.registerView as unknown as { mock: { calls: [string, React.ComponentType][] } }).mock.calls
      .find(([id]) => id === 'surfing.panel')
    render(React.createElement(call![1]))
    fireEvent.click(screen.getByTitle('Timeline'))
    const clear = await screen.findByRole('button', { name: 'Clear' })

    fireEvent.click(clear)
    await waitFor(() => expect(confirmations).toHaveLength(1))
    expect(confirmations[0]).toMatchObject({
      title: 'Clear history?',
      actions: [
        { label: 'Cancel', value: 'cancel', variant: 'ghost' },
        { label: 'Clear', value: 'clear', variant: 'danger' }
      ]
    })
    expect(store.getSnapshot().history).toHaveLength(1)

    ;(api.ui.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce('clear')
    fireEvent.click(clear)
    await waitFor(() => expect(store.getSnapshot().history).toHaveLength(0))
    cleanup()
    dispose()
  })

  it('provides separate Profile and Website metadata tabs', async () => {
    const { api } = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(api)
    await tick()
    const store = getStore()!
    const instanceId = store.openTab('example.com', 'default')
    store.restoreTab(instanceId, {
      url: 'https://example.com/',
      title: 'Example',
      profileId: 'default',
      metadata: {
        description: 'A useful example page.',
        image: 'https://example.com/share.jpg',
        siteName: 'Example site',
        icon: 'https://example.com/favicon.ico',
        canonical: 'https://example.com/canonical',
        language: 'en-CH'
      }
    })
    const subject = {
      pluginId: 'surfing',
      surface: 'main_workspace' as const,
      instanceId: 'stale-instance',
      view: { profileId: 'default' },
      item: { id: 'page', title: 'Example', state: { profileId: 'default', url: 'https://example.com/' } }
    }
    const segments = api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1).map((provider) => provider.extension)
    expect(segments.map((segment) => ({ id: segment.id, icon: segment.icon }))).toEqual([
      { id: 'surfing.websiteProperties', icon: 'globe' },
      { id: 'surfing.profileProperties', icon: 'user' }
    ])
    expect(await segments[1].inspect!({ relPath: '', kind: 'unsupported', subject })).toEqual([
      expect.objectContaining({ id: 'profileId', value: 'default', readOnly: true }),
      expect.objectContaining({ id: 'private', value: false, readOnly: true }),
      expect.objectContaining({ id: 'hidden', value: 'false', readOnly: true })
    ])
    expect((await segments[0].inspect!({ relPath: '', kind: 'unsupported', subject })).map((field) => field.id)).toEqual([
      'title', 'url', 'security', 'icon', 'iconUrl', 'language'
    ])
    const websiteFields = await segments[0].inspect!({ relPath: '', kind: 'unsupported', subject })
    expect(websiteFields.every((field) => field.readOnly === true)).toBe(true)
    expect(websiteFields.find((field) => field.id === 'security')).toMatchObject({ value: 'Unavailable' })
    const { container } = render(React.createElement(React.Fragment, null, segments[0].render({ relPath: '', kind: 'unsupported', subject })))
    expect(await screen.findByText('Example')).toBeTruthy()
    expect(screen.getByText('https://example.com/')).toBeTruthy()
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.getByText('https://example.com/favicon.ico')).toBeTruthy()
    expect(screen.getByText('en-CH')).toBeTruthy()
    expect(container.querySelector('.web-metadata-icon img')).toHaveAttribute('src', 'https://example.com/favicon.ico')
    expect(container.querySelector('input, button, select')).not.toBeInTheDocument()
    cleanup()
    dispose()
  })

  it('opens a new website tab in the selected profile without changing the open page', async () => {
    const { api, menus } = createMockValleyApi()
    const dispose = register(api)
    await tick()
    const store = getStore()!
    const original = store.openTab('example.com', 'default')
    const profileId = store.addProfile('Fungi')
    publishWebContext({ instanceId: original, url: 'https://example.com', title: 'Example' })
    const call = (api.registerView as unknown as { mock: { calls: [string, React.ComponentType][] } }).mock.calls
      .find(([id]) => id === 'surfing.panel')
    render(React.createElement(call![1]))
    fireEvent.click(document.querySelector('.web-profile-btn')!)
    const item = menus.at(-1)?.find((entry) => entry.id === profileId)
    await act(async () => {
      item?.onSelect?.()
      await tick()
    })

    expect(store.getSnapshot().activeProfileId).toBe(profileId)
    expect(store.getTab(original)?.profileId).toBe('default')
    const created = Object.entries(store.getSnapshot().tabs).find(([id]) => id !== original)
    expect(created?.[1].profileId).toBe(profileId)
    expect(api.workspace.openMainTab).toHaveBeenLastCalledWith(expect.objectContaining({
      instanceId: created?.[0],
      newTab: true
    }))
    act(() => clearWebContext(original))
    cleanup()
    dispose()
  })

  it('loads built-in providers from the package without creating saved source files', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'surfing' } })
    initRuntime(mock.api)
    const configuration = await ensureEmbedProviders()

    expect(configuration.providers.map((provider) => provider.id)).toEqual(['youtube', 'x'])
    expect(configuration.providers.find((provider) => provider.id === 'x')?.theme?.values).toEqual({ light: 'light', dark: 'dark' })
    expect(configuration.issues).toEqual([])
    expect(configuration.customized).toEqual([])
    for (const id of ['youtube', 'x']) {
      expect(await mock.api.data.files.readText(`embeds/${id}/provider.json`)).toBeNull()
      expect(await mock.api.data.files.readText(`embeds/${id}/renderer.tsx`)).toBeNull()
    }
    await customizeEmbedProvider(configuration.providers[0])
    expect(await mock.api.data.files.readText('embeds/youtube/provider.json')).toContain('"id": "youtube"')
    expect(await mock.api.data.files.readText('embeds/youtube/renderer.tsx')).toContain('kind: "youtube"')
    expect(await mock.api.data.files.readText('embeds/x/provider.json')).toBeNull()
  })

  it('retains saved overrides and uses package defaults without writing missing files', async () => {
    const mock = createMockValleyApi({
      manifest: { id: 'surfing' },
      files: {
        '.valley/plugins/data/surfing/embeds/youtube/provider.json': providerFile({
          ...youtubeProvider,
          template: 'https://custom.example/{value}',
          kind: 'generic',
          valueParser: 'identity'
        })
      }
    })
    initRuntime(mock.api)
    const configuration = await ensureEmbedProviders()
    expect(configuration.providers).toHaveLength(2)
    expect(configuration.providers[0]).toMatchObject({ id: 'youtube', template: 'https://custom.example/{value}' })
    expect(await mock.api.data.files.readText('embeds/youtube/renderer.tsx')).toBeNull()
    expect(configuration.customized).toEqual(['youtube'])
    expect(await mock.api.data.files.readText('embeds/x/provider.json')).toBeNull()

    expect(resolveProviderUrl(xProvider, 'https://x.com/jack/status/20', 'light')).toBe('https://platform.twitter.com/embed/Tweet.html?id=20&theme=light')
    expect(resolveProviderUrl(xProvider, 'https://x.com/jack/status/20', 'dark')).toBe('https://platform.twitter.com/embed/Tweet.html?id=20&theme=dark')
    expect(resolveProviderUrl({ ...xProvider, kind: 'generic' }, 'https://x.com/jack/status/20', 'dark')).toBe('https://platform.twitter.com/embed/Tweet.html?id=20&theme=dark')
    expect(embedPresentation('https://www.youtube.com/embed/UF8uR6Z6KLc')).toEqual({
      height: 360,
      autoSize: false,
      httpReferrer: 'https://localhost/'
    })
    expect(embedPresentation('https://platform.twitter.com/embed/Tweet.html?id=20')).toEqual({
      height: 180,
      autoSize: true
    })
    expect(embedPresentation('https://platform.twitter.com/embed/Tweet.html?id=20', 500)).toEqual({
      height: 500,
      autoSize: false
    })
    const dispose = registerWebFences(Promise.resolve({ providers: [xProvider], customized: [], issues: [], revisions: {}, catalogRevision: 0 }))
    await tick()
    expect(mock.codeBlockRenderers.has('twitter')).toBe(false)
    expect([...mock.codeBlockRenderers.keys()]).toEqual(['surfing'])
    dispose()
  })

  it('rejects invalid provider definitions without hiding valid providers', async () => {
    const mock = createMockValleyApi({
      manifest: { id: 'surfing' },
      files: {
        '.valley/plugins/data/surfing/embeds/youtube/provider.json': providerFile(youtubeProvider),
        '.valley/plugins/data/surfing/embeds/unsafe/provider.json': JSON.stringify({ schemaVersion: 1, id: 'unsafe', displayName: 'Unsafe', language: 'surfing', template: 'javascript:{value}', kind: 'generic', valueParser: 'identity', presentation: { initialHeight: 360, autoSize: false, fullWidth: true }, order: 30 })
      }
    })
    initRuntime(mock.api)
    const configuration = await loadEmbedProviders()
    expect(configuration.providers.map((provider) => provider.id)).toEqual(['youtube', 'x'])
    expect(configuration.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.valley/plugins/data/surfing/embeds/unsafe/provider.json' })
    ]))
  })

  it('allows provider selectors that match other plugins and system fences', async () => {
    const custom = { ...youtubeProvider, id: 'field', directory: 'field', kind: 'generic' as const, valueParser: 'identity' as const, language: 'wildlife' }
    const mock = createMockValleyApi({
      codeBlockClaims: [{ language: 'wildlife', owner: { kind: 'plugin', pluginId: 'field-guide' } }, { language: 'mermaid', owner: { kind: 'system' } }],
      files: {
        '.valley/plugins/data/surfing/embeds/field/provider.json': providerFile(custom),
        '.valley/plugins/data/surfing/embeds/old/provider.json': providerFile({ ...custom, id: 'old', directory: 'old', language: 'map' }),
        '.valley/plugins/data/surfing/embeds/diagram/provider.json': providerFile({ ...custom, id: 'diagram', directory: 'diagram', language: 'mermaid' })
      }
    })
    initRuntime(mock.api)
    const configuration = await loadEmbedProviders()
    expect(configuration.providers.map(provider => provider.language)).toEqual(expect.arrayContaining(['map', 'youtube', 'X']))
    expect(configuration.providers).toHaveLength(5)
    expect(configuration.issues).toEqual([])
    mock.emitCodeBlockClaims([])
    expect((await loadEmbedProviders()).providers.map(provider => provider.id)).toContain('field')
  })

  it('refreshes provider selectors and examples while keeping one registered fence', async () => {
    const custom = { ...youtubeProvider, id: 'field', directory: 'field', kind: 'generic' as const, valueParser: 'identity' as const, language: 'wildlife' }
    const mock = createMockValleyApi({
      codeBlockClaims: [{ language: 'wildlife', owner: { kind: 'plugin', pluginId: 'field-guide' } }],
      files: { '.valley/plugins/data/surfing/embeds/field/provider.json': providerFile(custom) }
    })
    initRuntime(mock.api)
    const registerFence = vi.spyOn(mock.api.markdown, 'registerCodeBlockRenderer')
    const list = vi.spyOn(mock.api.data.files, 'list')
    let filesChanged: (path: string) => void = () => {}
    vi.spyOn(mock.api.data.files, 'onChanged').mockImplementation(listener => { filesChanged = listener; return () => { filesChanged = () => {} } })
    const dispose = registerWebFences()
    await waitFor(() => expect(registerFence).toHaveBeenCalledTimes(2))
    expect([...mock.codeBlockRenderers.keys()]).toEqual(['surfing'])
    const examples = registerFence.mock.lastCall![2]!.examples!
    expect(examples.map(example => example.meta)).toEqual([undefined, undefined, 'youtube', 'youtube', 'wildlife', 'X', 'X'])
    expect(new Set(examples.map(example => example.id)).size).toBe(examples.length)
    mock.emitCodeBlockClaims([])
    await tick()
    expect(list).toHaveBeenCalledOnce()
    const baseline = await mock.api.data.files.readTextBaseline('embeds/field/provider.json')
    await mock.api.data.files.writeTextGuarded('embeds/field/provider.json', providerFile({ ...custom, language: 'renamed-field' }), baseline!.baseline)
    filesChanged('embeds/field/provider.json')
    await waitFor(() => expect(registerFence).toHaveBeenCalledTimes(3))
    expect(registerFence.mock.lastCall![2]!.examples!.some(example => example.meta === 'renamed-field')).toBe(true)
    expect([...mock.codeBlockRenderers.keys()]).toEqual(['surfing'])
    dispose()
    expect(mock.codeBlockRenderers.size).toBe(0)
  })

  it('coalesces provider changes during hydration and ignores pending results after disposal', async () => {
    const mock = createMockValleyApi()
    initRuntime(mock.api)
    let filesChanged: (path: string) => void = () => {}
    vi.spyOn(mock.api.data.files, 'onChanged').mockImplementation(listener => { filesChanged = listener; return () => {} })
    const registerFence = vi.spyOn(mock.api.markdown, 'registerCodeBlockRenderer')
    let resolve!: (entries: Awaited<ReturnType<typeof mock.api.data.files.list>>) => void
    const list = vi.spyOn(mock.api.data.files, 'list').mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const dispose = registerWebFences()
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    for (let index = 0; index < 20; index++) filesChanged('embeds/youtube/provider.json')
    resolve([])
    await waitFor(() => expect(registerFence).toHaveBeenCalledTimes(2))
    expect(list).toHaveBeenCalledTimes(2)
    let release!: (entries: Awaited<ReturnType<typeof mock.api.data.files.list>>) => void
    list.mockImplementationOnce(() => new Promise(done => { release = done }))
    filesChanged('embeds/x/provider.json')
    await waitFor(() => expect(release).toBeTypeOf('function'))
    dispose()
    release([])
    await tick()
    expect(mock.codeBlockRenderers.size).toBe(0)
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('chooses a unique provider selector independently of other fence owners', async () => {
    const mock = createMockValleyApi({ codeBlockClaims: [{ language: 'custom', owner: { kind: 'plugin', pluginId: 'another-owner' } }] })
    initRuntime(mock.api)
    expect(await createCustomEmbedProvider()).toMatchObject({ id: 'custom', language: 'custom' })
    expect(await createCustomEmbedProvider()).toMatchObject({ id: 'custom-2', language: 'custom-2' })
  })

  it('forwards web-navigator new-tab intent to workspace placement', async () => {
    const { api } = createMockValleyApi()
    const dispose = register(api)
    const [navigator] = api.interop.services.providers(WEB_NAVIGATOR_V1)

    expect(
      await navigator.invoke('open', [
        { url: 'https://example.com/docs', title: 'Docs', newTab: true }
      ])
    ).toMatchObject({ ok: true })
    expect(api.workspace.openMainTab).toHaveBeenCalledWith({
      instanceId: expect.any(String),
      title: 'Docs',
      newTab: true
    })
    dispose()
  })

  it('registers the web:open/switch/close command bus and opens a tab on web:open', async () => {
    const { api } = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(api)
    const ids = api.commands.list().map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining(['surfing:open', 'surfing:switch', 'surfing:close']))
    const res = await api.commands.execute('surfing:open', { url: 'example.com' })
    expect(res.ok).toBe(true)
    expect(Object.keys(getStore()!.getSnapshot().tabs)).toHaveLength(1)
    dispose()
  })

  it('opens surfing:open in a new workspace tab instead of replacing the active one', async () => {
    const { api } = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(api)
    const res = await api.commands.execute('surfing:open', { url: 'example.com' })
    expect(res.ok).toBe(true)
    expect(api.workspace.openMainTab).toHaveBeenLastCalledWith({ instanceId: expect.any(String), title: 'example.com', newTab: true })
    dispose()
  })

  it('reveals tabs as an execute effect and refuses unknown tabs as not-applied before dispatch', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(mock.api)
    try {
      const command = (id: string) => mock.commands.find(entry => entry.id === id || entry.id.endsWith(`:${id}`))!
      const run = (id: string, input: unknown) => command(id).run(command(id).input!.parse(input), { caller: 'agent' })
      expect(command('switch')).toMatchObject({ sideEffect: 'execute', recovery: 'non-replayable' })
      const opened = vi.mocked(mock.api.workspace.openMainTab).mock.calls.length, closed = vi.mocked(mock.api.workspace.closeMainTab).mock.calls.length
      for (const [id, input] of [['switch', { instanceId: 'missing' }], ['close', { instanceId: 'missing' }], ['browser-close-tab', { instanceId: 'missing' }], ['browser-click', { instanceId: 'missing', ref: 0 }], ['browser-navigate', { instanceId: 'missing', url: 'https://example.test' }]] as const) {
        await expect(run(id, input), id).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND', outcome: 'not-applied', retryable: false })
      }
      expect(mock.api.workspace.openMainTab).toHaveBeenCalledTimes(opened)
      expect(mock.api.workspace.closeMainTab).toHaveBeenCalledTimes(closed)
      const result = await mock.api.commands.executeOwn('open', { url: 'example.com' })
      if (!result.ok) throw new Error(result.error.message)
      const { instanceId } = result.value as { instanceId: string }
      expect(await mock.api.commands.executeOwn('switch', { instanceId })).toEqual({ ok: true, value: { instanceId } })
      expect(mock.api.workspace.openMainTab).toHaveBeenLastCalledWith({ instanceId })
    } finally { dispose() }
  })

  it('refuses tab and profile writes after a vault switch as not-applied before any effect', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'surfing' }, vault: { path: '/mock/forest', name: 'forest', displayName: 'forest' } })
    const dispose = register(mock.api)
    try {
      const command = (id: string) => mock.commands.find(entry => entry.id === id || entry.id.endsWith(`:${id}`))!
      const run = (id: string, input: unknown) => command(id).run(command(id).input!.parse(input), { caller: 'agent' })
      const opened = await mock.api.commands.executeOwn('open', { url: 'example.com' })
      if (!opened.ok) throw new Error(opened.error.message)
      const { instanceId } = opened.value as { instanceId: string }
      await mock.api.commands.executeOwn('list-profiles', {})
      const store = getStore()!, effects = [vi.spyOn(store, 'deleteProfile'), vi.spyOn(store, 'clearHistory'), vi.spyOn(store, 'closeTab')]
      mock.emitState({ vault: { path: '/mock/other', name: 'other', displayName: 'other' } })
      const refusal = { code: 'OWNER_CHANGED', outcome: 'not-applied', retryable: false }
      await expect(run('close', { instanceId }), 'close').rejects.toMatchObject(refusal)
      await expect(run('delete-profile', { profileId: 'default' }), 'delete-profile').rejects.toMatchObject(refusal)
      await expect(run('clear-history', { profileId: 'default' }), 'clear-history').rejects.toMatchObject(refusal)
      for (const effect of effects) expect(effect).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('refuses stale, protected and missing profile writes as not-applied before any effect', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(mock.api)
    try {
      const command = (id: string) => mock.commands.find(entry => entry.id === id || entry.id.endsWith(`:${id}`))!
      const run = (id: string, input: unknown) => command(id).run(command(id).input!.parse(input), { caller: 'agent' })
      const refused = (code: string) => ({ code, outcome: 'not-applied', retryable: false })
      const read = await mock.api.commands.executeOwn('read-profile-settings', { profileId: 'incognito' })
      if (!read.ok) throw new Error(read.error.message)
      const store = getStore()!, before = structuredClone(store.getSnapshot().profiles)
      const effects = [vi.spyOn(store, 'patchProfileSettings'), vi.spyOn(store, 'deleteProfile'), vi.spyOn(store, 'clearHistory')]
      await expect(run('patch-profile-settings', { profileId: 'default', expectedRevision: '0'.repeat(64), patch: { name: 'Stale' } })).rejects.toMatchObject(refused('REVISION_CONFLICT'))
      await expect(run('patch-profile-settings', { profileId: 'incognito', expectedRevision: (read.value as { revision: string }).revision, patch: { name: 'Public' } })).rejects.toMatchObject(refused('ACTION_UNAVAILABLE'))
      await expect(run('patch-profile-settings', { profileId: 'missing', expectedRevision: '0'.repeat(64), patch: { name: 'Missing' } })).rejects.toMatchObject(refused('TARGET_NOT_FOUND'))
      await expect(run('delete-profile', { profileId: 'incognito' })).rejects.toMatchObject(refused('ACTION_UNAVAILABLE'))
      await expect(run('delete-profile', { profileId: 'default' })).rejects.toMatchObject(refused('ACTION_UNAVAILABLE'))
      await expect(run('delete-profile', { profileId: 'missing' })).rejects.toMatchObject(refused('TARGET_NOT_FOUND'))
      await expect(run('clear-history', { profileId: 'missing' })).rejects.toMatchObject(refused('TARGET_NOT_FOUND'))
      await expect(run('customize-embed-provider', { id: 'missing' })).rejects.toMatchObject(refused('TARGET_NOT_FOUND'))
      for (const effect of effects) expect(effect).not.toHaveBeenCalled()
      expect(store.getSnapshot().profiles).toEqual(before)
    } finally { dispose() }
  })

  it('refuses saved-page and history writes whose pre-effect observation fails as not-applied', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(mock.api)
    try {
      const command = (id: string) => mock.commands.find(entry => entry.id === id || entry.id.endsWith(`:${id}`))!
      const run = (id: string, input: unknown) => command(id).run(command(id).input!.parse(input), { caller: 'agent' })
      const refused = (code: string) => ({ code, outcome: 'not-applied', retryable: false })
      await mock.api.commands.executeOwn('list-profiles', {})
      const store = getStore()!, internals = store as unknown as { listLoads: Map<string, unknown>; listRevisions: Map<string, number> }
      const page = { profileId: 'default', kind: 'favorite', url: 'https://forest.example/' }
      const backend = vi.mocked(mock.api.backend.call), real = backend.getMockImplementation()!
      const writes = () => backend.mock.calls.filter(([method]) => method === 'data.saved.set' || method === 'data.history.clear')
      await store.ensureProfileLoaded('default')
      internals.listRevisions.delete('saved:default:favorite')
      await expect(run('save-page', page)).rejects.toMatchObject(refused('REVISION_CONFLICT'))
      backend.mockImplementation(async (method, input, options) => {
        if (method === 'data.saved.list' || method === 'data.history.list') throw new Error('Backend unavailable')
        return real(method, input, options)
      })
      internals.listLoads.clear()
      await expect(run('save-page', page)).rejects.toMatchObject({ ...refused('ACTION_UNAVAILABLE'), message: 'Backend unavailable' })
      await expect(run('remove-page', { ...page, kind: 'reading' })).rejects.toMatchObject(refused('ACTION_UNAVAILABLE'))
      store.reportUrl(store.openTab(''), 'https://forest.example/visit')
      await expect(run('clear-history', { profileId: 'default' })).rejects.toMatchObject(refused('ACTION_UNAVAILABLE'))
      expect(writes()).toEqual([])
      expect(store.isFavorite('default', page.url)).toBe(false)
    } finally { dispose() }
  })

  it('edits every profile setting through its typed owner command and rejects stale revisions', async () => {
    const { api } = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(api)
    try {
      const read = await api.commands.executeOwn('read-profile-settings', { profileId: 'default' })
      expect(read.ok).toBe(true)
      if (!read.ok) throw new Error(read.error.message)
      const revision = (read.value as { revision: string }).revision
      const patch = { name: 'Canopy', icon: 'leaf', hidden: false, adblockEnabled: false, adblockRules: 'https://example.test/rules.txt', adblockFrequency: 14 }
      const updated = await api.commands.executeOwn('patch-profile-settings', { profileId: 'default', expectedRevision: revision, patch })
      const { hidden: _hidden, ...storedPatch } = patch
      expect(updated, JSON.stringify(updated)).toMatchObject({ ok: true, value: { profile: storedPatch } })
      expect(getStore()!.getSnapshot().profiles.find(profile => profile.id === 'default')).toMatchObject(storedPatch)
      expect(getStore()!.getSnapshot().profiles.find(profile => profile.id === 'default')!.hidden).not.toBe(true)
      expect(await api.commands.executeOwn('patch-profile-settings', { profileId: 'default', expectedRevision: revision, patch: { name: 'Stale' } })).toMatchObject({ ok: false, error: { message: expect.stringContaining('profile changed') } })
      expect(getStore()!.getSnapshot().profiles.find(profile => profile.id === 'default')!.name).toBe('Canopy')
      expect(await api.commands.executeOwn('patch-profile-settings', { profileId: 'default', expectedRevision: revision, patch: { adblockFrequency: -1 } })).toMatchObject({ ok: false })
    } finally { dispose() }
  })

  it('commits profile and ad-block settings atomically across independent owners without retrying stale edits', async () => {
    const mock = createMockValleyApi()
    initRuntime(mock.api)
    const first = new WebStore(mock.api)
    const second = new WebStore(mock.api)
    try {
      await first.loadConfig()
      await second.loadConfig()
      const results = await Promise.allSettled([
        first.patchProfileSettings('default', { name: 'Forest', adblockEnabled: false }),
        second.patchProfileSettings('default', { name: 'Lake', adblockEnabled: true })
      ])
      expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect(await mock.api.data.dataset('profiles').get({ id: 'default' })).toMatchObject({ name: 'Forest' })
      expect(await mock.api.data.dataset('profile_adblock').get({ profileId: 'default' })).toMatchObject({ adblockEnabled: false })
      expect(await mock.api.data.dataset('profiles').get({ id: 'default' })).toMatchObject({ name: 'Forest' })
      await second.flushProfiles()
      expect(second.getSnapshot().profileError).toBeUndefined()
      expect(second.getSnapshot().profiles.find(profile => profile.id === 'default')).toMatchObject({ name: 'Forest', adblockEnabled: false })
      await second.patchProfileSettings('default', { name: 'Reviewed' })
      expect(await mock.api.data.dataset('profiles').get({ id: 'default' })).toMatchObject({ name: 'Reviewed' })
    } finally { await first.dispose(); await second.dispose() }
  })

  it('recovers profile commands after one failed profile write and refuses without effect while the state is unknown', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(mock.api)
    try {
      await getStore()!.loadConfig()
      const call = vi.mocked(mock.api.backend.call), real = call.getMockImplementation()!
      call.mockImplementationOnce(async (method, input, options) => {
        if (method !== 'data.profiles.set') return real(method, input, options)
        throw new Error('Store briefly unavailable')
      })
      expect(await mock.api.commands.executeOwn('create-profile', { name: 'Lost' })).toMatchObject({ ok: false, error: { message: 'Store briefly unavailable' } })
      await getStore()!.flushProfiles()
      expect(getStore()!.getSnapshot().profileError).toBeUndefined()
      expect(getStore()!.getSnapshot().profiles.map(profile => profile.name)).not.toContain('Lost')
      const created = await mock.api.commands.executeOwn('create-profile', { name: 'Fungi' })
      expect(created, JSON.stringify(created)).toMatchObject({ ok: true, value: { name: 'Fungi' } })

      call.mockImplementation(async (method, input, options) => {
        if (method === 'data.profiles.set' || method === 'data.profiles.list') throw new Error('Store unavailable')
        return real(method, input, options)
      })
      expect(await mock.api.commands.executeOwn('create-profile', { name: 'Lost again' })).toMatchObject({ ok: false })
      await getStore()!.flushProfiles()
      expect(getStore()!.getSnapshot().profileError).toContain('profile changed')
      const writes = call.mock.calls.filter(([method]) => method === 'data.profiles.set').length
      const createProfile = mock.commands.find(entry => entry.id === 'create-profile' || entry.id.endsWith(':create-profile'))!
      await expect(createProfile.run(createProfile.input!.parse({ name: 'Refused' }), { caller: 'agent' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
      expect(call.mock.calls.filter(([method]) => method === 'data.profiles.set')).toHaveLength(writes)
      call.mockImplementation(real)
      await getStore()!.loadConfig()
      expect(await mock.api.commands.executeOwn('create-profile', { name: 'Back' })).toMatchObject({ ok: true })
    } finally { dispose() }
  })

  it('refuses profile and browser-data commands before any effect as not-applied and keeps later failures unknown', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(mock.api)
    const command = (id: string) => mock.commands.find(entry => entry.id === id || entry.id.endsWith(`:${id}`))!
    const run = (id: string, input: unknown): Promise<unknown> => { const entry = command(id); return Promise.resolve(entry.run(entry.input!.parse(input), { caller: 'agent' })) }
    try {
      await getStore()!.loadConfig()
      const call = vi.mocked(mock.api.backend.call)
      const writes = () => call.mock.calls.filter(([method]) => method === 'data.profiles.set').length
      const before = writes()
      await expect(run('create-profile', { name: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'INVALID_INPUT', outcome: 'not-applied', retryable: false })
      expect(writes()).toBe(before)
      expect(getStore()!.getSnapshot().profiles.some(profile => profile.name.startsWith('xxx'))).toBe(false)

      const bind = vi.spyOn(mock.api.drivers.browser, 'bindPartition').mockResolvedValueOnce({ ok: false, error: 'Partition unavailable' })
      const clear = vi.spyOn(mock.api.drivers.browser, 'clearData')
      await expect(run('clear-browser-data', { profileId: 'default' })).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE', outcome: 'not-applied', message: 'Partition unavailable' })
      expect(clear).not.toHaveBeenCalled()
      bind.mockResolvedValue({ ok: true })
      clear.mockResolvedValueOnce({ ok: false, error: 'Clear failed' })
      const unverified = await run('clear-browser-data', { profileId: 'default' }).catch((error: unknown) => error)
      expect(unverified).toMatchObject({ message: 'Clear failed' })
      expect((unverified as { outcome?: unknown }).outcome).toBeUndefined()
      clear.mockResolvedValueOnce({ ok: false, error: 'Partition busy', code: 'ACTION_UNAVAILABLE', outcome: 'not-applied' } as never)
      await expect(run('clear-browser-data', { profileId: 'default' })).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE', outcome: 'not-applied' })

      const created = await mock.api.commands.executeOwn('create-profile', { name: 'Fungi' }) as { ok: true; value: { id: string } }
      expect(created.ok).toBe(true)
      clear.mockResolvedValueOnce({ ok: false, error: 'Partition busy', code: 'ACTION_UNAVAILABLE', outcome: 'not-applied' } as never)
      await expect(run('delete-profile', { profileId: created.value.id })).rejects.toMatchObject({ code: 'EFFECT_UNVERIFIED', outcome: 'unknown' })
      expect(getStore()!.getSnapshot().profiles.some(profile => profile.id === created.value.id)).toBe(false)
    } finally { dispose() }
  })

  it('exposes embed provider discovery and guarded create/customize actions through commands', async () => {
    const mock = createMockValleyApi()
    const off = register(mock.api)
    try {
      const listed = await mock.api.commands.executeOwn('list-embed-providers')
      expect(listed).toMatchObject({ ok: true, value: { providers: expect.arrayContaining([expect.objectContaining({ id: 'youtube' })]) } })
      const customized = await mock.api.commands.executeOwn('customize-embed-provider', { id: 'youtube' })
      expect(customized).toMatchObject({ ok: true, value: { provider: { id: 'youtube' } } })
      const created = await mock.api.commands.executeOwn('create-embed-provider')
      expect(created).toMatchObject({ ok: true, value: { provider: { id: 'custom' } } })
      expect(await mock.api.commands.executeOwn('customize-embed-provider', { id: 'missing' })).toMatchObject({ ok: false })
    } finally { off() }
  })

  it('undoes and redoes embed provider create/customize routes to the exact prior files and refuses over newer edits', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(mock.api)
    try {
      type Revert = { run(): Promise<void>; reapply(): Promise<void> } | null
      const command = (id: string) => mock.commands.find(entry => entry.id === id || entry.id.endsWith(`:${id}`))!
      const run = async (id: string, input?: unknown) => await command(id).run(command(id).input ? command(id).input!.parse(input) : input, { caller: 'agent' }) as unknown as { value: { provider: EmbedProvider }; revert: Revert }
      const read = async (path: string): Promise<Array<[string, string | null]>> => (await Promise.all((await mock.api.data.files.list(path)).map(async entry => entry.isDirectory ? read(`${path}/${entry.name}`) : [[`${path}/${entry.name}`, await mock.api.data.files.readText(`${path}/${entry.name}`)] as [string, string | null]]))).flat()
      const files = async () => Object.fromEntries(await read('embeds'))
      const empty = await files()
      const created = await run('create-embed-provider')
      const afterCreate = await files()
      await created.revert!.run()
      expect(await files()).toEqual(empty)
      await created.revert!.reapply()
      expect(await files()).toEqual(afterCreate)
      const listed = await mock.api.backend.call<EmbedProviderConfiguration>('providers.list', {})
      await mock.api.backend.call('providers.set', { provider: { ...created.value.provider, displayName: 'Edited later' }, expected: { ...listed.revisions.custom, catalog: listed.catalogRevision } })
      const edited = await files()
      await expect(created.revert!.run()).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
      expect(await files()).toEqual(edited)
      const customized = await run('customize-embed-provider', { id: 'youtube' })
      const afterCustomize = await files()
      await customized.revert!.run()
      expect(await files()).toEqual(edited)
      await customized.revert!.reapply()
      expect(await files()).toEqual(afterCustomize)
      expect((await run('customize-embed-provider', { id: 'youtube' })).revert).toBeNull()
      expect(await files()).toEqual(afterCustomize)
    } finally { dispose() }
  })

  it('offers no embed provider undo when deleting would not restore the exact prior bytes', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(mock.api)
    try {
      const command = (id: string) => mock.commands.find(entry => entry.id === id || entry.id.endsWith(`:${id}`))!
      const run = async (id: string, input?: unknown) => await command(id).run(command(id).input ? command(id).input!.parse(input) : input, { caller: 'agent' }) as unknown as { revert: unknown }
      await mock.api.data.files.writeTextGuarded('embeds/youtube/renderer.tsx', '', null)
      expect((await run('customize-embed-provider', { id: 'youtube' })).revert).toBeNull()
      await mock.api.data.files.writeTextGuarded('embeds/x/provider.json', '', null)
      expect((await run('customize-embed-provider', { id: 'x' })).revert).toBeNull()
      const catalog = await mock.api.data.files.readTextBaseline('embeds/catalog.json')
      await mock.api.data.files.writeTextGuarded('embeds/catalog.json', `${JSON.stringify(JSON.parse(catalog!.content), null, 2)}\n`, catalog!.baseline)
      expect((await run('create-embed-provider')).revert).toBeNull()
    } finally { dispose() }
  })

  it('refuses embed provider undo and redo after a vault switch before reaching any backend', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'surfing' }, vault: { path: '/mock/forest', name: 'forest', displayName: 'forest' } })
    const dispose = register(mock.api)
    try {
      const command = mock.commands.find(entry => entry.id === 'create-embed-provider' || entry.id.endsWith(':create-embed-provider'))!
      const created = await command.run(undefined, { caller: 'agent' }) as unknown as { revert: { run(): Promise<void>; reapply(): Promise<void> } }
      const call = vi.spyOn(mock.api.backend, 'call')
      const after = await mock.api.data.files.readText('embeds/custom/provider.json')
      mock.emitState({ vault: { path: '/mock/other', name: 'other', displayName: 'other' } })
      const refusal = { code: 'OWNER_CHANGED', outcome: 'not-applied', message: 'The vault changed since this action ran, so it can’t be undone or redone here.' }
      await expect(created.revert.run()).rejects.toMatchObject(refusal)
      await expect(created.revert.reapply()).rejects.toMatchObject(refusal)
      expect(call).not.toHaveBeenCalled()
      expect(after).toBeTruthy()
      expect(await mock.api.data.files.readText('embeds/custom/provider.json')).toBe(after)
    } finally { dispose() }
  })

  it('never replaces a provider created by another owner between discovery and file creation', async () => {
    const mock = createMockValleyApi()
    initRuntime(mock.api)
    const original = mock.api.data.files.writeTextGuarded.bind(mock.api.data.files)
    const write = vi.spyOn(mock.api.data.files, 'writeTextGuarded')
    let raced = false
    write.mockImplementation(async (path, content, baseline) => {
      if (!raced && path.endsWith('/provider.json')) {
        raced = true
        await original(path, 'Externally created provider', null)
      }
      return original(path, content, baseline)
    })
    await expect(createCustomEmbedProvider()).rejects.toThrow('changed')
    expect(await mock.api.data.files.readText('embeds/custom/provider.json')).toBe('Externally created provider')
  })

  it('enforces the normal-profile invariant through the plugin command API', async () => {
    const { api } = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(api)
    const created = await api.commands.executeOwn('create-profile', { name: 'Fungi' })
    expect(created).toMatchObject({ ok: true, value: { name: 'Fungi' } })
    const fungi = getStore()!.getSnapshot().profiles.find((profile) => profile.name === 'Fungi')!

    expect(await api.commands.executeOwn('delete-profile', { profileId: 'default' })).toMatchObject({ ok: true })
    expect(await api.commands.executeOwn('delete-profile', { profileId: fungi.id })).toMatchObject({
      ok: false,
      error: { message: 'At least one normal browser profile must remain.' }
    })

    dispose()
  })
})

describe('web store (one site per tab)', () => {
  it('keeps a stale hot-reload disposer from tearing down the replacement store', () => {
    const { api } = createMockValleyApi()
    initRuntime(api)
    const first = createStore(api)
    const second = createStore(api)
    disposeStore(api, first)
    expect(getStore()).toBe(second)
    disposeStore(api, second)
    expect(getStore()).toBeNull()
  })

  it('openTab creates a distinct per-instance tab with a normalized url', () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    const a = store.openTab('example.com')
    const b = store.openTab('other.com')
    expect(a).not.toBe(b)
    expect(store.getTab(a)?.url).toBe('https://example.com')
    expect(Object.keys(store.getSnapshot().tabs)).toHaveLength(2)
  })

  it('navigate/setTitle mutate only the addressed tab', () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    const a = store.openTab('a.com')
    const b = store.openTab('b.com')
    store.setTitle(a, 'Alpha')
    store.navigate(b, 'b.org')
    expect(store.getTab(a)?.title).toBe('Alpha')
    expect(store.getTab(a)?.url).toBe('https://a.com')
    expect(store.getTab(b)?.title).toBe('')
    expect(store.getTab(b)?.url).toBe('https://b.org')
  })

  it('closeTab removes a single tab', () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    const a = store.openTab('a.com')
    const b = store.openTab('b.com')
    store.closeTab(a)
    expect(store.getTab(a)).toBeUndefined()
    expect(store.getTab(b)).toBeDefined()
  })
})

describe('web store (open-tab persistence across reload)', () => {
  it('loadConfig restores the page each persisted tab was showing', async () => {
    const { api } = createMockValleyApi({
      datasets: {
        'surfing.tabs': [
          { id: 'web-1', url: 'https://news.example', title: 'News', profileId: 'default' },
          { id: 'web-2', url: 'https://docs.example', title: 'Docs', profileId: 'gone' }
        ]
      }
    })
    vi.spyOn(api.workspace, 'getOpenMainTabs').mockReturnValue(['web-1', 'web-2'])
    const store = createStore(api)
    await store.loadConfig()
    expect(store.getTab('web-1')?.url).toBe('https://news.example')
    expect(store.getTab('web-1')?.title).toBe('News')
    // A tab whose profile no longer exists falls back to the default profile.
    expect(store.getTab('web-2')?.url).toBe('https://docs.example')
    expect(store.getTab('web-2')?.profileId).toBe('default')
  })

  it('a tab the user already navigated is not clobbered by the saved page', async () => {
    const { api } = createMockValleyApi({
      datasets: { 'surfing.tabs': [{ id: 'web-1', url: 'https://old.example', title: '', profileId: 'default' }] }
    })
    const store = createStore(api)
    // Page mounted + user navigated before the async restore landed.
    store.ensureTab('web-1')
    store.navigate('web-1', 'fresh.example')
    await store.loadConfig()
    expect(store.getTab('web-1')?.url).toBe('https://fresh.example')
  })

  it('persists open tabs to disk so a reload can reopen them', async () => {
    vi.useFakeTimers()
    try {
      const { api, datasets } = createMockValleyApi()
      const store = createStore(api)
      await store.loadConfig() // arms persistence
      const a = store.openTab('example.com')
      store.reportUrl(a, 'https://example.com/article')
      await vi.advanceTimersByTimeAsync(500) // flush the debounced write
      const saved = datasets.get('surfing.tabs') ?? []
      expect(saved).toEqual([{ id: a, url: 'https://example.com/article', title: '', profileId: 'default' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('records five link navigations in one tab with at most ten dataset operations', async () => {
    vi.useFakeTimers()
    try {
      const { api, datasets } = createMockValleyApi()
      const store = createStore(api)
      await store.loadConfig()
      const id = store.openTab('https://forest.example/p/0')
      await vi.advanceTimersByTimeAsync(500)
      const counts = { read: 0, write: 0 }
      const reads = new Set(['get', 'read', 'query', 'count', 'aggregate'])
      const dataset = api.data.dataset.bind(api.data), transaction = api.data.transaction.bind(api.data), snapshot = api.data.snapshot.bind(api.data)
      vi.spyOn(api.data, 'dataset').mockImplementation(globalId => {
        const value = dataset(globalId)
        return Object.fromEntries(Object.entries(value).map(([name, method]) => [name, name === 'subscribe' ? method : (...args: unknown[]) => { counts[reads.has(name) ? 'read' : 'write']++; return (method as (...input: unknown[]) => unknown)(...args) }])) as typeof value
      })
      vi.spyOn(api.data, 'transaction').mockImplementation((...args) => { counts.write++; return transaction(...args) })
      vi.spyOn(api.data, 'snapshot').mockImplementation((...args) => { counts.read++; return snapshot(...args) })
      for (let page = 1; page <= 5; page++) {
        store.reportUrl(id, `https://forest.example/p/${page}`)
        store.setTitle(id, `Page ${page}`)
        await vi.advanceTimersByTimeAsync(500)
      }
      expect(counts.read + counts.write).toBeLessThanOrEqual(10)
      expect(counts.read).toBe(0)
      expect((datasets.get('surfing.visits') ?? []).map(row => row.url)).toEqual([1, 2, 3, 4, 5].map(page => `https://forest.example/p/${page}`))
      expect(datasets.get('surfing.tabs')).toEqual([{ id, url: 'https://forest.example/p/5', title: 'Page 5', profileId: 'default' }])
      store.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops tab records left by a torn-down surface when the store activates', async () => {
    vi.useFakeTimers()
    try {
      const { api, datasets } = createMockValleyApi({
        datasets: {
          'surfing.tabs': [
            { id: 'web-open', url: 'https://open.example', title: 'Open', profileId: 'default' },
            { id: 'web-gone', url: 'https://gone.example', title: 'Gone', profileId: 'default' }
          ]
        }
      })
      vi.spyOn(api.workspace, 'getOpenMainTabs').mockReturnValue(['web-open'])
      const store = createStore(api)
      await store.loadConfig()
      expect(store.getTab('web-open')?.url).toBe('https://open.example')
      expect(store.getTab('web-gone')).toBeUndefined()
      await vi.advanceTimersByTimeAsync(500)
      expect((datasets.get('surfing.tabs') ?? []).map(row => row.id)).toEqual(['web-open'])
      store.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes back its open tab records after another window activates and drops them', async () => {
    vi.useFakeTimers()
    try {
      const { api, datasets } = createMockValleyApi()
      vi.spyOn(api.workspace, 'getOpenMainTabs').mockReturnValue([])
      const first = new WebStore(api)
      await first.loadConfig()
      const id = first.openTab('https://first.example')
      await vi.advanceTimersByTimeAsync(500)
      const second = new WebStore(api)
      await second.loadConfig()
      await vi.advanceTimersByTimeAsync(1000)
      expect(second.getTab(id)).toBeUndefined()
      expect(datasets.get('surfing.tabs')).toEqual([{ id, url: 'https://first.example', title: '', profileId: 'default' }])
      first.dispose()
      second.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('web active-context interop', () => {
  it('publishes the typed active context and notifies subscribers', () => {
    const { api } = createMockValleyApi()
    initRuntime(api)
    let notifications = 0
    const off = api.interop.state.subscribe(WEB_ACTIVE_CONTEXT_V1, () => notifications++)
    publishWebContext({ instanceId: 'web-1', url: 'https://a.test/p', title: 'A' })
    expect(api.interop.state.get(WEB_ACTIVE_CONTEXT_V1)).toEqual({
      instanceId: 'web-1',
      url: 'https://a.test/p',
      title: 'A'
    })
    expect(notifications).toBe(1)
    off()
  })

  it('publishWebContext is idempotent — no publish when nothing changed', () => {
    const { api } = createMockValleyApi()
    initRuntime(api)
    let count = 0
    const off = api.interop.state.subscribe(WEB_ACTIVE_CONTEXT_V1, () => count++)
    publishWebContext({ instanceId: 'web-1', url: 'https://a.test/p', title: 'A' })
    publishWebContext({ instanceId: 'web-1', url: 'https://a.test/p', title: 'A' })
    publishWebContext({ instanceId: 'web-1', url: 'https://a.test/p', title: 'A2' })
    expect(count).toBe(2) // first publish + the title change
    off()
  })

  it('clearWebContext only clears when the instance still owns the context', () => {
    const { api } = createMockValleyApi()
    initRuntime(api)
    publishWebContext({ instanceId: 'web-1', url: 'https://a.test', title: '' })
    publishWebContext({ instanceId: 'web-2', url: 'https://b.test', title: '' })
    // web-1 was already superseded by web-2 → its clear is a no-op.
    clearWebContext('web-1')
    expect(api.interop.state.get(WEB_ACTIVE_CONTEXT_V1)).toMatchObject({ instanceId: 'web-2' })
    clearWebContext('web-2')
    expect(api.interop.state.get(WEB_ACTIVE_CONTEXT_V1)).toBeNull()
  })

  it('routes selected text through a typed extension provider', () => {
    const { api } = createMockValleyApi()
    initRuntime(api)
    const run = vi.fn()
    api.interop.extensions.provide(TEXT_SELECTION_ACTION_V1, {
      id: 'forest-note',
      labelKey: 'sidenotes.create',
      label: 'Create note',
      surfaces: ['web'],
      run
    })
    requestWebNoteFromSelection('https://a.test/p', '  picked text  ')
    expect(run).toHaveBeenCalledWith({ surface: 'web', url: 'https://a.test/p', text: 'picked text' })
  })
})

describe('web store (selection capture)', () => {
  it('getSelectionText reads + trims the guest selection, and is safe when absent', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    ;(store as unknown as { views: Map<string, unknown> }).views.set('web-1', {
      executeJavaScript: vi.fn().mockResolvedValue('  selected words  ')
    })
    expect(await store.getSelectionText('web-1')).toBe('selected words')
    // Unknown tab → empty string, never throws.
    expect(await store.getSelectionText('missing')).toBe('')
  })

  it('keeps public tab ids out of the browser driver and acts through its opaque handle', async () => {
    const mock = createMockValleyApi()
    const store = createStore(mock.api)
    store.ensureTab('web-1')
    const guestId = crypto.randomUUID()
    vi.spyOn(mock.api.drivers.browser, 'list').mockResolvedValue({ ok: true, data: { guests: [{ guestId, url: 'https://example.test', title: 'Fixture' }] } })
    store.readyGuest('web-1', { type: 'ready', guestId, url: 'https://example.test' })
    const listed = await store.listBrowserTabs()
    await store.browserSnapshot('web-1')

    expect(listed.data?.tabs.map((tab) => tab.instanceId)).toEqual(['web-1'])
    expect(mock.driverCalls.some((call) => call.method === 'register')).toBe(false)
    const payload = mock.driverCalls.find((call) => call.method === 'execute')?.payload as { guestId?: string }
    expect(payload.guestId).toBe(guestId)
    expect(payload.guestId).not.toBe('web-1')
    store.dispose()
  })
})

describe('toUrl (address-bar normalization)', () => {
  it('keeps explicit schemes', () => {
    expect(toUrl('https://x.com/a')).toBe('https://x.com/a')
    expect(toUrl('http://localhost:3000')).toBe('http://localhost:3000')
  })
  it('https-prefixes a bare domain', () => {
    expect(toUrl('example.com')).toBe('https://example.com')
    expect(toUrl('news.ycombinator.com/news')).toBe('https://news.ycombinator.com/news')
  })
  it('treats free text as a web search', () => {
    expect(toUrl('hello world')).toBe('https://www.google.com/search?q=hello%20world')
  })
  it('searches with the chosen engine', () => {
    expect(toUrl('hello', 'duckduckgo')).toBe('https://duckduckgo.com/?q=hello')
  })
})

describe('profiles (pure helpers)', () => {
  it('partitionFor isolates each profile (and the default)', () => {
    expect(partitionFor('default')).toBe('persist:web-default')
    expect(partitionFor('p-abc')).toBe('persist:web_p-abc')
    expect(partitionFor('a')).not.toBe(partitionFor('b'))
  })

  it('searchUrl encodes per engine and falls back to google', () => {
    expect(searchUrl('google', 'a b')).toBe('https://www.google.com/search?q=a%20b')
    expect(searchUrl('bing', 'x')).toBe('https://www.bing.com/search?q=x')
    expect(searchUrl('duckduckgo', 'x')).toBe('https://duckduckgo.com/?q=x')
    expect(searchUrl('baidu', 'a b')).toBe('https://www.baidu.com/s?wd=a%20b')
    expect(searchUrl('yahoo', 'a b')).toBe('https://search.yahoo.com/search?p=a%20b')
    expect(searchUrl('nope' as 'google', 'x')).toContain('google.com')
  })

  it('normalizeSettings fills defaults and rejects invalid values', () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
    const n = normalizeSettings({ searchEngine: 'bogus', adblockFrequency: -5, homepage: 42 })
    expect(n.searchEngine).toBe('google')
    expect(n.homepage).toBe('')
    const m = normalizeSettings({ searchEngine: 'duckduckgo', adblockEnabled: false })
    expect(m.searchEngine).toBe('duckduckgo')
    expect(m).not.toHaveProperty('adblockEnabled')
  })

  it('normalizeProfile drops id-less records and defaults the name to the id', () => {
    expect(normalizeProfile({ id: '', name: 'x' })).toBeNull()
    expect(normalizeProfile({ name: 'x' })).toBeNull()
    expect(normalizeProfile({ id: 'p1' })?.name).toBe('p1')
    expect(normalizeProfile({ id: 'p1', name: 'Fungi' })?.name).toBe('Fungi')
  })
})

describe('web store (profiles + active)', () => {
  it('adds, renames, switches active, and deletes profiles', async () => {
    const { api, driverCalls } = createMockValleyApi()
    const store = createStore(api)
    await store.loadConfig()
    const id = store.addProfile('Fungi')
    expect(store.getSnapshot().profiles.map((p) => p.name)).toContain('Fungi')
    expect(store.getSnapshot().profiles.some((p) => p.id === 'default')).toBe(true)
    expect(store.getSnapshot().profiles.some((p) => p.id === INCOGNITO_PROFILE_ID)).toBe(true)

    store.renameProfile(id, 'Job')
    expect(store.getSnapshot().profiles.find((p) => p.id === id)?.name).toBe('Job')

    store.setActiveProfile(id)
    expect(store.getSnapshot().activeProfileId).toBe(id)

    await store.deleteProfile(id)
    expect(store.getSnapshot().profiles.find((p) => p.id === id)).toBeUndefined()
    expect(store.getSnapshot().activeProfileId).toBe('default')
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual(['default', INCOGNITO_PROFILE_ID])
    expect(driverCalls).toContainEqual(expect.objectContaining({
      driver: 'browser',
      method: 'clearData',
      payload: { partition: partitionFor(id) }
    }))
  })

  it('protects the last normal profile and always protects Incognito', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    await store.deleteProfile('default')
    await store.deleteProfile(INCOGNITO_PROFILE_ID)
    expect(store.getSnapshot().profiles.some((p) => p.id === 'default')).toBe(true)
    expect(store.getSnapshot().profiles.some((p) => p.id === INCOGNITO_PROFILE_ID)).toBe(true)
  })

  it('keeps Default beside custom profiles and allows deleting either while another remains', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    await store.loadConfig()
    const fungi = store.addProfile('Fungi')
    const plants = store.addProfile('Plants')

    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual(['default', fungi, plants, INCOGNITO_PROFILE_ID])

    await store.deleteProfile('default')
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual([fungi, plants, INCOGNITO_PROFILE_ID])

    await store.deleteProfile(fungi)
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual([plants, INCOGNITO_PROFILE_ID])
    await store.deleteProfile(plants)
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual([plants, INCOGNITO_PROFILE_ID])
  })

  it('moves open tabs to the replacement normal profile', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    await store.loadConfig()
    const fungi = store.addProfile('Fungi')
    const tab = store.openTab('example.com', fungi)
    expect(store.getTab(tab)?.profileId).toBe(fungi)

    await store.deleteProfile(fungi)
    expect(store.getTab(tab)?.profileId).toBe('default')
  })
})

describe('web store (per-profile history)', () => {
  it('appends, dedupes consecutive same-url visits, and clears', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    const a = store.openTab('')
    const b = store.openTab('')
    store.reportUrl(a, 'https://news.example')
    store.reportUrl(b, 'https://news.example') // same url, same (default) profile → deduped
    store.reportUrl(a, 'https://other.example')

    const hist = await store.readHistory('default')
    expect(hist.map((e) => e.url)).toEqual(['https://other.example', 'https://news.example'])

    await store.clearHistory('default')
    expect(await store.readHistory('default')).toHaveLength(0)
  })

  it('keeps history isolated per profile', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    await store.loadConfig()
    const fungi = store.addProfile('Fungi')
    store.setActiveProfile(fungi)
    const t = store.openTab('')
    store.reportUrl(t, 'https://fungi.example')

    expect((await store.readHistory(fungi)).map((e) => e.url)).toEqual(['https://fungi.example'])
    expect(await store.readHistory('default')).toHaveLength(0)
  })
})

describe('saved-page helpers + permanent Incognito profile', () => {
  it('normalizeSavedPage drops url-less records and defaults title/ts', () => {
    expect(normalizeSavedPage({})).toBeNull()
    expect(normalizeSavedPage({ title: 'x' })).toBeNull()
    expect(normalizeSavedPage({ url: 'https://a.test' })).toEqual({ url: 'https://a.test', title: '', ts: 0 })
    expect(normalizeSavedPage({ url: 'https://a.test', title: 'A', ts: 5 })).toEqual({ url: 'https://a.test', title: 'A', ts: 5 })
  })

  it('normalizeProfile carries the private flag', () => {
    expect(normalizeProfile({ id: 'p1' })?.private).toBeUndefined()
    expect(normalizeProfile({ id: 'incognito', private: true })?.private).toBe(true)
  })

  it('first run creates Default + an in-memory Incognito profile', async () => {
    const { api, datasets } = createMockValleyApi()
    const store = createStore(api)
    await store.loadConfig()
    const profiles = store.getSnapshot().profiles
    expect(profiles.map((p) => p.id)).toEqual(['default', INCOGNITO_PROFILE_ID])
    expect(profiles.find((p) => p.id === INCOGNITO_PROFILE_ID)?.private).toBe(true)
    expect((datasets.get('surfing.profiles') ?? []).map((r) => r.id)).toEqual(['default'])
  })

  it('repairs an existing profile set so Incognito is always available', async () => {
    const { api } = createMockValleyApi({ datasets: { 'surfing.profiles': [{ id: 'default', name: 'Default', createdAt: 0 }] } })
    const store = createStore(api)
    await store.loadConfig()
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual(['default', INCOGNITO_PROFILE_ID])
  })

  it('round-trips a renamed Default profile and its chosen icon', async () => {
    const { api } = createMockValleyApi()
    let store = createStore(api)
    await store.loadConfig()
    store.renameProfile('default', 'Canopy')
    store.setProfileIcon('default', 'leaf')
    await store.flushProfiles()

    store = createStore(api)
    await store.loadConfig()
    expect(store.getSnapshot().profiles[0]).toMatchObject({
      id: 'default',
      name: 'Canopy',
      icon: 'leaf'
    })
  })

  it('preserves the Default profile when persisted custom profiles exist', async () => {
    const { api } = createMockValleyApi({
      datasets: {
        'surfing.profiles': [
          { id: 'default', name: 'Default', createdAt: 0 },
          { id: 'p-fungi', name: 'Fungi', createdAt: 1 }
        ]
      }
    })
    const store = createStore(api)
    await store.loadConfig()
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual(['default', 'p-fungi', INCOGNITO_PROFILE_ID])
    expect(store.getSnapshot().activeProfileId).toBe('default')
  })
})

describe('web store (favorites)', () => {
  it('toggleFavorite adds then removes, persists, and reflects via isFavorite', async () => {
    const { api, datasets } = createMockValleyApi()
    const store = createStore(api)
    const page = { url: 'https://fav.example', title: 'Favorite', ts: 1 }

    expect(await store.toggleFavorite('default', page)).toBe(true)
    expect(store.isFavorite('default', page.url)).toBe(true)
    expect((datasets.get('surfing.saved_pages') ?? []).filter((r) => r.kind === 'favorite').map((r) => r.url)).toEqual(['https://fav.example'])

    expect(await store.toggleFavorite('default', page)).toBe(false)
    expect(store.isFavorite('default', page.url)).toBe(false)
    expect((datasets.get('surfing.saved_pages') ?? []).filter((r) => r.kind === 'favorite')).toEqual([])
  })

  it('keeps favorites isolated per profile', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    await store.loadConfig()
    const fungi = store.addProfile('Fungi')
    await store.toggleFavorite('default', { url: 'https://a.example', title: 'A', ts: 1 })
    await store.toggleFavorite(fungi, { url: 'https://b.example', title: 'B', ts: 2 })

    expect(store.isFavorite('default', 'https://a.example')).toBe(true)
    expect(store.isFavorite('default', 'https://b.example')).toBe(false)
    expect(store.isFavorite(fungi, 'https://b.example')).toBe(true)
  })
})

describe('web store (reading list)', () => {
  it('addToReadingList / removeFromReadingList persist newest-first', async () => {
    const { api, datasets } = createMockValleyApi()
    const store = createStore(api)
    await store.addToReadingList('default', { url: 'https://one.example', title: 'One', ts: 1 })
    await store.addToReadingList('default', { url: 'https://two.example', title: 'Two', ts: 2 })
    expect((datasets.get('surfing.saved_pages') ?? []).filter((r) => r.kind === 'reading').map((r) => r.url)).toEqual([
      'https://two.example',
      'https://one.example'
    ])

    await store.removeFromReadingList('default', 'https://one.example')
    expect((datasets.get('surfing.saved_pages') ?? []).filter((r) => r.kind === 'reading').map((r) => r.url)).toEqual(['https://two.example'])
  })
})

describe('web store (private profile + active-list snapshot)', () => {
  it('a private (Incognito) profile records no history', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    await store.loadConfig() // seeds the private Incognito profile
    store.setActiveProfile(INCOGNITO_PROFILE_ID)
    const incog = store.openTab('')
    store.reportUrl(incog, 'https://private.example')
    expect(await store.readHistory(INCOGNITO_PROFILE_ID)).toHaveLength(0)

    // A normal profile still logs.
    store.setActiveProfile('default')
    const normal = store.openTab('')
    store.reportUrl(normal, 'https://public.example')
    expect((await store.readHistory('default')).map((e) => e.url)).toEqual(['https://public.example'])
  })

  it('snapshot favorites/history mirror the active profile and refresh on switch', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    await store.loadConfig()
    await store.toggleFavorite('default', { url: 'https://d.example', title: 'D', ts: 1 })
    expect(store.getSnapshot().favorites.map((f) => f.url)).toEqual(['https://d.example'])

    const t = store.openTab('')
    store.reportUrl(t, 'https://timeline.example')
    expect(store.getSnapshot().history.map((h) => h.url)).toEqual(['https://timeline.example'])

    // Switching to Incognito swaps in its (empty) lists.
    store.setActiveProfile(INCOGNITO_PROFILE_ID)
    await tick()
    expect(store.getSnapshot().favorites).toEqual([])
    expect(store.getSnapshot().history).toEqual([])

    // Switching back restores the default profile's lists.
    store.setActiveProfile('default')
    await tick()
    expect(store.getSnapshot().favorites.map((f) => f.url)).toEqual(['https://d.example'])
    expect(store.getSnapshot().history.map((h) => h.url)).toEqual(['https://timeline.example'])
  })

  // Settings → Profiles counts every profile, not just the active one, so the
  // rows must read from the per-profile caches rather than the snapshot.
  it('profileStats counts a non-active profile once its lists are hydrated', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    await store.loadConfig()
    const fungi = store.addProfile('Fungi')
    const spores = store.addProfile('Spores')
    store.setActiveProfile(spores)

    await store.toggleFavorite(fungi, { url: 'https://a.example', title: 'A', ts: 1 })
    await store.addToReadingList(fungi, { url: 'https://b.example', title: 'B', ts: 2 })

    await store.ensureProfileLoaded(fungi)
    expect(store.getSnapshot().activeProfileId).not.toBe(fungi)
    expect(store.profileStats(fungi)).toEqual({ favorites: 1, reading: 1, history: 0 })
    expect(store.profileStats(INCOGNITO_PROFILE_ID)).toEqual({ favorites: 0, reading: 0, history: 0 })
  })
})

// Electron throws from every `webContents` reader between mounting a <webview>
// and its `dom-ready`. `Page.tsx` publishes its navigation controller from an
// effect that runs inside exactly that window on a freshly opened tab, so an
// unguarded `canGoBack` took the whole plugin view down with it.
describe('web store (guest not yet dom-ready)', () => {
  const notReady = (): never => {
    throw new Error('The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.')
  }

  it('answers the nav controller instead of throwing', () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    const id = store.openTab('https://example.com')
    const views = (store as unknown as { views: Map<string, unknown> }).views
    views.set(id, { canGoBack: notReady, canGoForward: notReady, goBack: notReady, goForward: notReady, reload: notReady })

    expect(store.canGoBack(id)).toBe(false)
    expect(store.canGoForward(id)).toBe(false)
    expect(() => store.goBack(id)).not.toThrow()
    expect(() => store.goForward(id)).not.toThrow()
    expect(() => store.reload(id)).not.toThrow()
  })
})

describe('web store (ad-block sync)', () => {
  const adblockCalls = (api: ReturnType<typeof createMockValleyApi>['api']): unknown[] => vi.mocked(api.backend.call).mock.calls.filter(([method]) => method === 'filter.configure').map(([, payload]) => payload)

  it('coalesces a burst of filter-list edits into one engine rebuild', async () => {
    vi.useFakeTimers()
    try {
      const { api, driverCalls } = createMockValleyApi()
      const store = createStore(api)
      await store.loadConfig()
      vi.mocked(api.backend.call).mockClear()
      driverCalls.length = 0

      store.setProfileAdblockSetting('default', 'adblockRules', 'https://one.example/list.txt')
      store.setProfileAdblockSetting('default', 'adblockRules', 'https://one.example/list.txt\nhttps://two.example/list.txt')
      store.setProfileAdblockSetting('default', 'adblockFrequency', 3)
      expect(adblockCalls(api)).toEqual([])

      await store.flushProfiles()
      vi.advanceTimersByTime(500)
      const pushed = adblockCalls(api)
      expect(pushed).toHaveLength(1)
      expect(pushed[0]).toMatchObject({ profiles: expect.arrayContaining([{
        partition: 'persist:web-default',
        enabled: true,
        rules: 'https://one.example/list.txt\nhttps://two.example/list.txt',
        frequencyDays: 3
      }]) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes a pending push when the plugin session is torn down', async () => {
    vi.useFakeTimers()
    try {
      const { api, driverCalls } = createMockValleyApi()
      const store = createStore(api)
      await store.loadConfig()
      vi.mocked(api.backend.call).mockClear()
      driverCalls.length = 0

      store.setProfileAdblockSetting('default', 'adblockEnabled', false)
      expect(adblockCalls(api)).toEqual([])

      await store.flushProfiles()
      await store.dispose()
      expect(adblockCalls(api)).toHaveLength(1)
      expect(adblockCalls(api)[0]).toMatchObject({ profiles: expect.arrayContaining([expect.objectContaining({
        partition: 'persist:web-default',
        enabled: false
      })]) })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('clipping document revisions', () => {
  const path = 'Clippings/Forest field notes.md'
  const prior = '---\ntitle: Preserved\n---\nUnsaved ä ö ü observation\n'
  const disposers: Array<() => Promise<void>> = []
  const fixture = (existing = true) => {
    const mock = createMockValleyApi({
      vault: { path: '/mock/forest', name: 'forest', displayName: 'forest' },
      files: existing ? { [path]: prior } : {}
    })
    initRuntime(mock.api)
    const store = createStore(mock.api)
    vi.spyOn(store, 'browserReadHtml').mockResolvedValue({ ok: true, data: {
      url: 'https://example.test/forest', title: 'Forest field notes',
      html: `<html><head><title>Forest field notes</title></head><body><article><h1>Forest field notes</h1><p>${'The forest study records moss, ferns and diverse woodland habitats. '.repeat(8)}</p></article></body></html>`
    } })
    const unregister = registerWebCommands(mock.api, store, createWebFetcher(mock.api, store))
    disposers.push(async () => { await unregister(); await disposeStore(mock.api, store) })
    const clip = (collision = 'overwrite') => mock.api.commands.execute('surfing:clip', { instanceId: 'source', collision })
    const runClip = () => { const command = mock.commands.find(entry => entry.id === 'clip' || entry.id.endsWith(':clip'))!; return command.run(command.input!.parse({ instanceId: 'source', collision: 'overwrite' }), { caller: 'agent' }) }
    return { ...mock, store, unregister, clip, runClip }
  }
  afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose() })

  it('refuses an unreadable source tab in its revision observation as not-applied', async () => {
    const mock = fixture()
    const command = mock.commands.find(entry => entry.id === 'clip' || entry.id.endsWith(':clip'))!
    const observe = () => (command.revision as (input: unknown) => Promise<unknown>)(command.input!.parse({ instanceId: 'source' }))
    vi.mocked(mock.store.browserReadHtml).mockResolvedValue({ ok: false, error: 'Tab closed', code: 'TARGET_NOT_FOUND', outcome: 'not-applied' } as never)
    await expect(observe()).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND', outcome: 'not-applied', retryable: false, message: 'Tab closed' })
    vi.mocked(mock.store.browserReadHtml).mockResolvedValue({ ok: false, error: 'Page unreadable' } as never)
    await expect(observe()).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE', outcome: 'not-applied', retryable: false })
    expect(mock.api.vault.writeTextDocumentGuarded).not.toHaveBeenCalled()
    expect(mock.api.vault.createTextDocumentGuarded).not.toHaveBeenCalled()
  })

  it('uses editor snapshots and alternates exact undo/redo receipts without disk-only reads', async () => {
    const mock = fixture()
    const disk = vi.spyOn(mock.api.vault, 'readFile').mockRejectedValue(new Error('Disk-only read'))
    const read = vi.spyOn(mock.api.vault, 'readTextDocument')
    expect(await mock.clip()).toMatchObject({ ok: true, value: { relPath: path } })
    const content = vi.mocked(mock.api.vault.writeTextDocumentGuarded).mock.calls[0][1]
    expect(content).toContain('woodland habitats')
    expect(disk).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledOnce()
    await mock.busUndo[0].undo()
    expect(vi.mocked(mock.api.vault.writeTextDocumentGuarded).mock.calls.at(-1)?.[1]).toBe(prior)
    await mock.busUndo[0].redo!()
    expect(vi.mocked(mock.api.vault.writeTextDocumentGuarded).mock.calls.at(-1)?.[1]).toBe(content)
    await mock.busUndo[0].undo()
    expect(read).toHaveBeenCalledOnce()
    expect(mock.api.vault.writeFile).not.toHaveBeenCalled()
  })

  it.each(['error', 'missing'] as const)('does not overwrite when the editor snapshot is %s', async outcome => {
    const mock = fixture()
    const read = vi.spyOn(mock.api.vault, 'readTextDocument')
    if (outcome === 'error') read.mockRejectedValue(new Error('Read failed'))
    else read.mockResolvedValue(null)
    expect((await mock.clip()).ok).toBe(false)
    expect(mock.api.vault.writeTextDocumentGuarded).not.toHaveBeenCalled()
    expect(mock.api.vault.writeFileGuarded).not.toHaveBeenCalled()
    expect(await mock.api.vault.readFile(path)).toBe(prior)
  })

  it('rejects a change after capture without overwriting it', async () => {
    const mock = fixture()
    const write = vi.mocked(mock.api.vault.writeTextDocumentGuarded).getMockImplementation()!
    vi.mocked(mock.api.vault.writeTextDocumentGuarded).mockImplementationOnce(async (...args) => {
      await mock.api.vault.writeFile(path, 'Newer editor draft')
      return write(...args)
    })
    await expect(mock.runClip()).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
    expect(await mock.api.vault.readFile(path)).toBe('Newer editor draft')
    expect(mock.busUndo).toHaveLength(0)
  })

  it('reports refusals before any write as not-applied and an unverified write as unknown', async () => {
    const mock = fixture()
    vi.mocked(mock.store.browserReadHtml).mockResolvedValueOnce({ ok: true, data: { url: 'https://example.test/empty', title: 'Empty', html: '<html><body></body></html>' } })
    await expect(mock.runClip()).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE', outcome: 'not-applied' })
    vi.mocked(mock.store.browserReadHtml).mockResolvedValueOnce({ ok: false, error: 'Page unavailable' })
    await expect(mock.runClip()).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE', outcome: 'not-applied' })
    expect(mock.api.vault.writeTextDocumentGuarded).not.toHaveBeenCalled()
    vi.mocked(mock.api.vault.writeTextDocumentGuarded).mockResolvedValueOnce({ ok: false, reason: 'stale' })
    await expect(mock.runClip()).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
    vi.mocked(mock.api.vault.writeTextDocumentGuarded).mockResolvedValueOnce({ ok: false, reason: 'error' })
    await expect(mock.runClip()).rejects.toMatchObject({ code: 'EFFECT_UNVERIFIED', outcome: 'unknown' })
    expect(await mock.api.vault.readFile(path)).toBe(prior)
    expect(mock.busUndo).toHaveLength(0)
  })

  it('reports clip undo/redo refusals before any vault effect as not-applied and unverified replays as unknown', async () => {
    const mock = fixture()
    await mock.clip()
    const write = vi.mocked(mock.api.vault.writeTextDocumentGuarded)
    write.mockResolvedValueOnce({ ok: false, reason: 'stale' })
    await expect(mock.busUndo[0].undo()).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied', retryable: false })
    await expect(mock.busUndo[0].undo()).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE', outcome: 'not-applied', retryable: false })
    await expect(mock.busUndo[0].redo!()).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE', outcome: 'not-applied', retryable: false })
    expect(write).toHaveBeenCalledTimes(2)

    const unverified = fixture()
    await unverified.clip()
    vi.mocked(unverified.api.vault.writeTextDocumentGuarded).mockResolvedValueOnce({ ok: false, reason: 'error' })
    await expect(unverified.busUndo[0].undo()).rejects.toMatchObject({ code: 'EFFECT_UNVERIFIED', outcome: 'unknown' })

    const created = fixture(false)
    await created.clip()
    vi.mocked(created.api.vault.trashTextDocumentGuarded).mockResolvedValueOnce({ ok: false, reason: 'conflict', current: null })
    await expect(created.busUndo[0].undo()).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
    const recreated = fixture(false)
    await recreated.clip()
    await recreated.busUndo[0].undo()
    vi.mocked(recreated.api.vault.createTextDocumentGuarded).mockResolvedValueOnce({ ok: false, reason: 'conflict' })
    await expect(recreated.busUndo[0].redo!()).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
    const lost = fixture(false)
    await lost.clip()
    vi.mocked(lost.api.vault.trashTextDocumentGuarded).mockResolvedValueOnce({ ok: false, reason: 'error' })
    await expect(lost.busUndo[0].undo()).rejects.toMatchObject({ code: 'EFFECT_UNVERIFIED', outcome: 'unknown' })
  })

  it.each(['undo', 'redo'] as const)('rejects %s after an edit/revert ABA without renewing authority', async direction => {
    const mock = fixture()
    await mock.clip()
    if (direction === 'redo') await mock.busUndo[0].undo()
    const content = await mock.api.vault.readFile(path)
    await mock.api.vault.writeFile(path, `${content}new`)
    await mock.api.vault.writeFile(path, content)
    const read = vi.spyOn(mock.api.vault, 'readTextDocument')
    await expect(mock.busUndo[0][direction]!()).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    expect(await mock.api.vault.readFile(path)).toBe(content)
  })

  it('preserves a committed write with newer typing and withholds undo authority', async () => {
    const mock = fixture()
    const write = vi.mocked(mock.api.vault.writeTextDocumentGuarded).getMockImplementation()!
    vi.mocked(mock.api.vault.writeTextDocumentGuarded).mockImplementationOnce(async (...args) => {
      const result = await write(...args)
      if (!result.ok) return result
      await mock.api.vault.writeFile(path, `${args[1]}Newer typing`)
      return { ok: true, revisionToken: null, editorConflict: true }
    })
    expect((await mock.clip()).ok).toBe(true)
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    expect(await mock.api.vault.readFile(path)).toContain('Newer typing')
  })

  it('creates only into an absent path and never overwrites an occupied redo target', async () => {
    const mock = fixture(false)
    expect((await mock.clip()).ok).toBe(true)
    expect(mock.api.vault.createTextDocumentGuarded).toHaveBeenCalledWith(path, expect.any(String))
    await mock.busUndo[0].undo()
    await mock.api.vault.writeFile(path, 'Replacement')
    await expect(mock.busUndo[0].redo!()).rejects.toThrow()
    expect(await mock.api.vault.readFile(path)).toBe('Replacement')
  })

  it('alternates creation and guarded trash using returned receipts without rereading', async () => {
    const mock = fixture(false)
    const read = vi.spyOn(mock.api.vault, 'readTextDocument')
    expect((await mock.clip()).ok).toBe(true)
    const content = await mock.api.vault.readFile(path)
    await mock.busUndo[0].undo()
    await mock.busUndo[0].redo!()
    expect(await mock.api.vault.readFile(path)).toBe(content)
    await mock.busUndo[0].undo()
    expect(mock.api.vault.createTextDocumentGuarded).toHaveBeenCalledTimes(2)
    expect(mock.api.vault.trashTextDocumentGuarded).toHaveBeenCalledTimes(2)
    expect(read).not.toHaveBeenCalled()
    expect(mock.driverCalls.some(call => call.method === 'deleteMarkdown')).toBe(false)
  })

  it('preserves edits made before a create acknowledgement without renewing undo authority', async () => {
    const mock = fixture(false)
    const create = vi.mocked(mock.api.vault.createTextDocumentGuarded).getMockImplementation()!
    vi.mocked(mock.api.vault.createTextDocumentGuarded).mockImplementationOnce(async (...args) => {
      const result = await create(...args)
      await mock.api.vault.writeFile(path, `${args[1]}Newer typing`)
      return result
    })
    expect((await mock.clip()).ok).toBe(true)
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    expect(await mock.api.vault.readFile(path)).toContain('Newer typing')
  })

  it('does not fall back to deletion or retry when the host rejects a dirty editor', async () => {
    const mock = fixture(false)
    await mock.clip()
    const content = await mock.api.vault.readFile(path)
    vi.mocked(mock.api.vault.trashTextDocumentGuarded).mockResolvedValueOnce({ ok: false, reason: 'stale' })
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    expect(mock.api.vault.trashTextDocumentGuarded).toHaveBeenCalledOnce()
    expect(await mock.api.vault.readFile(path)).toBe(content)
    expect(mock.driverCalls.some(call => call.method === 'deleteMarkdown')).toBe(false)
  })

  it.each([true, false])('does not replay committed trash with recoverySaved=%s', async recoverySaved => {
    const mock = fixture(false)
    await mock.clip()
    const trash = vi.mocked(mock.api.vault.trashTextDocumentGuarded).getMockImplementation()!
    vi.mocked(mock.api.vault.trashTextDocumentGuarded).mockImplementationOnce(async (...args) => {
      const result = await trash(...args)
      return result.ok ? { ...result, editorConflict: true, recoverySaved } : result
    })
    await expect(mock.busUndo[0].undo()).rejects.toThrow('file was deleted')
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    await expect(mock.busUndo[0].redo!()).rejects.toThrow()
    expect(mock.api.vault.trashTextDocumentGuarded).toHaveBeenCalledOnce()
    expect(mock.api.vault.createTextDocumentGuarded).toHaveBeenCalledOnce()
  })

  it('does not retry an uncertain physical trash result', async () => {
    const mock = fixture(false)
    await mock.clip()
    const trash = vi.mocked(mock.api.vault.trashTextDocumentGuarded).getMockImplementation()!
    vi.mocked(mock.api.vault.trashTextDocumentGuarded).mockImplementationOnce(async (...args) => { await trash(...args); throw new Error('Acknowledgement lost') })
    await expect(mock.busUndo[0].undo()).rejects.toThrow('Acknowledgement lost')
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    expect(mock.api.vault.trashTextDocumentGuarded).toHaveBeenCalledOnce()
  })

  it('joins a held document read on disposal and stops its subsequent write', async () => {
    const mock = fixture()
    const read = mock.api.vault.readTextDocument
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(mock.api.vault, 'readTextDocument').mockImplementationOnce(async target => { const value = await read(target); await held; return value })
    const clipping = mock.clip()
    await vi.waitFor(() => expect(mock.api.vault.readTextDocument).toHaveBeenCalled())
    const ended = vi.fn()
    const closing = mock.unregister().then(ended)
    try {
      await Promise.resolve()
      expect(ended).not.toHaveBeenCalled()
      release()
      await expect(clipping).resolves.toMatchObject({ ok: false })
      await closing
      expect(mock.api.vault.writeTextDocumentGuarded).not.toHaveBeenCalled()
    } finally { release() }
  })

  it('revokes held work after the vault returns A to B to A', async () => {
    const mock = fixture()
    const read = mock.api.vault.readTextDocument
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(mock.api.vault, 'readTextDocument').mockImplementationOnce(async target => { const value = await read(target); await held; return value })
    const clipping = mock.clip()
    await vi.waitFor(() => expect(mock.api.vault.readTextDocument).toHaveBeenCalled())
    const origin = mock.api.getState().vault
    mock.emitState({ vault: { path: '/mock/other', name: 'other', displayName: 'other' } })
    mock.emitState({ vault: origin })
    release()
    await expect(clipping).resolves.toMatchObject({ ok: false })
    expect(mock.api.vault.writeTextDocumentGuarded).not.toHaveBeenCalled()
  })

  it('does not dispatch the same undo twice while its write is pending', async () => {
    const mock = fixture()
    await mock.clip()
    const write = vi.mocked(mock.api.vault.writeTextDocumentGuarded).getMockImplementation()!
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    vi.mocked(mock.api.vault.writeTextDocumentGuarded).mockImplementationOnce(async (...args) => { await held; return write(...args) })
    const undoing = mock.busUndo[0].undo()
    await vi.waitFor(() => expect(mock.api.vault.writeTextDocumentGuarded).toHaveBeenCalledTimes(2))
    try {
      await expect(mock.busUndo[0].undo()).rejects.toThrow()
      release()
      await undoing
      expect(mock.api.vault.writeTextDocumentGuarded).toHaveBeenCalledTimes(2)
    } finally { release() }
  })

  it('joins an accepted write through its known result after disposal begins', async () => {
    const mock = fixture()
    const write = vi.mocked(mock.api.vault.writeTextDocumentGuarded).getMockImplementation()!
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    vi.mocked(mock.api.vault.writeTextDocumentGuarded).mockImplementationOnce(async (...args) => { await held; return write(...args) })
    const clipping = mock.clip()
    await vi.waitFor(() => expect(mock.api.vault.writeTextDocumentGuarded).toHaveBeenCalled())
    const ended = vi.fn()
    const closing = mock.unregister().then(ended)
    try {
      await Promise.resolve()
      expect(ended).not.toHaveBeenCalled()
      release()
      await expect(clipping).resolves.toMatchObject({ ok: true })
      await closing
      await expect(mock.busUndo[0].undo()).rejects.toThrow()
      expect(mock.api.vault.writeTextDocumentGuarded).toHaveBeenCalledOnce()
    } finally { release() }
  })
})

describe('plain click opens in the same tab, Mod or middle click in a new tab', () => {
  const auxClick = (element: Element) => fireEvent(element, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
  const panel = (api: ReturnType<typeof createMockValleyApi>['api']) => (api.registerView as unknown as { mock: { calls: [string, React.ComponentType][] } }).mock.calls
    .find(([id]) => id === 'surfing.panel')![1]

  it('opens a website link in place and in a new tab when the link broker asks for one', async () => {
    const { api } = createMockValleyApi()
    const dispose = register(api)
    const handler = vi.mocked(api.links.register).mock.calls.find(([entry]) => entry.id === 'browse')![0]
    const target = { category: 'website' as const, value: 'https://example.com/survey' }
    expect(await handler.open(target)).toEqual({ status: 'opened' })
    expect(await handler.open(target, { newTab: false })).toEqual({ status: 'opened' })
    expect(await handler.open(target, { newTab: true })).toEqual({ status: 'opened' })
    expect(vi.mocked(api.workspace.openMainTab).mock.calls.map(([options]) => options)).toEqual([
      { instanceId: expect.any(String), title: 'https://example.com/survey' },
      { instanceId: expect.any(String), title: 'https://example.com/survey' },
      { instanceId: expect.any(String), title: 'https://example.com/survey', newTab: true }
    ])
    dispose()
  })

  it('opens a Timeline entry in the focused web tab, and in a new tab on Mod or middle click as the platform defines Mod', async () => {
    const { api } = createMockValleyApi()
    const dispose = register(api)
    await tick()
    const store = getStore()!
    const tab = store.openTab('')
    store.reportUrl(tab, 'https://history.example/')
    await waitFor(() => expect(store.getSnapshot().history).toHaveLength(1))
    const focused = store.openTab('https://canopy.example/')
    publishWebContext({ instanceId: focused, url: 'https://canopy.example/', title: 'Canopy' })
    render(React.createElement(panel(api)))
    fireEvent.click(screen.getByTitle('Timeline'))
    const row = (await screen.findAllByRole('button')).find((button) => button.classList.contains('web-list-open'))!
    const openMainTab = vi.mocked(api.workspace.openMainTab)
    openMainTab.mockClear()
    const navigate = vi.spyOn(store, 'navigate')
    fireEvent.click(row)
    expect(navigate).toHaveBeenLastCalledWith(focused, 'https://history.example/')
    expect(openMainTab).not.toHaveBeenCalled()
    fireEvent.click(row, { ctrlKey: true })
    auxClick(row)
    expect(openMainTab.mock.calls.map(([options]) => options?.newTab)).toEqual([true, true])
    openMainTab.mockClear()
    api.ui.hasModKey = vi.fn(() => false)
    fireEvent.click(row, { metaKey: true })
    expect(navigate).toHaveBeenCalledTimes(2)
    expect(openMainTab).not.toHaveBeenCalled()
    act(() => clearWebContext(focused))
    fireEvent.click(row)
    expect(openMainTab).toHaveBeenCalledTimes(1)
    expect(openMainTab.mock.calls[0][0]).toEqual({ instanceId: expect.any(String), title: 'https://history.example/' })
    cleanup()
    dispose()
  })

  it('opens an embedded page in place and in a new tab on Mod or middle click', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): IntersectionObserverEntry[] { return [] } })
    const mock = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(mock.api)
    await waitFor(() => expect(mock.codeBlockRenderers.get('surfing')).toBeDefined())
    const el = document.createElement('div')
    document.body.appendChild(el)
    const offEmbed = mock.codeBlockRenderers.get('surfing')!('https://example.com/survey', el, { path: 'Research/Embed Demo.md', meta: null })
    const open = el.querySelector('.web-fence-bar button')!
    const openMainTab = vi.mocked(mock.api.workspace.openMainTab)
    openMainTab.mockClear()
    fireEvent.click(open)
    fireEvent.click(open, { metaKey: true })
    auxClick(open)
    expect(openMainTab.mock.calls.map(([options]) => options?.newTab)).toEqual([undefined, true, true])
    if (typeof offEmbed === 'function') offEmbed()
    el.remove()
    await dispose()
    vi.unstubAllGlobals()
  })
})
