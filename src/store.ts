import type { ProfilesSnapshot, PagesSnapshot } from './backend/data'
import { uiText } from './localization'
import { watchBrowserCosmetics } from './browserCosmetics'
import { browserAutomation } from './browserAutomation'
import { createGuestLifetime, type GuestLifetime } from './guestLifetime'
import type { PluginBrowserConnection, PluginBrowserGuestEvent } from '@valley/plugin-sdk'
import type {
  BrowserActionResult,
  BrowserCaptureResult,
  BrowserHtmlResult,
  BrowserSnapshotResult,
  BrowserTabsResult,
  BrowserTextResult,
  ValleyPluginApi
} from '@valley/plugin-sdk'
import type { DriverResult } from '@valley/plugin-sdk/types'
import type { DatasetKey, DatasetRecord, DatasetWhere } from '@valley/plugin-sdk'
import {
  canDeleteProfile,
  canHideProfile,
  DEFAULT_PROFILE_ID,
  DEFAULT_SETTINGS,
  INCOGNITO_PROFILE_ID,
  newProfileId,
  normalizeProfileAdblock,
  normalizeSettings,
  partitionFor,
  profileSettingsPatchSchema,
  reconcileProfiles,
  searchUrl,
  switcherProfiles,
  type HistoryEntry,
  type SavedPage,
  type SearchEngineId,
  type WebProfile,
  type WebSettings
} from './profiles'
import { api as runtimeApi } from './runtime'

const profileRefusal = (code: string, message: string): Error => Object.assign(new Error(message), { code, outcome: 'not-applied', retryable: false })
// A failure while observing state ahead of a saved-page or history write changed nothing.
const beforeEffect = <T>(work: Promise<T>): Promise<T> => work.catch((cause: unknown) => {
  if ((cause as { outcome?: unknown } | null)?.outcome === 'not-applied') throw cause
  const code = (cause as { code?: unknown } | null)?.code
  throw Object.assign(new Error(cause instanceof Error ? cause.message : String(cause), { cause }), { code: typeof code === 'string' && code ? code : 'ACTION_UNAVAILABLE', outcome: 'not-applied', retryable: false })
})
import type { WebFetchErrorCode, WebFetchMode, WebFetchPage } from './webFetch'

export interface WebTabState {
  url: string
  title: string
  profileId: string
  metadata?: WebPageMetadata
  connection?: PluginBrowserConnection
}

export interface GuestTarget { readonly instanceId: string; readonly profileId: string }

export interface WebPageMetadata {
  description?: string
  image?: string
  siteName?: string
  type?: string
  author?: string
  icon?: string
  canonical?: string
  language?: string
}

/** One assistant URL fetch shown live in the sidebar; kept in memory for the session only. */
export interface WebAgentActivity {
  id: string
  url: string
  title: string
  mode: WebFetchMode
  state: 'running' | 'done' | 'error'
  ts: number
  status?: number | null
  contentType?: string
  bytes?: number
  durationMs?: number
  cached?: boolean
  error?: WebFetchErrorCode | null
  instanceId?: string
}

export interface WebSnapshot {
  tabs: Record<string, WebTabState>
  profiles: WebProfile[]
  activeProfileId: string
  settings: WebSettings
  // The active profile's saved-page lists (newest-first), surfaced for the
  // sidebar Panel. Favorites + reading list are user-curated; `history` is the
  // browsing timeline (empty for a private profile). Kept per-profile on disk;
  // the snapshot mirrors only the active profile and refreshes on switch.
  favorites: SavedPage[]
  readingList: SavedPage[]
  history: SavedPage[]
  agentActivity: WebAgentActivity[]
  profileError?: string
}

interface WebviewEl {
  revision?: number
  guestId: string
  url: string
  back: boolean
  forward: boolean
  audible: boolean
  loadURL(url: string): Promise<void>
  getURL(): string
  reload(): void
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  isCurrentlyAudible(): boolean
}

const STORE_KEY = 'surfing.store'
const PROFILES_DATASET = 'profiles'
const PROFILE_ADBLOCK_DATASET = 'profile_adblock'
const TABS_DATASET = 'tabs'
/** Coalescing window for `setAdblock` pushes (ms) — see {@link WebStore.syncAdblock}. */
const ADBLOCK_SYNC_DELAY = 250
const AGENT_ACTIVITY_LIMIT = 50
const PAGE_METADATA_SCRIPT = `(() => {
  const content = (...selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector)
      const value = element?.getAttribute('content')?.trim()
      if (value) return value
    }
    return ''
  }
  const absolute = (value) => {
    if (!value) return ''
    try { return new URL(value, document.baseURI).href } catch { return '' }
  }
  return {
    description: content('meta[property="og:description"]', 'meta[name="twitter:description"]', 'meta[name="description"]'),
    image: absolute(content('meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]')),
    siteName: content('meta[property="og:site_name"]', 'meta[name="application-name"]'),
    type: content('meta[property="og:type"]'),
    author: content('meta[name="author"]', 'meta[property="article:author"]'),
    icon: absolute(document.querySelector('link[rel~="icon"]')?.getAttribute('href') || ''),
    canonical: absolute(document.querySelector('link[rel="canonical"]')?.getAttribute('href') || ''),
    language: document.documentElement.lang || ''
  }
})()`

function normalizePageMetadata(raw: unknown): WebPageMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const value = raw as Record<string, unknown>
  return Object.fromEntries(
    ['description', 'image', 'siteName', 'type', 'author', 'icon', 'canonical', 'language']
      .map((key) => [key, typeof value[key] === 'string' ? value[key].trim() : ''])
      .filter((entry) => entry[1])
  ) as WebPageMetadata
}

let counter = 0
function genId(): string {
  return `web-${Date.now().toString(36)}-${(counter++).toString(36)}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/** Normalize address-bar input: keep explicit schemes, https-prefix a bare
 *  domain, otherwise treat it as a search on the chosen engine. */
export function toUrl(input: string, engine: SearchEngineId = 'google'): string {
  const s = input.trim()
  if (!s) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s
  if (!/\s/.test(s) && /\.[a-z]{2,}/i.test(s)) return `https://${s}`
  return searchUrl(engine, s)
}

export class WebStore {
  readonly api: ValleyPluginApi
  private listeners = new Set<() => void>()
  private snap: WebSnapshot = {
    tabs: {},
    profiles: reconcileProfiles([]),
    activeProfileId: DEFAULT_PROFILE_ID,
    settings: DEFAULT_SETTINGS,
    favorites: [],
    readingList: [],
    history: [],
    agentActivity: []
  }
  private lastHistoryUrl = new Map<string, string>()
  private profileWrites: Promise<void> = Promise.resolve()
  private profileEpoch = 0
  private profileLoad: Promise<void> | undefined
  private profileRevisions = new Map<string, number>()
  private committedProfiles: WebProfile[] = reconcileProfiles([])

  // ── Per-profile saved-page lists (favorites / reading list / timeline) ──────
  // Caches keyed by profileId, hydrated lazily from datasets via loadProfileLists.
  // Each holds the list newest-first; history is mirrored here for the panel.
  private favCache = new Map<string, SavedPage[]>()
  private readingCache = new Map<string, SavedPage[]>()
  private histCache = new Map<string, SavedPage[]>()
  private listLoads = new Map<string, Promise<void>>()
  private historyWriteQueue: Promise<void> = Promise.resolve()
  private lastHistoryTs = new Map<string, number>()
  private adblockTimer: number | null = null

