import { parseDatePattern, type DateToken } from '@valley/plugin-sdk/datePattern'

/**
 * Pure profile + settings helpers (unit-tested). A *profile* is an isolated
 * persistent browser session: its `partition` keys Electron's cookie/cache/storage
 * store, so two profiles never share a login. History is kept per profile.
 */
export interface WebProfile {
  id: string
  name: string
  createdAt: number
  /** Private profile (e.g. Incognito): browsing history is never recorded. */
  private?: boolean
  /** Glyph id from `PROFILE_GLYPHS` (icons.tsx); empty → the name's first letter. */
  icon?: string
  /** Hidden from the sidebar profile switcher (the profile itself is kept). */
  hidden?: boolean
  adblockEnabled: boolean
  adblockRules: string
  adblockFrequency: number
}

export interface HistoryEntry {
  url: string
  title: string
  ts: number
}

/** A saved page entry — used for history (timeline), favorites and the reading
 *  list. All three are per-profile lists of the same `{url,title,ts}` shape. */
export type SavedPage = HistoryEntry

export type SearchEngineId = 'google' | 'bing' | 'duckduckgo' | 'baidu' | 'yahoo'

export interface WebSettings {
  homepage: string
  searchEngine: SearchEngineId
  openExternalInApp: boolean
  openWebsiteOnNewTab: boolean
}

export const DEFAULT_PROFILE_ID = 'default'
export const INCOGNITO_PROFILE_ID = 'incognito'
export const DEFAULT_ADBLOCK_RULES = 'https://easylist.to/easylist/easylist.txt\nhttps://easylist.to/easylist/easyprivacy.txt'
export const DEFAULT_ADBLOCK_FREQUENCY = 7

export const DEFAULT_SETTINGS: WebSettings = {
  homepage: '',
  searchEngine: 'google',
  openExternalInApp: false,
  openWebsiteOnNewTab: true
}

export function defaultProfile(): WebProfile {
  return {
    id: DEFAULT_PROFILE_ID,
    name: 'Default',
    createdAt: 0,
    adblockEnabled: true,
    adblockRules: DEFAULT_ADBLOCK_RULES,
    adblockFrequency: DEFAULT_ADBLOCK_FREQUENCY
  }
}

/** The pre-seeded private profile: an isolated session that records no history. */
export function incognitoProfile(): WebProfile {
  return {
    id: INCOGNITO_PROFILE_ID,
    name: 'Incognito',
    createdAt: 0,
    private: true,
    adblockEnabled: true,
    adblockRules: DEFAULT_ADBLOCK_RULES,
    adblockFrequency: DEFAULT_ADBLOCK_FREQUENCY
  }
}

export function normalizeProfileAdblock(r: {
  adblockEnabled?: unknown
  adblockRules?: unknown
  adblockFrequency?: unknown
}): Pick<WebProfile, 'adblockEnabled' | 'adblockRules' | 'adblockFrequency'> {
  return {
    adblockEnabled: typeof r.adblockEnabled === 'boolean' ? r.adblockEnabled : true,
    adblockRules: typeof r.adblockRules === 'string' ? r.adblockRules : DEFAULT_ADBLOCK_RULES,
    adblockFrequency:
      typeof r.adblockFrequency === 'number' && Number.isInteger(r.adblockFrequency) && r.adblockFrequency >= 0
        ? r.adblockFrequency
        : DEFAULT_ADBLOCK_FREQUENCY
  }
}

export function reconcileProfiles(profiles: WebProfile[]): WebProfile[] {
  const seen = new Set<string>()
  const incognitoAdblock = normalizeProfileAdblock(profiles.find((profile) => profile.id === INCOGNITO_PROFILE_ID) ?? {})
  const normal = profiles
    .filter((profile) => {
      if (profile.id === INCOGNITO_PROFILE_ID || profile.private || seen.has(profile.id)) return false
      seen.add(profile.id)
      return true
    })
    .map(({ id, name, createdAt, icon, hidden, ...adblock }) => {
      const profile: WebProfile = { id, name, createdAt, ...normalizeProfileAdblock(adblock) }
      if (icon) profile.icon = icon
      if (hidden) profile.hidden = true
      return profile
    })
  return [...(normal.length > 0 ? normal : [defaultProfile()]), { ...incognitoProfile(), ...incognitoAdblock }]
}

export function canDeleteProfile(profiles: WebProfile[], id: string): boolean {
  const profile = profiles.find((entry) => entry.id === id)
  return Boolean(profile && !profile.private && profiles.filter((entry) => !entry.private).length > 1)
}

/**
 * The profiles offered by the sidebar switcher: normal (non-private) profiles the
 * user has not hidden. Hiding them all would leave nothing to switch to, so the
 * first normal profile is kept as a floor.
 */
export function switcherProfiles(profiles: WebProfile[]): WebProfile[] {
  const normal = profiles.filter((p) => !p.private)
  const shown = normal.filter((p) => !p.hidden)
  return shown.length > 0 ? shown : normal.slice(0, 1)
}

/** False when `id` is the last profile left in the switcher — it may not be hidden. */
export function canHideProfile(profiles: WebProfile[], id: string): boolean {
  const shown = switcherProfiles(profiles)
  return shown.length > 1 || !shown.some((p) => p.id === id)
}

