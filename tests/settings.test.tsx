import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { createMockValleyApi } from './mock'
import { register } from '../src/index'
import { getStore } from '../src/store'
import { DEFAULT_ADBLOCK_RULES, DEFAULT_PROFILE_ID } from '../src/profiles'
import { METADATA_PANEL_SEGMENT_V1 } from '@valley/plugin-sdk'

afterEach(cleanup)

/**
 * Mount `surfing.settings` for one manifest section id, with `register`'s own
 * `loadConfig` settled first — it lands asynchronously and would otherwise
 * overwrite whatever the test set up before its first assertion.
 */
async function renderSection(section: string): Promise<() => void> {
  const mock = createMockValleyApi({ manifest: { id: 'surfing', drivers: ['browser', 'notes'] } })
  const dispose = register(mock.api)
  const call = (mock.api.registerView as unknown as {
    mock: { calls: [string, ComponentType<{ section?: string }>][] }
  }).mock.calls.find(([id]) => id === 'surfing.settings')
  expect(call).toBeDefined()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  render(React.createElement(call![1], { section }))
  return dispose
}

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.settings-list-row')]

describe('Surfing Settings → Profiles', () => {
  it('keeps Profile Properties read-only and limited to Profile, Private, and Hidden', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'surfing', drivers: ['browser', 'notes'] } })
    const dispose = register(mock.api)
    try {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      const store = getStore()!
      const profileId = store.addProfile('Forest')
      await store.flushProfiles()
      const subject = { pluginId: 'surfing', surface: 'main_workspace' as const, view: { profileId } }
      const properties = mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)
        .find((provider) => provider.extension.id === 'surfing.profileProperties')!.extension
      expect((await properties.inspect!({ relPath: '', kind: 'unsupported', subject })).map((field) => field.id)).toEqual(['profileId', 'private', 'hidden'])
      render(<>{properties.render({ relPath: '', kind: 'unsupported', subject })}</>)
      await screen.findByText(profileId, { selector: 'dd' })
      expect(document.querySelectorAll('.props-info-row')).toHaveLength(3)
      expect(document.querySelector('input, button, select')).toBeNull()
    } finally { dispose() }
  })

  it('lists every profile as a list-page row, with Incognito pinned last', async () => {
    const dispose = await renderSection('profiles')
    await waitFor(() => expect(rows()).toHaveLength(getStore()!.getSnapshot().profiles.length))

    expect(rows().map((row) => row.querySelector('.settings-list-name')?.textContent)).toEqual([
      'Default',
      'Incognito'
    ])
    const incognito = rows()[1]
    expect(incognito.textContent).toContain('private')
    expect(within(incognito).getByText(/doesn’t keep history/)).toBeTruthy()
    dispose()
  })

  it('opens a profile’s own page behind the chevron; Incognito is read-only there', async () => {
    const dispose = await renderSection('profiles')
    await waitFor(() => expect(rows()).toHaveLength(2))

    fireEvent.click(rows()[1])

    // The crumb band replaced the list, and the page is Incognito's.
    await waitFor(() => expect(rows()).toHaveLength(0))
    expect(screen.getByRole('button', { name: 'Back to Profiles' })).toBeTruthy()
    expect(document.querySelector('.settings-listpage-crumbs')?.textContent).toBe('Incognito')
    // Its fixed identity header is enough; there is no redundant profile-name row.
    expect(screen.queryByRole('textbox', { name: 'Profile name' })).toBeNull()
    expect(screen.queryByLabelText('Profile name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Clear web viewer data/ })).toBeNull()
    expect(document.body.textContent).not.toContain('web-incognito')
    dispose()
  })

  it('lets Default change its name and icon while protecting the last normal profile', async () => {
    const dispose = await renderSection('profiles')
    await waitFor(() => expect(rows()).toHaveLength(2))
    fireEvent.click(rows()[0])
    expect(screen.getByRole('textbox', { name: 'Profile name' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose an icon' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
    expect(screen.getByText(/Create another profile before deleting this one/)).toBeTruthy()
    const field = screen.getByRole('textbox', { name: 'Profile name' })
    fireEvent.change(field, { target: { value: 'Personal' } })
    fireEvent.blur(field)
    expect(getStore()!.getSnapshot().profiles[0].name).toBe('Personal')
    dispose()
  })

  it('adds a profile through + and lands on its detail page', async () => {
    const dispose = await renderSection('profiles')
    await waitFor(() => expect(rows()).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Profile name' }), { target: { value: 'Fungi' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add profile$/ }))

    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: 'Profile name' }) as HTMLInputElement).value).toBe('Fungi')
    )
    expect(getStore()!.getSnapshot().profiles.map((p) => p.name)).toEqual(['Default', 'Fungi', 'Incognito'])
    expect(document.querySelector('.settings-listpage-crumbs')?.textContent).toBe('Fungi')
    dispose()
  })

  it('counts a profile’s saved pages on its row and renames it from its page', async () => {
    const dispose = await renderSection('profiles')
    const store = getStore()!
    const fungi = await act(async () => {
      const id = store.addProfile('Fungi')
      await store.toggleFavorite(id, { url: 'https://a.example', title: 'A', ts: 1 })
      return id
    })

    const fungiRow = (): HTMLElement => rows().find((row) => row.querySelector('.settings-list-name')?.textContent === 'Fungi')!
    await waitFor(() => expect(within(fungiRow()).getByText(/1 favorites/)).toBeTruthy())
    expect(fungiRow().textContent).toContain('0 to read')

    fireEvent.click(fungiRow())
    const stats = screen.getByLabelText('Saved pages')
    expect(within(stats).getByText('Favorites').previousElementSibling).toHaveTextContent('1')
    expect(within(stats).getByText('Reading list').previousElementSibling).toHaveTextContent('0')
    expect(within(stats).getByText('Timeline').previousElementSibling).toHaveTextContent('0')
    const field = screen.getByRole('textbox', { name: 'Profile name' })
    fireEvent.change(field, { target: { value: 'Spores' } })
    fireEvent.blur(field)
    expect(store.getSnapshot().profiles.find((p) => p.id === fungi)?.name).toBe('Spores')
    dispose()
  })
})