  // ── Open-tab persistence ──────────────────────────────────────────────────
  // The workspace persists each browser tab's `instanceId`, but the per-tab
  // url/title/profile live only in this session store and are wiped on a
  // full app reload (Cmd+R) — a reloaded tab would otherwise reopen the homepage.
  // We mirror `tabs` to the plugin cache dataset so a reload reopens the exact
  // page that was showing. `tabsLoaded` gates persistence so an early
  // mount can't overwrite the saved set before {@link loadConfig} restores it.
  private tabsLoaded = false
  private persistTimer: number | null = null
  // What this window last wrote per tab id, so a write sends only its changes.
  private persistedTabs: Map<string, string> | null = null
  private tabWrites: Promise<void> = Promise.resolve()
  private tabRevisions = new Set<number>()

  // ── Media / footer playback ───────────────────────────────────────────────
  // A guest playing audible media registers a PlaybackSource so the shared
  // footer bar (play/pause + volume) can drive it. Volume is kept per tab so it
  // survives navigation; `active` tracks which guests currently have media.
  private guestLifetimes = new Map<string, GuestLifetime>()
  private guestTargets = new Map<string, GuestTarget>()
  private guestWork = new Set<Promise<unknown>>()
  private guestFailure: unknown
  private disposed = false
  private disposal: Promise<void> | undefined

  private views = new Map<string, WebviewEl>()
  private cosmetics = new Map<string, () => Promise<void>>()
  private browserGuests = new Map<string, string>()
  private hosts = new Set<string>()
  private reconcileTimer: number | null = null
  private listRevisions = new Map<string, number>()
  private offData: () => void
  private offBrowser: () => void
  private offState: () => void
  private offTabs: () => void
  private agentTabId: string | null = null
  private loadWaiters = new Map<string, Set<(result: 'load' | 'timeout') => void>>()

  constructor(api: ValleyPluginApi) {
    this.api = api
    this.offBrowser = api.drivers.browser.onEvent((event) => {
      const id = [...this.browserGuests].find(([, guestId]) => guestId === event.guestId)?.[0]
      if (id) this.guestEvent(id, event)
    })
    this.offData = api.backend.on('data.changed', () => {
      if (this.disposed) return
      this.listLoads.clear()
      void this.loadConfig().catch(error => this.setSnap({ profileError: error instanceof Error ? error.message : String(error) }))
    })
    // Another window may drop this window's records while reconciling its own; write them back.
    this.offTabs = api.data.dataset(TABS_DATASET).subscribe((event) => {
      void this.tabWrites.then(() => this.tabRevisions.delete(event.revision) ? undefined : this.claimTabs()).catch(() => {})
    })
    const root = api.getState().realm?.path ?? null
    this.offState = api.subscribe(() => {
      if ((api.getState().realm?.path ?? null) !== root) void this.dispose().catch(error => console.error(error))
    })
  }

  private trackGuestWork<T>(operation: Promise<T>): Promise<T> {
    this.guestWork.add(operation)
    void operation.then(() => this.guestWork.delete(operation), () => this.guestWork.delete(operation))
    return operation
  }

