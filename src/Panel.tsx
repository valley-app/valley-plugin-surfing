import { React, api } from './runtime'
import type { FC, ReactNode } from 'react'
import { getStore, type WebAgentActivity } from './store'
import { formatBytes } from './webFetch'
import { useWeb, useActiveWebContext, useHostDateFormat } from './hooks'
import {
  formatHistoryTimestamp,
  groupHistory,
  INCOGNITO_PROFILE_ID,
  switcherProfiles,
  type SavedPage,
  type TimelineGroupKey,
  type WebProfile
} from './profiles'
import { ChevronIcon, ValleyIcon, EyeglassesIcon, IncognitoIcon, ProfileMark } from './icons'
import { uiText } from './localization'

/** Hostname for the secondary line of a saved-page row (falls back to the url). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/** A star glyph for the Favorites list tab. */
const StarIcon: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
)

/** A clock glyph for the Timeline (history) tab. */
const TimelineIcon: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 16 14" />
  </svg>
)

/** A sparkle glyph for the Assistant (fetch activity) tab. */
const AssistantIcon: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
  </svg>
)

const CheckIcon: FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

const FailedIcon: FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

type ListKind = 'favorites' | 'reading' | 'timeline' | 'assistant'

function timelineGroupLabel(key: TimelineGroupKey): string {
  switch (key) {
    case 'morning':
      return uiText('auto.84ac260e32b3')
    case 'afternoon':
      return uiText('auto.28fabba4c4dc')
    case 'evening':
      return uiText('auto.4f0544b71013')
    case 'yesterday':
      return uiText('auto.da24830f1f70')
    case 'week':
      return uiText('auto.76c1ed930901')
    case 'month':
      return uiText('auto.9cce45bf8d2b')
    case 'year':
      return uiText('auto.3cf4d8d7b9bc')
    case 'threeYears':
      return uiText('auto.1a02f6494874')
    case 'past':
      return uiText('auto.405c12fb19d5')
  }
}

/** Favorites/Reading list/Timeline/Assistant switcher as icon tabs (mirrors the Clock plugin's tab strip). */
const ListTabs: FC<{ active: ListKind; fetching: boolean; onSelect: (kind: ListKind) => void }> = ({ active, fetching, onSelect }) => (
  <div className="web-list-tabs">
    <button
      className={`web-list-tab${active === 'favorites' ? ' active' : ''}`}
      title={uiText('auto.07b3e447db02')}
      aria-pressed={active === 'favorites'}
      onClick={() => onSelect('favorites')}
    >
      <StarIcon />
    </button>
    <button
      className={`web-list-tab${active === 'reading' ? ' active' : ''}`}
      title={uiText('auto.d80f6ec7eac0')}
      aria-pressed={active === 'reading'}
      onClick={() => onSelect('reading')}
    >
      <EyeglassesIcon />
    </button>
    <button
      className={`web-list-tab${active === 'timeline' ? ' active' : ''}`}
      title={uiText('auto.018514a3d58a')}
      aria-pressed={active === 'timeline'}
      onClick={() => onSelect('timeline')}
    >
      <TimelineIcon />
    </button>
    <button
      className={`web-list-tab${active === 'assistant' ? ' active' : ''}`}
      title={uiText('surfing.activity.title')}
      aria-label={fetching ? uiText('surfing.activity.titleBusy') : uiText('surfing.activity.title')}
      aria-pressed={active === 'assistant'}
      onClick={() => onSelect('assistant')}
    >
      <AssistantIcon />
      {fetching && <span className="web-list-tab-dot" aria-hidden="true" />}
    </button>
  </div>
)

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function activityDetail(entry: WebAgentActivity): string {
  const host = hostOf(entry.url)
  if (entry.state === 'running') return `${host} · ${uiText(entry.mode === 'rendered' ? 'surfing.activity.rendering' : 'surfing.activity.fetching')}`
  if (entry.state === 'error') return `${host} · ${uiText(`surfing.activity.error.${entry.error ?? 'network'}`)}`
  return [
    host,
    entry.status == null ? null : String(entry.status),
    entry.bytes == null ? null : formatBytes(entry.bytes),
    entry.durationMs == null ? null : formatDuration(entry.durationMs),
    entry.mode === 'rendered' ? uiText('surfing.activity.rendered') : null,
    entry.cached ? uiText('surfing.activity.cached') : null
  ].filter(Boolean).join(' · ')
}