describe('Surfing Settings → Profiles → Ad-block', () => {
  const openDefault = async (): Promise<() => void> => {
    const dispose = await renderSection('profiles')
    await waitFor(() => expect(rows()).toHaveLength(2))
    fireEvent.click(rows()[0])
    return dispose
  }

  it('starts each profile with two filter rows and serializes added and removed rows', async () => {
    const dispose = await openDefault()
    const store = getStore()!
    expect((screen.getByLabelText('Filter list 1') as HTMLInputElement).value).toBe('https://easylist.to/easylist/easylist.txt')
    expect((screen.getByLabelText('Filter list 2') as HTMLInputElement).value).toBe('https://easylist.to/easylist/easyprivacy.txt')

    fireEvent.click(screen.getByRole('button', { name: 'Add filter list' }))
    const third = screen.getByLabelText('Filter list 3')
    expect(screen.getByRole('button', { name: 'Add filter list' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Add filter list' }))
    expect(screen.queryByLabelText('Filter list 4')).toBeNull()
    fireEvent.change(third, { target: { value: ' https://example.invalid/mine.txt ' } })
    fireEvent.blur(third)
    expect(store.getSnapshot().profiles.find((profile) => profile.id === DEFAULT_PROFILE_ID)?.adblockRules)
      .toBe(`${DEFAULT_ADBLOCK_RULES}\nhttps://example.invalid/mine.txt`)

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove filter list' })[1])
    expect(store.getSnapshot().profiles.find((profile) => profile.id === DEFAULT_PROFILE_ID)?.adblockRules)
      .toBe('https://easylist.to/easylist/easylist.txt\nhttps://example.invalid/mine.txt')
    dispose()
  })

  it('offers the update frequency as a slider and greys the rows out with the blocker', async () => {
    const dispose = await openDefault()
    expect((screen.getByRole('slider', { name: 'Ad block update frequency' }) as HTMLInputElement).value).toBe('7')

    fireEvent.click(screen.getByRole('switch', { name: 'Enable ad blocker' }))
    await waitFor(() => expect(screen.getByLabelText('Filter list 1')).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Add filter list' })).toBeDisabled()
    expect(screen.getByRole('slider', { name: 'Ad block update frequency' })).toBeDisabled()
    dispose()
  })
})

describe('Surfing Settings → Embeds', () => {
  it('shows provider names and reveals their files without a demo-note action', async () => {
    const mock = createMockValleyApi({
      manifest: { id: 'surfing', drivers: ['browser', 'notes'] },
      files: {
        'Research/Embed Demo.md': '```surfing youtube\nhttps://www.youtube.com/watch?v=UF8uR6Z6KLc\n```\n\n```surfing X\nhttps://x.com/jack/status/20\n```',
        '.valley/plugins/data/surfing/embeds/youtube/provider.json': JSON.stringify({ schemaVersion: 1, id: 'youtube', displayName: 'YouTube', language: 'youtube', template: 'https://www.youtube.com/embed/{value}', kind: 'youtube', valueParser: 'youtube-video-id', presentation: { initialHeight: 360, autoSize: false, fullWidth: true, aspectRatio: '16 / 9', httpReferrer: 'https://localhost/' }, order: 10 }),
        '.valley/plugins/data/surfing/embeds/x/provider.json': JSON.stringify({ schemaVersion: 1, id: 'x', displayName: 'X', language: 'X', template: 'https://platform.twitter.com/embed/Tweet.html?id={value}', kind: 'x', valueParser: 'x-post-id', presentation: { initialHeight: 180, autoSize: true, fullWidth: true, minHeight: 180, maxHeight: 1200, fitWidth: { naturalWidth: 515, maxScale: 1.3 } }, theme: { queryParameter: 'theme', values: { light: 'light', dark: 'dark' } }, order: 20 })
      }
    })
    const dispose = register(mock.api)
    const call = (mock.api.registerView as unknown as {
      mock: { calls: [string, ComponentType<{ section?: string }>][] }
    }).mock.calls.find(([id]) => id === 'surfing.settings')!
    render(React.createElement(call[1], { section: 'embeds' }))

    expect(await screen.findByText('YouTube')).toBeTruthy()
    expect(screen.getByText('X')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'URL template' })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Reveal in Finder' })[0])
    expect(mock.osFileActions).toContainEqual({ action: 'reveal', relPath: '.valley/plugins/data/surfing/embeds/youtube' })
    expect(screen.queryByRole('button', { name: 'Open embed demo' })).toBeNull()

    dispose()
  })
})

describe('Surfing Settings → General', () => {
  it('no longer offers a saved-page folder', async () => {
    const dispose = await renderSection('general')
    expect(screen.queryByText('Saved page folder')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Homepage' })).toBeTruthy()
    dispose()
  })

  it('defaults website new tabs on and offers Baidu and Yahoo', async () => {
    const dispose = await renderSection('general')
    const toggle = screen.getByRole('switch', { name: 'Open website tabs for new tabs' })
    expect(toggle).toBeChecked()
    const search = screen.getByRole('combobox', { name: 'Search engine' })
    expect(within(search).getByRole('option', { name: 'Baidu' })).toBeTruthy()
    expect(within(search).getByRole('option', { name: 'Yahoo' })).toBeTruthy()
    fireEvent.click(toggle)
    expect(getStore()!.getSnapshot().settings.openWebsiteOnNewTab).toBe(false)
    dispose()
  })
})
