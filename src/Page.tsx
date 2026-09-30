import { partitionFor } from './profiles'
import { React, api } from './runtime'
import type { FC, ReactNode } from 'react'
import type { MainWorkspaceViewProps } from '@valley/plugin-sdk'
import { useWeb } from './hooks'
import { clearWebContext, publishWebContext } from './webContext'
import { uiText } from './localization'
import { IncognitoIcon, ProfileMark } from './icons'

/** 16px line icon for the nav buttons — uniform stroke so back/forward/reload align. */
const NavIcon: FC<{ path?: string; children?: ReactNode }> = ({ path, children }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path ? <path d={path} /> : children}
  </svg>
)

/** A star that fills when the page is a favorite of its tab's profile. */
const StarIcon: FC<{ filled?: boolean }> = ({ filled }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
)

export const Page: FC<MainWorkspaceViewProps> = ({ instanceId, navigation }) => {
  const id = instanceId ?? '__single'
  const { store, snap } = useWeb()
  const BrowserGuest = store?.api.ui.BrowserGuest ?? api.ui.BrowserGuest
  const tab = snap.tabs[id]
  const url = tab?.url ?? ''
  const title = tab?.title ?? ''
  const profileId = tab?.profileId ?? snap.activeProfileId
  const target = store?.guestTarget(id)
  const profile = snap.profiles.find((entry) => entry.id === profileId)
  const profileName = profile?.name ?? profileId
  const [draft, setDraft] = React.useState(url)

  React.useEffect(() => {
    setDraft(url)
  }, [url])

  React.useEffect(() => {
    if (!store) return
    navigation.setController({
      canGoBack: store.canGoBack(id),
      canGoForward: store.canGoForward(id),
      goBack: () => { if (store.guestTarget(id) === target) store.goBack(id) },
      goForward: () => { if (store.guestTarget(id) === target) store.goForward(id) }
    })
    return () => navigation.setController(null)
  }, [id, navigation, snap, store, target])

  // Favorite state for the star. The viewed tab is normally in the active
  // profile, so the snapshot (which mirrors the active profile's favorites)
  // drives it live; for the rare cross-profile tab, fall back to an async read.
  const sameProfile = profileId === snap.activeProfileId
  const [favOther, setFavOther] = React.useState(false)
  React.useEffect(() => {
    if (sameProfile || !url || !store) return
    let alive = true
    void store.ensureProfileLoaded(profileId).then(() => {
      if (alive) setFavOther(store.isFavorite(profileId, url))
    })
    return () => {
      alive = false
    }
  }, [sameProfile, profileId, url, store])
  const isFav = !!url && (sameProfile ? snap.favorites.some((f) => f.url === url) : favOther)

  const toggleFav = (): void => {
    if (!url || !store) return
    void store.toggleFavorite(profileId, { url, title, ts: Date.now() }).then((now) => {
      if (!sameProfile) setFavOther(now)
    })
  }

  const [readyGuest, setReadyGuest] = React.useState<ReturnType<NonNullable<typeof store>['bindGuest']> | null>(null)
  const [loadError, setLoadError] = React.useState('')
  React.useEffect(() => {
    let active = true
    if (!store || !target) return
    const binding = store.bindGuest(id, target)
    setLoadError('')
    void binding.prepare().then(() => { if (active) setReadyGuest(binding) }).catch((error) => { if (active) setLoadError(String(error)) })
    return () => { active = false; binding.dispose() }
  }, [id, profileId, store, target])
  React.useEffect(() => store?.mountTab(id), [id, store])

  // Publish this tab as the active website while it's mounted (only the active tab
  // per pane mounts) so the SideNotes panel can attach notes to the page. Clear on
  // unmount (switched to a file/other tab) — `clearWebContext` is order-safe.
  React.useEffect(() => {
    publishWebContext({ instanceId: id, url, title })
    return () => clearWebContext(id)
  }, [id, url, title])

  const go = (): void => {
    if (draft.trim() && store?.guestTarget(id) === target) store?.navigate(id, draft)
  }

  return (
    <div className="web-page">
      <div className="web-toolbar">
        <div
          className="web-toolbar-profile"
          title={uiText('surfing.profile.current', { p0: profileName })}
          aria-label={uiText('surfing.profile.current', { p0: profileName })}
        >
          {profile?.private
            ? <IncognitoIcon className="web-profile-mark" />
            : <ProfileMark icon={profile?.icon} name={profileName} className="web-profile-mark web-profile-mark--plain" />}
          <span>{profileName}</span>
        </div>
        <input
          className="web-address"
          value={draft}
          placeholder={uiText('auto.ca86a7f049b6')}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
        />
        <div className="web-nav-group">
          <button className="web-nav-btn" title={uiText('auto.cce7155371fc')} aria-label={uiText('auto.cce7155371fc')} onClick={() => { if (store?.guestTarget(id) === target) store?.reload(id) }}>
            <NavIcon>
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </NavIcon>
          </button>
        </div>
        <button
          className={`web-nav-btn web-star${isFav ? ' is-active' : ''}`}
          title={isFav ? uiText('auto.a0831985eb91') : uiText('auto.5dfbd9ba8ed9')}
          aria-pressed={isFav}
          disabled={!url}
          onClick={toggleFav}
        >
          <StarIcon filled={isFav} />
        </button>
      </div>
      <div className="web-host">{loadError ? <div role="alert">{loadError}</div> : target && readyGuest?.target === target ? <BrowserGuest key={`${id}:${profileId}`} instanceId={id} src={url || snap.settings.homepage || 'https://www.google.com'} partition={partitionFor(profileId)} requestFilter="filter.request" audioManaged onReady={readyGuest.onReady} /> : <api.ui.ContentLoader label={uiText('surfing.embed.loading')} />}</div>
    </div>
  )
}