const ActivityRow: FC<{ entry: WebAgentActivity; onOpen: (e: React.MouseEvent) => void }> = ({ entry, onOpen }) => (
  <div className={`web-list-row web-activity-row is-${entry.state}`} title={entry.url}>
    <span className="web-activity-mark" aria-label={uiText(`surfing.activity.state.${entry.state}`)}>
      {entry.state === 'running' ? <span className="web-activity-spinner" /> : entry.state === 'done' ? <CheckIcon /> : <FailedIcon />}
    </span>
    <button className="web-list-open" onClick={onOpen}>
      <span className="web-list-title">{entry.state === 'running' ? hostOf(entry.url) : entry.title || entry.url}</span>
      <span className="web-list-url">{activityDetail(entry)}</span>
    </button>
  </div>
)

/** The active list's header action (add-current / clear) + its rows. */
const ListPane: FC<{ action?: ReactNode; children: ReactNode }> = ({ action, children }) => (
  <div className="web-sec">
    {action && <div className="web-sec-head">{action}</div>}
    <div className="web-list">{children}</div>
  </div>
)

/**
 * The profile switcher: a field-styled button that draws its own closed state and
 * opens the host's shared menu (so it follows Appearance → Action menus and stays
 * clamped to the viewport). The list ends in a permanent private-tab action, the
 * way every browser keeps Incognito one click away.
 *
 * `shown` is the session the *focused* tab is actually running in, which is not
 * always the active profile: a private tab runs in Incognito while the sidebar
 * stays on the user's own profile. The button names that session (and the private
 * row ticks) so "am I browsing privately right now?" is answerable at a glance.
 */
const ProfileButton: FC<{
  profiles: WebProfile[]
  shown: WebProfile | undefined
  isPrivate: boolean
  onSelect: (id: string) => void
  onPrivate: () => void
}> = ({ profiles, shown, isPrivate, onSelect, onPrivate }) => {
  const ref = React.useRef<HTMLButtonElement>(null)
  const name = shown?.name ?? ''
  const open = (): void => {
    const anchor = ref.current
    if (!anchor) return
    void api.ui.openMenu(
      [
        ...profiles.map((p) => ({
          id: p.id,
          label: p.name,
          type: 'radio' as const,
          checked: !isPrivate && p.id === shown?.id,
          icon: <ProfileMark icon={p.icon} name={p.name} className="web-profile-mark web-profile-mark--plain" />,
          onSelect: () => onSelect(p.id)
        })),
        { type: 'separator' as const },
        {
          id: 'private',
          label: uiText('auto.b44a40a69a18'),
          description: uiText('auto.a022100d66bb'),
          type: 'radio' as const,
          checked: isPrivate,
          icon: <IncognitoIcon />,
          onSelect: onPrivate
        }
      ],
      { anchor, align: 'start' }
    )
  }
  return (
    <button ref={ref} className="web-profile-btn" title={name} aria-haspopup="menu" onClick={open}>
      {isPrivate ? <IncognitoIcon className="web-profile-mark" /> : <ProfileMark icon={shown?.icon} name={name} />}
      <span className="web-profile-label">{name}</span>
      <ChevronIcon className="web-profile-chevron" />
    </button>
  )
}