  private async rows(datasetId: string, where?: DatasetWhere, orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>): Promise<DatasetRecord[]> {
    const dataset = this.api.data.dataset(datasetId)
    const rows: DatasetRecord[] = []
    let cursor: string | undefined
    do {
      const page = await dataset.query({ where, orderBy, limit: 1000, cursor })
      rows.push(...page.rows)
      cursor = page.cursor
    } while (cursor)
    return rows
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  // Referentially stable between mutations — required by useSyncExternalStore.
  getSnapshot = (): WebSnapshot => this.snap

  private setSnap(next: Partial<WebSnapshot>): void {
    if (this.disposed) return
    this.snap = { ...this.snap, ...next }
    for (const l of this.listeners) l()
  }

  private patch(id: string, p: Partial<WebTabState>): boolean {
    if (this.disposed) return false
    const cur = this.snap.tabs[id]
    if (!cur) return false
    const next = { ...cur, ...p }
    if (next.url === cur.url && next.title === cur.title && next.profileId === cur.profileId && JSON.stringify(next.metadata) === JSON.stringify(cur.metadata) && JSON.stringify(next.connection) === JSON.stringify(cur.connection)) return false
    this.setSnap({ tabs: { ...this.snap.tabs, [id]: next } })
    this.persistTabs()
    return true
  }

  /** Mirror the open tabs (url/title/profile per `instanceId`) to disk so a full
   *  app reload reopens the page each tab was showing. Debounced + gated on
   *  {@link tabsLoaded} (never persist before the saved set is restored). */
  private persistTabs(): void {
    if (this.disposed || !this.tabsLoaded) return
    if (this.persistTimer != null) clearTimeout(this.persistTimer)
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null
      this.tabWrites = this.tabWrites.then(() => this.writeTabs()).catch(() => { this.persistedTabs = null })
    }, 400)
  }

  private async writeTabs(): Promise<void> {
    if (this.disposed) return
    const recs = Object.entries(this.snap.tabs)
      .filter(([, tab]) => !this.isPrivate(tab.profileId))
      .map(([id, t]) => ({ id, url: t.url, title: t.title, profileId: t.profileId }))
    const next = new Map(recs.map((record) => [record.id, JSON.stringify([record.id, record.url, record.title, record.profileId])]))
    const previous = this.persistedTabs
    this.persistedTabs = null
    const operations = previous ? [
      ...[...previous.keys()].filter((id) => !next.has(id)).map((id) => ({ operation: 'delete' as const, key: { id } })),
      ...recs.filter((record) => previous.get(record.id) !== next.get(record.id)).map((values) => ({ operation: 'upsert' as const, values }))
    ] : [
      ...(await this.rows(TABS_DATASET)).map((record) => ({ operation: 'delete' as const, key: { id: record.id ?? null } as DatasetKey })),
      ...recs.map((values) => ({ operation: 'upsert' as const, values }))
    ]
    const dataset = this.api.data.dataset(TABS_DATASET)
    for (let index = 0; index < operations.length; index += 500) {
      this.tabRevisions.add((await dataset.batch(operations.slice(index, index + 500))).revision)
      if (this.tabRevisions.size > 64) this.tabRevisions.delete(this.tabRevisions.values().next().value!)
    }
    this.persistedTabs = next
  }

  private async claimTabs(): Promise<void> {
    if (this.disposed || !this.tabsLoaded || !this.persistedTabs) return
    const stored = new Set((await this.rows(TABS_DATASET)).map((record) => record.id))
    for (const id of [...this.persistedTabs.keys()]) if (!stored.has(id)) this.persistedTabs?.delete(id)
    this.persistTabs()
  }

  // ── Config (profiles + settings) ──────────────────────────────────────────
  /** Load persisted settings + profiles (call once on register). */
  loadConfig(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.profileLoad) return this.profileLoad
    const loading = this.trackGuestWork(this.readConfig()).finally(() => { if (this.profileLoad === loading) this.profileLoad = undefined })
    this.profileLoad = loading
    return loading
  }

  private async readConfig(): Promise<void> {
    const raw = this.api.settings.get()
    const settings = normalizeSettings(raw)
    await this.profileWrites.catch(() => {})
    const snapshot = await this.api.backend.call<ProfilesSnapshot>('data.profiles.list', {})
    if (this.disposed) return
    this.profileRevisions.set(PROFILES_DATASET, snapshot.revisions.profiles)
    this.profileRevisions.set(PROFILE_ADBLOCK_DATASET, snapshot.revisions.adblock)
    const profiles = snapshot.profiles
    this.committedProfiles = structuredClone(profiles)
    this.profileWrites = Promise.resolve()
    const normalProfileId = profiles.find((p) => !p.private)?.id ?? DEFAULT_PROFILE_ID
    const wanted = typeof raw.activeProfileId === 'string' ? raw.activeProfileId : DEFAULT_PROFILE_ID
    const activeProfileId = profiles.some((p) => p.id === wanted) ? wanted : normalProfileId

    // Restore the open tabs persisted before the last reload. Merge under any tab
    // an early Page mount already created: keep a tab the user has actively
    // navigated (non-empty url), otherwise adopt the saved page.
    const restored: Record<string, WebTabState> = {}
    const activation = !this.tabsLoaded
    try {
      const recs = await this.rows(TABS_DATASET)
      if (activation) this.persistedTabs = new Map(recs.map((r) => [String(r.id), JSON.stringify([r.id, r.url, r.title, r.profileId])]))
      for (const r of recs) {
        const id = typeof r.id === 'string' ? r.id : ''
        if (!id) continue
        const profileId =
          typeof r.profileId === 'string' && profiles.some((p) => p.id === r.profileId)
            ? r.profileId
            : normalProfileId
        restored[id] = {
          url: typeof r.url === 'string' ? r.url : '',
          title: typeof r.title === 'string' ? r.title : '',
          profileId
        }
      }
    } catch {
      /* first run — nothing saved yet */
    }
    if (this.disposed) return
    const tabs: Record<string, WebTabState> = { ...this.snap.tabs }
    // Restore only tabs this window still shows: records of a surface torn down
    // while the plugin was unloaded (or in a closed window) are dropped on activation.
    const open = new Set(this.api.workspace.getOpenMainTabs())
    let dropped = false
    for (const [id, t] of Object.entries(restored)) {
      const cur = tabs[id]
      if (!cur && !open.has(id) && !this.hosts.has(id) && id !== '__single') { dropped = true; continue }
      if (!cur || !cur.url) tabs[id] = t
    }
    const remounted = new Set<string>()
    for (const [id, tab] of Object.entries(tabs)) {
      if (!profiles.some((p) => p.id === tab.profileId)) {
        tabs[id] = { ...tab, profileId: normalProfileId }
        remounted.add(id)
      }
    }

    await this.loadProfileLists(activeProfileId)
    if (this.disposed) return
    this.setSnap({
      settings,
      profiles,
      profileError: undefined,
      activeProfileId,
      tabs,
      favorites: this.favCache.get(activeProfileId) ?? [],
      readingList: this.readingCache.get(activeProfileId) ?? [],
      history: this.histCache.get(activeProfileId) ?? []
    })
    await this.persistProfiles()
    if (this.disposed) return
    if (activeProfileId !== wanted) void this.api.settings.set('activeProfileId', activeProfileId)
    this.tabsLoaded = true
    // A guest created before the restore landed (empty url → homepage) is now
    // re-driven to its saved page; refresh each restored Notes tab label too.
    for (const id of Object.keys(tabs)) {
      if (remounted.has(id)) this.disposeView(id)
      this.drive(id)
      this.updateWorkspaceTabTitle(id)
    }
    if (remounted.size > 0 || (activation && dropped)) this.persistTabs()
    this.syncAdblock(true)
  }

  /** Push every profile's ad-block settings to the main-process engines. Runs on
   *  load and whenever one profile's blocker configuration changes.
   *  Coalesced: main rebuilds the whole Ghostery engine per call, so flipping a
   *  handful of filter-list toggles must reach it as one push, not one each. */
  private syncAdblock(immediate = false): void {
    if (this.adblockTimer != null) window.clearTimeout(this.adblockTimer)
    if (immediate) {
      this.adblockTimer = null
      this.pushAdblock()
      return
    }
    this.adblockTimer = window.setTimeout(() => {
      this.adblockTimer = null
      this.pushAdblock()
    }, ADBLOCK_SYNC_DELAY)
  }

  private pushAdblock(): void {
    void this.trackGuestWork(this.api.backend.call('filter.configure', {
      profiles: this.committedProfiles.map((profile) => ({
        partition: partitionFor(profile.id),
        enabled: profile.adblockEnabled,
        rules: profile.adblockRules,
        frequencyDays: profile.adblockFrequency
      }))
    })).catch((error) => console.error(error))
  }

  get settings(): WebSettings {
    return this.snap.settings
  }

  setSetting<K extends keyof WebSettings>(key: K, value: WebSettings[K]): void {
    this.setSnap({ settings: { ...this.snap.settings, [key]: value } })
    void this.api.settings.set(key, value)
  }

  // ── Profiles ──────────────────────────────────────────────────────────────
  private persistProfiles(): Promise<void> {
    const nextProfiles = structuredClone(this.snap.profiles)
    const epoch = this.profileEpoch
    const write = this.profileWrites.then(async () => {
      const profiles = this.profileRevisions.get(PROFILES_DATASET), adblock = this.profileRevisions.get(PROFILE_ADBLOCK_DATASET)
      if (epoch !== this.profileEpoch || profiles === undefined || adblock === undefined) throw profileRefusal('REVISION_CONFLICT', uiText('surfing.error.profileChanged'))
      const result = await this.api.backend.call<ProfilesSnapshot>('data.profiles.set', { profiles: nextProfiles, expected: { profiles, adblock } })
      this.profileRevisions.set(PROFILES_DATASET, result.revisions.profiles)
      this.profileRevisions.set(PROFILE_ADBLOCK_DATASET, result.revisions.adblock)
      this.committedProfiles = result.profiles
      if (!this.disposed) this.syncAdblock()
    })
    this.profileWrites = write.catch(async () => {
      this.profileEpoch++
      this.setSnap({ profiles: structuredClone(this.committedProfiles), profileError: uiText('surfing.error.profileChanged') })
      this.syncAdblock()
      await this.resyncProfiles()
    })
    return write
  }

  // A failed profile write leaves its revisions unknown. Re-read the committed
  // profiles so one failure does not refuse every later edit until a manual reload.
  private async resyncProfiles(): Promise<void> {
    if (this.disposed || !this.tabsLoaded) return
    try {
      const snapshot = await this.api.backend.call<ProfilesSnapshot>('data.profiles.list', {})
      if (this.disposed) return
      const known = (id: string): boolean => snapshot.profiles.some(profile => profile.id === id)
      if (!known(this.snap.activeProfileId) || Object.values(this.snap.tabs).some(tab => !known(tab.profileId))) return
      this.profileRevisions.set(PROFILES_DATASET, snapshot.revisions.profiles)
      this.profileRevisions.set(PROFILE_ADBLOCK_DATASET, snapshot.revisions.adblock)
      this.committedProfiles = structuredClone(snapshot.profiles)
      this.setSnap({ profiles: structuredClone(snapshot.profiles), profileError: undefined })
      this.syncAdblock()
    } catch {
      /* keep profileError; the settings Reload action retries */
    }
  }

  flushProfiles(): Promise<void> { return this.profileWrites }

  private assertProfilesWritable(): void {
    if (this.profileLoad || this.snap.profileError) throw profileRefusal('REVISION_CONFLICT', this.snap.profileError || uiText('surfing.error.profileChanged'))
  }

  addProfile(name: string): string {
    const { id, saved } = this.stageProfile(name)
    void saved.catch(() => {})
    return id
  }

  async createProfile(name: string): Promise<string> {
    const { id, saved } = this.stageProfile(name)
    await saved
    return id
  }

  private stageProfile(name: string): { id: string; saved: Promise<void> } {
    this.assertProfilesWritable()
    const parsed = profileSettingsPatchSchema.safeParse({ name })
    if (!parsed.success) throw profileRefusal('INVALID_INPUT', uiText('surfing.error.invalid', { value: 'name' }))
    name = parsed.data.name!
    const id = newProfileId()
    const profile: WebProfile = {
      id,
      name: name.trim() || 'Profile',
      createdAt: Date.now(),
      ...normalizeProfileAdblock({})
    }
    const profiles = reconcileProfiles([...this.snap.profiles, profile])
    this.setSnap({ profiles })
    const saved = this.persistProfiles()
    this.syncAdblock()
    return { id, saved }
  }

  patchProfileSettings(id: string, patch: Partial<Pick<WebProfile, 'name' | 'icon' | 'hidden' | 'adblockEnabled' | 'adblockRules' | 'adblockFrequency'>>): Promise<void> {
    if (this.profileLoad) throw profileRefusal('REVISION_CONFLICT', uiText('surfing.error.profileChanged'))
    patch = profileSettingsPatchSchema.parse(patch)
    const current = this.snap.profiles.find(profile => profile.id === id)
    if (!current) throw profileRefusal('TARGET_NOT_FOUND', uiText('surfing.error.profile'))
    this.assertProfilesWritable()
    if (current.private && ['name', 'icon', 'hidden'].some(key => Object.hasOwn(patch, key))) throw profileRefusal('ACTION_UNAVAILABLE', uiText('surfing.error.incognito'))
    if (patch.hidden === true && !canHideProfile(this.snap.profiles, id)) throw profileRefusal('ACTION_UNAVAILABLE', uiText('surfing.error.lastProfile'))
    const profiles = this.snap.profiles.map(profile => {
      if (profile.id !== id) return profile
      const next = { ...profile, ...patch }
      if (patch.name !== undefined) next.name = patch.name.trim() || profile.name
      if (!next.icon) delete next.icon
      if (!next.hidden) delete next.hidden
      return next
    })
    const activeProfileId = this.snap.activeProfileId === id && patch.hidden === true
      ? switcherProfiles(profiles)[0]?.id ?? this.snap.activeProfileId : this.snap.activeProfileId
    const switched = activeProfileId !== this.snap.activeProfileId
    this.setSnap({ profiles, activeProfileId })
    const saved = this.persistProfiles()
    if (switched) void saved.then(() => { void this.api.settings.set('activeProfileId', activeProfileId); void this.refreshActiveLists() }).catch(() => {})
    return saved
  }

  setProfileAdblockSetting<K extends 'adblockEnabled' | 'adblockRules' | 'adblockFrequency'>(id: string, key: K, value: WebProfile[K]): void {
    if (this.snap.profiles.some(profile => profile.id === id)) void this.patchProfileSettings(id, { [key]: value })
  }

  renameProfile(id: string, name: string): void {
    if (id !== INCOGNITO_PROFILE_ID) void this.patchProfileSettings(id, { name })
  }

  setProfileIcon(id: string, icon: string): void {
    if (id !== INCOGNITO_PROFILE_ID) void this.patchProfileSettings(id, { icon })
  }

  setProfileHidden(id: string, hidden: boolean): void {
    if (id === INCOGNITO_PROFILE_ID || hidden && !canHideProfile(this.snap.profiles, id)) return
    void this.patchProfileSettings(id, { hidden })
  }

  async deleteProfile(id: string): Promise<void> {
    this.assertProfilesWritable()
    if (!canDeleteProfile(this.snap.profiles, id)) return
    const profiles = reconcileProfiles(this.snap.profiles.filter((p) => p.id !== id))
    const replacementId = switcherProfiles(profiles)[0]?.id ?? profiles.find((p) => !p.private)?.id ?? DEFAULT_PROFILE_ID
    const wasActive = this.snap.activeProfileId === id
    const activeProfileId = wasActive ? replacementId : this.snap.activeProfileId
    const tabs = this.remapTabProfile(this.snap.tabs, id, replacementId)
    this.setSnap({ profiles })
    await this.persistProfiles()
    this.setSnap({ activeProfileId, tabs })
    if (wasActive) void this.api.settings.set('activeProfileId', activeProfileId)
    this.persistTabs()
    const retiredGuests = this.remountProfileViews(id)
    this.syncAdblock()
    // The profile deletion is already committed, so a browser-data failure here is never a no-effect refusal.
    const clearedBrowserData = retiredGuests.then(() => this.clearBrowserData(id)).catch((cause: unknown) => {
      throw Object.assign(new Error(cause instanceof Error ? cause.message : String(cause), { cause }), { code: 'EFFECT_UNVERIFIED', outcome: 'unknown', retryable: false })
    })
    // Drop the deleted profile's per-profile lists (history/favorites/reading).
    this.favCache.delete(id)
    this.readingCache.delete(id)
    this.histCache.delete(id)
    this.listLoads.delete(id)
    await clearedBrowserData
    if (wasActive) await this.refreshActiveLists()
  }

  private remapTabProfile(
    tabs: Record<string, WebTabState>,
    fromProfileId: string,
    toProfileId: string
  ): Record<string, WebTabState> {
    return Object.fromEntries(
      Object.entries(tabs).map(([id, tab]) => [
        id,
        tab.profileId === fromProfileId ? { ...tab, profileId: toProfileId } : tab
      ])
    )
  }

  private async remountProfileViews(profileId: string): Promise<void> {
    const closing: Promise<void>[] = []
    for (const [id, owner] of this.guestLifetimes) if (owner.profileId === profileId) closing.push(this.disposeView(id))
    await Promise.all(closing)
  }

  setActiveProfile(id: string): void {
    if (!this.snap.profiles.some((p) => p.id === id)) return
    this.setSnap({ activeProfileId: id })
    void this.api.settings.set('activeProfileId', id)
    void this.refreshActiveLists()
  }

  private profileById(id: string): WebProfile | undefined {
    return this.snap.profiles.find((p) => p.id === id)
  }

  /** A private profile (Incognito) never records browsing history. */
  private isPrivate(id: string): boolean {
    return this.profileById(id)?.private === true
  }

  // ── Saved-page lists (favorites / reading list / timeline) ──────────────────
  /** Hydrate a profile's three lists from disk into the caches (once). Each cache
   *  holds the list newest-first. Concurrent callers share a single in-flight load. */
  loadProfileLists(profileId: string): Promise<void> {
    let p = this.listLoads.get(profileId)
    if (!p) {
      p = this.hydrateLists(profileId)
      this.listLoads.set(profileId, p)
    }
    return p
  }

  private async hydrateLists(profileId: string): Promise<void> {
    await this.profileWrites
    const [fav, reading, hist] = await Promise.all([
      this.readSavedPages(profileId, 'favorite'),
      this.readSavedPages(profileId, 'reading'),
      this.readVisits(profileId)
    ])
    this.favCache.set(profileId, fav)
    this.readingCache.set(profileId, reading)
    this.histCache.set(profileId, hist)
    if (hist[0]?.ts != null) this.lastHistoryTs.set(profileId, hist[0].ts)
  }

  /** Read one saved-page kind in its persisted order. */
  private async readSavedPages(profileId: string, kind: 'favorite' | 'reading'): Promise<SavedPage[]> {
    if (this.isPrivate(profileId)) return (kind === 'favorite' ? this.favCache : this.readingCache).get(profileId) ?? []
    const snapshot = await this.api.backend.call<PagesSnapshot>('data.saved.list', { profileId, kind })
    this.listRevisions.set(`saved:${profileId}:${kind}`, snapshot.revision)
    return snapshot.pages
  }

  private async readVisits(profileId: string): Promise<SavedPage[]> {
    if (this.isPrivate(profileId)) return []
    const snapshot = await this.api.backend.call<PagesSnapshot>('data.history.list', { profileId })
    this.listRevisions.set(`history:${profileId}`, snapshot.revision)
    return snapshot.pages
  }

  private async persistSavedPages(profileId: string, kind: 'favorite' | 'reading', pages: SavedPage[]): Promise<void> {
    if (this.isPrivate(profileId)) return
    await beforeEffect(this.profileWrites)
    const expectedRevision = this.listRevisions.get(`saved:${profileId}:${kind}`)
    if (expectedRevision === undefined) throw profileRefusal('REVISION_CONFLICT', 'Reload saved pages before saving')
    const result = await this.api.backend.call<PagesSnapshot>('data.saved.set', { profileId, kind, pages, expectedRevision })
    for (const key of this.listRevisions.keys()) if (key.startsWith('saved:')) this.listRevisions.set(key, result.revision)
  }

  /** Ensure a profile's lists are loaded before a mutation (public — the page
   *  toolbar star acts on the viewed tab's profile, which may not be active). */
  ensureProfileLoaded(profileId: string): Promise<void> {
    return beforeEffect(this.loadProfileLists(profileId))
  }

  /** How much a profile holds, for the Settings → Profiles rows. Reads the
   *  caches only — call {@link ensureProfileLoaded} first for a profile that has
   *  never been active, or the counts read zero. */
  profileStats(profileId: string): { favorites: number; reading: number; history: number } {
    return {
      favorites: this.favCache.get(profileId)?.length ?? 0,
      reading: this.readingCache.get(profileId)?.length ?? 0,
      history: this.histCache.get(profileId)?.length ?? 0
    }
  }

  /** Re-mirror the active profile's caches into the snapshot (after a switch). */
  private async refreshActiveLists(): Promise<void> {
    const id = this.snap.activeProfileId
    await this.loadProfileLists(id)
    if (this.snap.activeProfileId !== id) return // switched again mid-load
    this.setSnap({
      favorites: this.favCache.get(id) ?? [],
      readingList: this.readingCache.get(id) ?? [],
      history: this.histCache.get(id) ?? []
    })
  }

  /** Push the active profile's favorites/readingList/history arrays into the
   *  snapshot from the caches (new references → the Panel re-renders). */
  private syncActiveLists(profileId: string): void {
    if (profileId !== this.snap.activeProfileId) return
    this.setSnap({
      favorites: [...(this.favCache.get(profileId) ?? [])],
      readingList: [...(this.readingCache.get(profileId) ?? [])],
      history: [...(this.histCache.get(profileId) ?? [])]
    })
  }

  isFavorite(profileId: string, url: string): boolean {
    return (this.favCache.get(profileId) ?? []).some((p) => p.url === url)
  }

  /** Toggle a page in a profile's favorites (dedup by url). Returns the new state.
   *  A private profile (Incognito) keeps the toggle for the current session only —
   *  it never reaches disk, so nothing survives once the session ends. */
  async toggleFavorite(profileId: string, page: SavedPage): Promise<boolean> {
    if (!page.url) return false
    await beforeEffect(this.loadProfileLists(profileId))
    const cur = this.favCache.get(profileId) ?? []
    const exists = cur.some((p) => p.url === page.url)
    const next = exists ? cur.filter((p) => p.url !== page.url) : [page, ...cur]
    await this.persistSavedPages(profileId, 'favorite', next)
    this.favCache.set(profileId, next)
    this.syncActiveLists(profileId)
    return !exists
  }

  async removeFavorite(profileId: string, url: string): Promise<void> {
    await beforeEffect(this.loadProfileLists(profileId))
    const next = (this.favCache.get(profileId) ?? []).filter((p) => p.url !== url)
    await this.persistSavedPages(profileId, 'favorite', next)
    this.favCache.set(profileId, next)
    this.syncActiveLists(profileId)
  }

  /** Add a page to a profile's reading list (dedup by url, newest-first). Private
   *  profiles keep the addition for the current session only (never persisted). */
  async addToReadingList(profileId: string, page: SavedPage): Promise<void> {
    if (!page.url) return
    await beforeEffect(this.loadProfileLists(profileId))
    const cur = this.readingCache.get(profileId) ?? []
    const next = [page, ...cur.filter((p) => p.url !== page.url)]
    await this.persistSavedPages(profileId, 'reading', next)
    this.readingCache.set(profileId, next)
    this.syncActiveLists(profileId)
  }

  async removeFromReadingList(profileId: string, url: string): Promise<void> {
    await beforeEffect(this.loadProfileLists(profileId))
    const next = (this.readingCache.get(profileId) ?? []).filter((p) => p.url !== url)
    await this.persistSavedPages(profileId, 'reading', next)
    this.readingCache.set(profileId, next)
    this.syncActiveLists(profileId)
  }

  // ── Assistant activity (session-only, never persisted) ────────────────────
  beginAgentActivity(entry: { url: string; mode: WebFetchMode; title: string }): string {
    const id = `fetch-${Date.now().toString(36)}-${(counter++).toString(36)}`
    this.setSnap({ agentActivity: [{ id, ...entry, state: 'running' as const, ts: Date.now() }, ...this.snap.agentActivity].slice(0, AGENT_ACTIVITY_LIMIT) })
    return id
  }

  finishAgentActivity(id: string, page: WebFetchPage): void {
    this.updateAgentActivity(id, {
      state: 'done', url: page.url, title: page.title || hostOf(page.url), status: page.status, contentType: page.contentType,
      bytes: page.bytes, durationMs: page.durationMs, cached: page.cached, instanceId: page.instanceId
    })
  }

  failAgentActivity(id: string, error: WebFetchErrorCode | null, durationMs: number): void {
    this.updateAgentActivity(id, { state: 'error', error, durationMs })
  }

  clearAgentActivity(): void {
    this.setSnap({ agentActivity: this.snap.agentActivity.filter((entry) => entry.state === 'running') })
  }

  private updateAgentActivity(id: string, patch: Partial<WebAgentActivity>): void {
    if (!this.snap.agentActivity.some((entry) => entry.id === id)) return
    this.setSnap({ agentActivity: this.snap.agentActivity.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) })
  }

  /** Load a URL in the one visible tab the assistant reads rendered pages from, opening it when needed. */
  openAgentTab(url: string): string {
    const current = this.agentTabId && this.snap.tabs[this.agentTabId] ? this.agentTabId : null
    if (current) {
      if (this.snap.tabs[current].url === url) void this.browserReload(current)
      else this.navigate(current, url)
      this.api.workspace.openMainTab({ instanceId: current })
      return current
    }
    const id = this.openTab(url)
    this.agentTabId = id
    this.api.workspace.openMainTab({ instanceId: id, title: hostOf(url), newTab: true })
    return id
  }

  /** Resolve when the tab's guest finishes loading, or report a timeout; rejects only on cancellation. */
  waitForLoad(id: string, timeoutMs: number, cancellation?: AbortSignal): Promise<'load' | 'timeout'> {
    return new Promise((resolve, reject) => {
      const waiters = this.loadWaiters.get(id) ?? new Set<(result: 'load' | 'timeout') => void>()
      this.loadWaiters.set(id, waiters)
      const release = (): void => {
        window.clearTimeout(timer)
        waiters.delete(settle)
        if (!waiters.size) this.loadWaiters.delete(id)
        cancellation?.removeEventListener('abort', abort)
      }
      const settle = (result: 'load' | 'timeout'): void => { release(); resolve(result) }
      const abort = (): void => { release(); reject(cancellation?.reason ?? new Error('Cancelled')) }
      const timer = window.setTimeout(() => settle('timeout'), timeoutMs)
      waiters.add(settle)
      if (cancellation?.aborted) abort()
      else cancellation?.addEventListener('abort', abort, { once: true })
    })
  }

  /** Open a saved/historical url as its own browser tab (used by the sidebar lists). */
  openUrl(url: string, title = ''): string {
    const id = this.openTab(url)
    try {
      this.api.workspace.openMainTab({ instanceId: id, title: title || url || 'New tab', newTab: true })
    } catch {
      /* host not ready */
    }
    return id
  }

  // ── History (per profile) ─────────────────────────────────────────────────
  private appendHistory(profileId: string, url: string, title: string): void {
    if (this.isPrivate(profileId)) return // a private profile keeps no timeline
    if (!/^https?:/i.test(url)) return
    if (this.lastHistoryUrl.get(profileId) === url) return
    this.lastHistoryUrl.set(profileId, url)
    const cachedTs = this.histCache.get(profileId)?.[0]?.ts ?? 0
    const ts = Math.max(Date.now(), cachedTs + 1, (this.lastHistoryTs.get(profileId) ?? 0) + 1)
    this.lastHistoryTs.set(profileId, ts)
    const row = { id: `${profileId}:${ts}:${counter++}`, profileId, url, title, ts }
    this.historyWriteQueue = this.historyWriteQueue
      .then(async () => { await this.profileWrites; await this.api.backend.call('data.history.append', { profileId, page: { url, title, ts }, id: row.id }); this.listRevisions.delete(`history:${profileId}`) })
      .catch(() => {})
    if (this.histCache.has(profileId)) {
      this.histCache.set(profileId, [{ url, title, ts }, ...(this.histCache.get(profileId) ?? [])])
      this.syncActiveLists(profileId)
    }
  }

  async readHistory(profileId: string): Promise<HistoryEntry[]> {
    await this.historyWriteQueue
    return this.readVisits(profileId)
  }

  async clearHistory(profileId: string): Promise<void> {
    await this.historyWriteQueue
    if (!this.isPrivate(profileId)) {
      let expectedRevision = this.listRevisions.get(`history:${profileId}`)
      if (expectedRevision === undefined) { await beforeEffect(this.readVisits(profileId)); expectedRevision = this.listRevisions.get(`history:${profileId}`) }
      const result = await this.api.backend.call<PagesSnapshot>('data.history.clear', { profileId, expectedRevision })
      this.listRevisions.set(`history:${profileId}`, result.revision)
    }
    this.lastHistoryUrl.delete(profileId)
    this.lastHistoryTs.delete(profileId)
    this.histCache.set(profileId, [])
    this.syncActiveLists(profileId)
  }

  /** Clear cookies/cache/storage for a profile's isolated partition (main process
   *  owns the Electron session — the renderer is not the trust boundary). */
  async clearBrowserData(profileId: string): Promise<void> {
    const partition = partitionFor(profileId)
    const bound = await this.api.drivers.browser.bindPartition(partition)
    // Nothing was cleared until clearData dispatches; after that only the driver can vouch for no effect.
    if (!bound.ok) throw profileRefusal('ACTION_UNAVAILABLE', bound.error || uiText('surfing.error.storage'))
    const result = await this.api.drivers.browser.clearData(partition)
    if (!result.ok) throw Object.assign(new Error(result.error || uiText('surfing.error.clear')), (result as { outcome?: unknown }).outcome === 'not-applied' ? { code: (result as { code?: unknown }).code, outcome: 'not-applied', retryable: false } : {})
  }

  // ── Tab state (React-facing) ──────────────────────────────────────────────
  /** Open a new browser tab (in the active profile unless one is named — a private
   *  tab runs in the Incognito session without moving the sidebar off the user's
   *  profile); returns its `instanceId`. */
  openTab(input = '', profileId = this.snap.activeProfileId): string {
    const id = genId()
    const url = input.trim() ? toUrl(input, this.snap.settings.searchEngine) : ''
    this.setSnap({ tabs: { ...this.snap.tabs, [id]: { url, title: '', profileId } } })
    this.persistTabs()
    return id
  }

  /** Ensure a record exists (a reload restored the Notes tab but emptied the store). */
  ensureTab(id: string): void {
    if (!this.snap.tabs[id]) {
      this.setSnap({ tabs: { ...this.snap.tabs, [id]: { url: '', title: '', profileId: this.snap.activeProfileId } } })
    }
  }

  getTab(id: string): WebTabState | undefined {
    return this.snap.tabs[id]
  }

  restoreTab(id: string, tab: WebTabState): void {
    if (!this.snap.profiles.some((profile) => profile.id === tab.profileId)) throw new Error(uiText('surfing.error.profile'))
    const previous = this.snap.tabs[id]
    if (previous?.profileId !== tab.profileId) this.disposeView(id)
    else if (previous?.url !== tab.url) this.invalidateGuestRead(id)
    this.setSnap({ tabs: { ...this.snap.tabs, [id]: { ...tab } } })
    this.persistTabs()
    this.drive(id)
    this.updateWorkspaceTabTitle(id)
  }

  private browserGuest<T extends DriverResult>(
    instanceId: string,
    run: (guestId: string) => Promise<T>,
    read = false
  ): Promise<T> {
    const guestId = this.browserGuests.get(instanceId)
    const owner = this.guestLifetimes.get(instanceId)
    const view = this.views.get(instanceId), revision = view?.revision
    if (!guestId || !owner?.active()) {
      return Promise.resolve({ ok: false, error: uiText('surfing.error.liveTab', { value: instanceId }), code: 'TARGET_NOT_FOUND', outcome: 'not-applied' } as DriverResult as T)
    }
    return owner.run(() => run(guestId)).then(result => read && (!owner.active() || this.views.get(instanceId) !== view || view?.revision !== revision)
      ? { ok: false, error: uiText('surfing.error.liveTab', { value: instanceId }) } as T : result)
  }

  async listBrowserTabs(): Promise<BrowserTabsResult> {
    if (this.disposed) return { ok: true, data: { tabs: [] } }
    const captured = new Map(this.browserGuests)
    const result = await this.trackGuestWork(this.api.drivers.browser.list())
    if (!result.ok) return { ok: false, error: result.error }
    if (this.disposed) return { ok: true, data: { tabs: [] } }
    const live = new Set((result.data?.guests ?? []).map((guest) => guest.guestId))
    for (const [instanceId, guestId] of captured) {
      if (this.browserGuests.get(instanceId) === guestId && !live.has(guestId)) this.disposeView(instanceId)
    }
    const tabs = [...this.browserGuests.keys()].flatMap((instanceId) => {
      const tab = this.snap.tabs[instanceId]
      return tab ? [{ instanceId, url: tab.url, title: tab.title }] : []
    })
    return { ok: true, data: { tabs } }
  }

  browserSnapshot(instanceId: string): Promise<BrowserSnapshotResult> {
    return this.browserGuest(instanceId, (guestId) => browserAutomation(this.api).snapshot(guestId), true)
  }

  browserReadText(instanceId: string, maxChars?: number): Promise<BrowserTextResult> {
    return this.browserGuest(instanceId, (guestId) => browserAutomation(this.api).readText(guestId, maxChars), true)
  }

  browserReadHtml(instanceId: string): Promise<BrowserHtmlResult> {
    return this.browserGuest(instanceId, (guestId) => browserAutomation(this.api).readHtml(guestId), true)
  }

  browserScreenshot(instanceId: string): Promise<BrowserCaptureResult> {
    return this.browserGuest(instanceId, (guestId) => this.api.drivers.browser.screenshot(guestId), true)
  }

  browserClick(instanceId: string, ref: number): Promise<BrowserActionResult> {
    return this.browserGuest(instanceId, (guestId) => browserAutomation(this.api).click(guestId, ref))
  }

  browserType(instanceId: string, ref: number, text: string, submit?: boolean): Promise<BrowserActionResult> {
    return this.browserGuest(instanceId, (guestId) => browserAutomation(this.api).type(guestId, ref, text, submit))
  }

  browserSelect(instanceId: string, ref: number, value: string): Promise<BrowserActionResult> {
    return this.browserGuest(instanceId, (guestId) => browserAutomation(this.api).select(guestId, ref, value))
  }

  browserScroll(instanceId: string, dx: number, dy: number): Promise<BrowserActionResult> {
    return this.browserGuest(instanceId, (guestId) => browserAutomation(this.api).scroll(guestId, dx, dy))
  }

  browserPressKey(instanceId: string, key: string): Promise<BrowserActionResult> {
    return this.browserGuest(instanceId, (guestId) => this.api.drivers.browser.pressKey(guestId, key))
  }

  browserNavigate(instanceId: string, url: string): Promise<BrowserActionResult> {
    this.invalidateGuestRead(instanceId)
    return this.browserGuest(instanceId, (guestId) => this.api.drivers.browser.navigate(guestId, url))
  }

  browserBack(instanceId: string): Promise<BrowserActionResult> {
    this.invalidateGuestRead(instanceId)
    return this.browserGuest(instanceId, (guestId) => this.api.drivers.browser.back(guestId))
  }

  browserForward(instanceId: string): Promise<BrowserActionResult> {
    this.invalidateGuestRead(instanceId)
    return this.browserGuest(instanceId, (guestId) => this.api.drivers.browser.forward(guestId))
  }

  browserReload(instanceId: string): Promise<BrowserActionResult> {
    this.invalidateGuestRead(instanceId)
    return this.browserGuest(instanceId, (guestId) => this.api.drivers.browser.reload(guestId))
  }

  /** Address-bar / panel navigation (normalizes input + drives the guest). */
  navigate(id: string, input: string): void {
    const url = toUrl(input, this.snap.settings.searchEngine)
    if (this.patch(id, { url, metadata: undefined, connection: undefined })) {
      this.invalidateGuestRead(id)
      this.drive(id)
      this.updateWorkspaceTabTitle(id)
    }
  }

  /** The guest navigated itself — record the real URL + log history (no re-drive). */
  reportUrl(id: string, url: string): void {
    const changed = this.snap.tabs[id]?.url !== url
    if (changed) this.invalidateGuestRead(id)
    if (this.patch(id, { url, ...(changed ? { metadata: undefined, connection: undefined } : {}) })) {
      const tab = this.snap.tabs[id]
      if (tab) this.appendHistory(tab.profileId, url, tab.title)
      this.updateWorkspaceTabTitle(id)
    }
  }

  setTitle(id: string, title: string): void {
    if (this.patch(id, { title })) this.updateWorkspaceTabTitle(id)
  }

  private async readPageMetadata(id: string, el: WebviewEl): Promise<void> {
    const url = this.snap.tabs[id]?.url
    const revision = el.revision
    if (!url) return
    try {
      const metadata = normalizePageMetadata(await el.executeJavaScript(PAGE_METADATA_SCRIPT, false))
      if (this.views.get(id) === el && el.revision === revision && this.snap.tabs[id]?.url === url) this.patch(id, { metadata })
    } catch {
      /* Cross-origin pages may refuse inspection while navigating. */
    }
  }

  closeTab(id: string): void {
    if (this.snap.tabs[id]) {
      const rest: Record<string, WebTabState> = {}
      for (const [k, v] of Object.entries(this.snap.tabs)) if (k !== id) rest[k] = v
      this.setSnap({ tabs: rest })
      this.persistTabs()
    }
    this.disposeView(id)
  }

  // ── Guest controls (from the page toolbar) ────────────────────────────────
  /**
   * Every one of these reaches into the guest's `webContents`, and Electron
   * *throws* ("The WebView must be attached to the DOM and the dom-ready event
   * emitted before this method can be called") for the whole window between
   * mounting a `<webview>` and its `dom-ready`. `Page.tsx` publishes its
   * navigation controller from an effect that runs inside exactly that window on
   * a freshly opened tab, so an unguarded `canGoBack` crashed the view outright.
   */
  private guestCall<T>(id: string, run: (view: WebviewEl) => T, fallback: T): T {
    const view = this.views.get(id)
    if (!view) return fallback
    try {
      return run(view)
    } catch {
      return fallback /* guest not attached / not dom-ready yet */
    }
  }
  goBack(id: string): void {
    this.invalidateGuestRead(id)
    this.guestCall(id, (v) => v.goBack(), undefined)
  }
  goForward(id: string): void {
    this.invalidateGuestRead(id)
    this.guestCall(id, (v) => v.goForward(), undefined)
  }
  canGoBack(id: string): boolean {
    return this.guestCall(id, (v) => v.canGoBack(), false)
  }
  canGoForward(id: string): boolean {
    return this.guestCall(id, (v) => v.canGoForward(), false)
  }
  reload(id: string): void {
    this.invalidateGuestRead(id)
    this.guestCall(id, (v) => v.reload(), undefined)
  }

  /** Read the current text selection inside a guest's top frame (''=none/failure).
   *  Used to seed a web SideNote from the highlighted text on the page. */
  async getSelectionText(id: string): Promise<string> {
    const v = this.views.get(id)
    if (!v) return ''
    const revision = v.revision
    try {
      const text = await v.executeJavaScript('String(window.getSelection?.() ?? "")', false)
      return !this.disposed && this.views.get(id) === v && v.revision === revision && typeof text === 'string' ? text.trim() : ''
    } catch {
      return ''
    }
  }

  private invalidateGuestRead(id: string): void {
    const view = this.views.get(id)
    if (view) view.revision = (view.revision ?? 0) + 1
  }

  private drive(id: string): void {
    const v = this.views.get(id)
    const url = this.snap.tabs[id]?.url
    if (!v || !url) return
    try {
      if (v.getURL() !== url) void v.loadURL(url)
    } catch {
      /* guest not ready */
    }
  }

  private updateWorkspaceTabTitle(id: string): void {
    const t = this.snap.tabs[id]
    if (!t) return
    const label = t.title || hostOf(t.url) || 'New tab'
    try {
      this.api.workspace.setMainTabTitle(label, id)
    } catch {
      /* host not ready */
    }
  }

  startOverlay(): void {
    if (this.disposed) return
    if (this.reconcileTimer == null) this.reconcileTimer = window.setInterval(() => this.reconcile(), 1500)
  }

  mountTab(id: string): () => void {
    this.ensureTab(id)
    this.hosts.add(id)
    return () => { this.hosts.delete(id); this.reconcile() }
  }

  guestTarget(id: string): GuestTarget | undefined {
    const tab = this.snap.tabs[id]
    if (this.disposed || !tab) return
    let target = this.guestTargets.get(id)
    if (!target || target.profileId !== tab.profileId) {
      target = Object.freeze({ instanceId: id, profileId: tab.profileId })
      this.guestTargets.set(id, target)
    }
    return target
  }

  bindGuest(id: string, target = this.guestTarget(id)) {
    let active = true
    const current = (): boolean => active && target !== undefined && this.guestTarget(id) === target
    return {
      target,
      prepare: async (): Promise<void> => {
        if (!current()) return
        await this.trackGuestWork(this.api.backend.call('filter.prepare', { partition: partitionFor(target!.profileId) }))
      },
      onReady: (event: PluginBrowserGuestEvent): void => { if (current()) this.readyGuest(id, event, target) },
      dispose: (): void => { active = false }
    }
  }

  readyGuest(id: string, event: PluginBrowserGuestEvent, target = this.guestTarget(id)): void {
    if (!target || this.guestTarget(id) !== target || this.disposed) return
    if (this.browserGuests.get(id) !== event.guestId) this.guestEvent(id, event, true)
  }

  guestEvent(id: string, event: PluginBrowserGuestEvent, acceptReady = false): void {
    if (this.disposed || !this.snap.tabs[id]) return
    if ((!acceptReady || event.type !== 'ready') && this.browserGuests.get(id) !== event.guestId) return
    if (event.type === 'ready' && event.guestId && (this.browserGuests.get(id) !== event.guestId || !this.views.has(id))) {
      const target = this.guestTarget(id)!
      if (this.browserGuests.get(id) !== event.guestId) this.disposeView(id, true)
      this.browserGuests.set(id, event.guestId)
      const guestId = event.guestId
      const driver = this.api.drivers.browser
      let owner!: GuestLifetime
      const value: WebviewEl = {
        revision: 0, guestId, url: event.url ?? '', back: !!event.canGoBack, forward: !!event.canGoForward, audible: !!event.audible,
        loadURL: async (url) => { const result = await owner.run(() => driver.navigate(guestId, url)); if (!result.ok) throw new Error(result.error) },
        getURL: () => value.url,
        reload: () => { void owner.run(() => driver.reload(guestId)).catch(() => {}) },
        canGoBack: () => value.back, canGoForward: () => value.forward,
        goBack: () => { void owner.run(() => driver.back(guestId)).catch(() => {}) }, goForward: () => { void owner.run(() => driver.forward(guestId)).catch(() => {}) },
        executeJavaScript: async (script, userGesture) => { const result = await owner.run(() => driver.execute(guestId, script, userGesture)); if (!result.ok) throw new Error(result.error); return result.data },
        isCurrentlyAudible: () => value.audible
      }
      owner = createGuestLifetime(this.api, {
        instanceId: id, guestId, profileId: target.profileId,
        current: () => !this.disposed && this.guestTarget(id) === target && this.views.get(id) === value,
        page: () => this.snap.tabs[id], audible: () => value.audible, document: () => value.revision ?? 0
      })
      this.guestLifetimes.set(id, owner)
      this.views.set(id, value)
    }
    const view = this.views.get(id)
    if (!view) return
    if (event.type === 'console') this.guestLifetimes.get(id)?.message(event.message)
    if (event.type === 'load' || event.type === 'ready' || event.type === 'navigate') this.invalidateGuestRead(id)
    if (event.url) { view.url = event.url; this.reportUrl(id, event.url) }
    if (event.connection) this.patch(id, { connection: event.connection })
    if (event.title) this.setTitle(id, event.title)
    if (event.canGoBack !== undefined) view.back = event.canGoBack
    if (event.canGoForward !== undefined) view.forward = event.canGoForward
    if (event.audible !== undefined) view.audible = event.audible
    if (event.type === 'ready') {
      this.guestLifetimes.get(id)?.ready(event.playing)
      const previous = this.cosmetics.get(id)
      if (previous) void this.trackGuestWork(this.guestLifetimes.get(id)!.run(previous)).catch(error => console.error(error))
      this.cosmetics.set(id, watchBrowserCosmetics(this.api, view.guestId, partitionFor(this.snap.tabs[id].profileId), {
        active: () => !this.disposed && this.views.get(id) === view,
        revision: () => view.revision ?? 0
      }))
    }
    if (event.type === 'load' || event.type === 'ready') void this.readPageMetadata(id, view)
    if (event.type === 'load') for (const settle of [...this.loadWaiters.get(id) ?? []]) settle('load')
    if (event.type === 'media') { if (event.playing) this.guestLifetimes.get(id)?.play(); else this.guestLifetimes.get(id)?.pause() }
    if (event.type === 'command') { if (event.command === 'browser-backward') this.goBack(id); if (event.command === 'browser-forward') this.goForward(id) }
    this.setSnap({})
  }

  private disposeView(id: string, preserveTarget = false): Promise<void> {
    const cosmetics = this.cosmetics.get(id)
    this.cosmetics.delete(id)
    const owner = this.guestLifetimes.get(id)
    this.guestLifetimes.delete(id)
    if (!preserveTarget) this.guestTargets.delete(id)
    this.browserGuests.delete(id)
    this.views.delete(id)
    const closing = owner ? owner.dispose(cosmetics) : cosmetics ? cosmetics() : Promise.resolve()
    void this.trackGuestWork(closing).catch(error => { this.guestFailure ??= error })
    return closing
  }

  private reconcile(): void {
    const open = new Set(this.api.workspace.getOpenMainTabs())
    for (const id of this.views.keys()) if (!open.has(id) && !this.hosts.has(id)) this.closeTab(id)
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    if (this.persistTimer != null) clearTimeout(this.persistTimer)
    this.persistTimer = null
    // A pending ad-block push belongs to this session's driver handle — let it
    // land now rather than firing after the plugin has been torn down.
    if (this.adblockTimer != null) {
      window.clearTimeout(this.adblockTimer)
      this.adblockTimer = null
      this.pushAdblock()
    }
    this.offData()
    this.offBrowser()
    this.offState()
    this.offTabs()
    if (this.reconcileTimer != null) clearInterval(this.reconcileTimer)
    this.reconcileTimer = null
    for (const id of this.views.keys()) this.disposeView(id)
    this.hosts.clear()
    this.listeners.clear()
    return this.disposal = (async () => {
      await this.profileWrites.catch(() => {})
      while (this.guestWork.size) await Promise.allSettled([...this.guestWork])
      if (this.guestFailure) throw this.guestFailure
    })()
  }
}

export function createStore(api: ValleyPluginApi): WebStore {
  const holder = api.runtime.getOrCreate<{ current: WebStore | null }>(STORE_KEY, () => ({ current: null }))
  void holder.current?.dispose().catch(error => console.error(error))
  const store = new WebStore(api)
  holder.current = store
  return store
}

export function getStore(): WebStore | null {
  return runtimeApi.runtime.getOrCreate<{ current: WebStore | null }>(STORE_KEY, () => ({ current: null })).current
}

export function disposeStore(api: ValleyPluginApi, store: WebStore): Promise<void> {
  const holder = api.runtime.getOrCreate<{ current: WebStore | null }>(STORE_KEY, () => ({ current: null }))
  const disposed = store.dispose()
  if (holder.current === store) holder.current = null
  return disposed
}