/** Electron partition for a profile. Incognito gets a bare (non-`persist:`)
 *  partition name — Electron keeps those in-memory only, so its cookies/cache/
 *  storage never touch disk and vanish with the session. Every other profile
 *  gets a `persist:` partition (isolated, durable cookies/storage). */
export function partitionFor(profileId: string): string {
  if (profileId === INCOGNITO_PROFILE_ID) return 'web-incognito'
  return profileId === DEFAULT_PROFILE_ID ? 'persist:web-default' : `persist:web_${profileId}`
}

export function newProfileId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

const SEARCH: Record<SearchEngineId, (q: string) => string> = {
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  baidu: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
  yahoo: (q) => `https://search.yahoo.com/search?p=${encodeURIComponent(q)}`
}

export function searchUrl(engine: SearchEngineId, query: string): string {
  return (SEARCH[engine] ?? SEARCH.google)(query)
}

/** Normalize a loaded record into a WebProfile (tolerant of partial data). */
export function normalizeProfile(r: Record<string, unknown>): WebProfile | null {
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (!id) return null
  const name = typeof r.name === 'string' && r.name.trim() ? r.name : id
  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : 0
  const profile: WebProfile = { id, name, createdAt, ...normalizeProfileAdblock(r) }
  if (r.private === true) profile.private = true
  if (typeof r.icon === 'string' && r.icon.trim()) profile.icon = r.icon.trim()
  if (r.hidden === true) profile.hidden = true
  return profile
}

/** Normalize a loaded record into a SavedPage (favorites / reading list / history). */
export function normalizeSavedPage(r: Record<string, unknown>): SavedPage | null {
  const url = typeof r.url === 'string' ? r.url : ''
  if (!url) return null
  return {
    url,
    title: typeof r.title === 'string' ? r.title : '',
    ts: typeof r.ts === 'number' ? r.ts : 0
  }
}

/** Format a Timeline entry's timestamp using the host's General-settings
 *  date/time format (`dateFormat` pattern + 12h/24h), so history reads the same
 *  as dates shown elsewhere in the app. */
export function formatHistoryTimestamp(ts: number, dateFormat: string, timeFormat: '24h' | '12h'): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const values: Record<DateToken, string> = { dd: pad(d.getDate()), mm: pad(d.getMonth() + 1), yyyy: String(d.getFullYear()) }
  const parsed = parseDatePattern(dateFormat)
  const dateStr = parsed
    ? parsed.tokens.map((token, i) => values[token] + (parsed.separators[i] ?? '')).join('')
    : `${values.dd}.${values.mm}.${values.yyyy}`
  const timeStr = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h' }).format(d)
  return `${dateStr} · ${timeStr}`
}

export type TimelineGroupKey = 'morning' | 'afternoon' | 'evening' | 'yesterday' | 'week' | 'month' | 'year' | 'threeYears' | 'past'

export const TIMELINE_GROUP_ORDER: TimelineGroupKey[] = [
  'morning',
  'afternoon',
  'evening',
  'yesterday',
  'week',
  'month',
  'year',
  'threeYears',
  'past'
]

function timelineGroupKey(ts: number, now: number): TimelineGroupKey {
  const day = 86400000
  const startOfDay = (t: number): number => {
    const d = new Date(t)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const todayStart = startOfDay(now)
  const entryStart = startOfDay(ts)
  if (entryStart === todayStart) {
    const hour = new Date(ts).getHours()
    if (hour < 12) return 'morning'
    if (hour < 18) return 'afternoon'
    return 'evening'
  }
  const daysAgo = Math.round((todayStart - entryStart) / day)
  if (daysAgo === 1) return 'yesterday'
  if (daysAgo <= 7) return 'week'
  if (daysAgo <= 31) return 'month'
  if (daysAgo <= 365) return 'year'
  if (daysAgo <= 365 * 3) return 'threeYears'
  return 'past'
}

/** Bucket Timeline entries into browser-style relative-time groups (This
 *  morning/afternoon/evening, Yesterday, Last week/month/year/3 years, Past) in
 *  chronological-bucket order, skipping empty buckets. `history` is expected
 *  newest-first; order within a bucket is preserved. */
export function groupHistory(history: SavedPage[], now = Date.now()): { key: TimelineGroupKey; items: SavedPage[] }[] {
  const buckets = new Map<TimelineGroupKey, SavedPage[]>()
  for (const p of history) {
    const key = timelineGroupKey(p.ts, now)
    const list = buckets.get(key)
    if (list) list.push(p)
    else buckets.set(key, [p])
  }
  return TIMELINE_GROUP_ORDER.filter((key) => buckets.has(key)).map((key) => ({ key, items: buckets.get(key) as SavedPage[] }))
}

/** Merge a plugin-settings record onto the defaults (tolerant). */
export function normalizeSettings(s: Record<string, unknown>): WebSettings {
  const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d)
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  const eng = (v: unknown): SearchEngineId =>
    v === 'bing' || v === 'duckduckgo' || v === 'google' || v === 'baidu' || v === 'yahoo'
      ? v
      : DEFAULT_SETTINGS.searchEngine
  return {
    homepage: str(s.homepage, DEFAULT_SETTINGS.homepage),
    searchEngine: eng(s.searchEngine),
    openExternalInApp: bool(s.openExternalInApp, DEFAULT_SETTINGS.openExternalInApp),
    openWebsiteOnNewTab: bool(s.openWebsiteOnNewTab, DEFAULT_SETTINGS.openWebsiteOnNewTab)
  }
}