const SavedRow: FC<{
  page: SavedPage
  timestamp?: string
  onOpen: (e: React.MouseEvent) => void
  onRemove?: () => void
}> = ({ page, timestamp, onOpen, onRemove }) => (
  <div className="web-list-row" title={page.url}>
    <button className="web-list-open" onClick={onOpen}>
      <span className="web-list-title">{page.title || page.url}</span>
      <span className="web-list-url">
        {hostOf(page.url)}
        {timestamp && <span className="web-list-ts"> · {timestamp}</span>}
      </span>
    </button>
    {onRemove && (
      <button className="web-list-remove" title={uiText('auto.e963907dac5c')} onClick={onRemove}>
        ×
      </button>
    )}
  </div>
)

/**
 * `surfing.panel` (left_sidebar) — a browser-style sidebar: a profile dropdown that
 * picks the session new tabs open in (plus a permanent private-tab action), a
 * button that opens a fresh browser workspace tab (its own address bar takes the
 * url), and the active profile's Favorites, Reading list and Timeline. A private
 * profile (Incognito) keeps no Timeline.
 */
export const Panel: FC = () => {
  const { snap } = useWeb()
  const [listKind, setListKind] = React.useState<ListKind>('favorites')
  const activeWeb = useActiveWebContext()
  const { dateFormat, timeFormat } = useHostDateFormat()
  const activeId = snap.activeProfileId
  const activeProfile = snap.profiles.find((p) => p.id === activeId)
  const switcher = switcherProfiles(snap.profiles)

  // The session the focused tab actually runs in. A private tab is not a profile
  // switch, so the sidebar (and its lists) stay on the user's own profile — but
  // the switcher must still say "Incognito" while that tab has focus, or there is
  // no way to tell a private tab from a normal one.
  const focusedProfileId = activeWeb ? snap.tabs[activeWeb.instanceId]?.profileId : undefined
  const focusedProfile = focusedProfileId ? snap.profiles.find((p) => p.id === focusedProfileId) : undefined
  const showingPrivate = focusedProfile?.private === true
  const shownProfile = showingPrivate ? focusedProfile : activeProfile

  /** Open a fresh tab in the active profile — empty, so the guest loads the
   *  homepage and the tab's own address bar takes over from here. */
  const openNewTab = (): void => {
    getStore()?.openUrl('')
  }

  /** A private tab runs in the Incognito session but leaves the sidebar on the
   *  user's own profile (opening one is not a profile switch). */
  const openPrivateTab = (): void => {
    const store = getStore()
    if (!store) return
    const id = store.openTab('', INCOGNITO_PROFILE_ID)
    api.workspace.openMainTab({ instanceId: id, title: uiText('auto.6f23a36f0aa1'), newTab: true })
  }

  const switchProfile = (id: string): void => {
    const store = getStore()
    if (!store) return
    if (id !== activeId) store.setActiveProfile(id)
    if (!activeWeb || focusedProfileId === id) return
    const instanceId = store.openTab('', id)
    api.workspace.openMainTab({
      instanceId,
      title: uiText('auto.6f23a36f0aa1'),
      newTab: true
    })
  }

  /** Plain click reuses the currently focused web tab (browser-standard "same
   *  tab" navigation); ⌘/Ctrl-click, or no web tab currently focused, opens a
   *  fresh one — the two cases the old always-new-tab behavior conflated. */
  const openPage = (page: SavedPage, e: React.MouseEvent): void => {
    const store = getStore()
    if (!store) return
    if (!e.metaKey && !e.ctrlKey && activeWeb) {
      store.navigate(activeWeb.instanceId, page.url)
      return
    }
    store.openUrl(page.url, page.title)
  }

  const addCurrentToReading = (): void => {
    if (!activeWeb?.url) return
    void getStore()?.addToReadingList(activeId, { url: activeWeb.url, title: activeWeb.title, ts: Date.now() })
  }

  /** A rendered fetch reveals its visible tab; any other fetch opens its page like a saved row. */
  const openActivity = (entry: WebAgentActivity, e: React.MouseEvent): void => {
    if (entry.instanceId && snap.tabs[entry.instanceId]) {
      api.workspace.openMainTab({ instanceId: entry.instanceId })
      return
    }
    openPage({ url: entry.url, title: entry.title, ts: entry.ts }, e)
  }

  const clearHistory = async (): Promise<void> => {
    const choice = await api.ui.confirm({
      title: uiText('surfing.history.clearTitle'),
      message: uiText('surfing.history.clearMessage'),
      actions: [
        { label: uiText('auto.77dfd2135f4d'), value: 'cancel', variant: 'ghost' },
        { label: uiText('auto.719ea396ad92'), value: 'clear', variant: 'danger' }
      ]
    })
    if (choice === 'clear') await getStore()?.clearHistory(activeId)
  }

  return (
    <div className="web-panel panel-body">
      <div className="web-topbar">
        <ProfileButton
          profiles={switcher}
          shown={shownProfile}
          isPrivate={showingPrivate}
          onSelect={switchProfile}
          onPrivate={openPrivateTab}
        />
        <button className="web-icon-btn" title={uiText('auto.7b144127f2b1')} aria-label={uiText('auto.7b144127f2b1')} onClick={openNewTab}>
          <ValleyIcon />
        </button>
      </div>

      <ListTabs active={listKind} fetching={snap.agentActivity.some((entry) => entry.state === 'running')} onSelect={setListKind} />

      {listKind === 'favorites' && (
        <ListPane>
          {snap.favorites.length === 0 ? (
            <div className="web-empty">{uiText('auto.8410cec01806')}</div>
          ) : (
            snap.favorites.map((p) => (
              <SavedRow
                key={p.url}
                page={p}
                onOpen={(e) => openPage(p, e)}
                onRemove={() => void getStore()?.removeFavorite(activeId, p.url)}
              />
            ))
          )}
        </ListPane>
      )}

      {listKind === 'reading' && (
        <ListPane
          action={
            <button className="web-link-btn" disabled={!activeWeb?.url} onClick={addCurrentToReading}>
              {uiText('auto.f29504f253d2')}</button>
          }
        >
          {snap.readingList.length === 0 ? (
            <div className="web-empty">{uiText('auto.9fc82698d883')}</div>
          ) : (
            snap.readingList.map((p) => (
              <SavedRow
                key={p.url}
                page={p}
                onOpen={(e) => openPage(p, e)}
                onRemove={() => void getStore()?.removeFromReadingList(activeId, p.url)}
              />
            ))
          )}
        </ListPane>
      )}

      {listKind === 'timeline' && (
        <ListPane
          action={
            !activeProfile?.private &&
            snap.history.length > 0 && (
              <button className="web-link-btn" onClick={() => void clearHistory()}>
                {uiText('auto.719ea396ad92')}</button>
            )
          }
        >
          {activeProfile?.private ? (
            <div className="web-empty">{uiText('auto.29423e2bbd96')}</div>
          ) : snap.history.length === 0 ? (
            <div className="web-empty">{uiText('auto.933f417e014a')}</div>
          ) : (
            groupHistory(snap.history).map((group) => (
              <div className="web-group" key={group.key}>
                <div className="web-group-label">{timelineGroupLabel(group.key)}</div>
                {group.items.map((p, i) => (
                  <SavedRow
                    key={`${p.url}-${i}`}
                    page={p}
                    timestamp={formatHistoryTimestamp(p.ts, dateFormat, timeFormat)}
                    onOpen={(e) => openPage(p, e)}
                  />
                ))}
              </div>
            ))
          )}
        </ListPane>
      )}

      {listKind === 'assistant' && (
        <ListPane
          action={
            snap.agentActivity.some((entry) => entry.state !== 'running') && (
              <button className="web-link-btn" onClick={() => getStore()?.clearAgentActivity()}>
                {uiText('surfing.activity.clear')}</button>
            )
          }
        >
          {snap.agentActivity.length === 0 ? (
            <div className="web-empty">{uiText('surfing.activity.empty')}</div>
          ) : (
            snap.agentActivity.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} onOpen={(e) => openActivity(entry, e)} />
            ))
          )}
        </ListPane>
      )}
    </div>
  )
}
