import { React, api } from './runtime'
import type { FC } from 'react'
import { getStore } from './store'
import { useWeb } from './hooks'
import {
  createCustomEmbedProvider,
  customizeEmbedProvider,
  EMBEDS_DIR,
  embedProviderPath,
  loadEmbedProviders,
  type EmbedProviderConfiguration
} from './embedProviders'
import { canDeleteProfile, canHideProfile, type SearchEngineId, type WebProfile } from './profiles'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  IncognitoIcon,
  profileGlyphs,
  ProfileGlyph,
  ProfileMark
} from './icons'
import { uiText } from './localization'

const Button: typeof api.ui.settings.Button = (props) => React.createElement(api.ui.settings.Button, props)
const IconButton: typeof api.ui.settings.IconButton = (props) => React.createElement(api.ui.settings.IconButton, props)
const RangeField: typeof api.ui.settings.RangeField = (props) => React.createElement(api.ui.settings.RangeField, props)
const TextField: typeof api.ui.settings.TextField = (props) => React.createElement(api.ui.settings.TextField, props)
const Section: typeof api.ui.settings.Section = (props) => React.createElement(api.ui.settings.Section, props)

const DraftTextField: FC<{
  value: string
  ariaLabel: string
  className?: string
  placeholder?: string
  disabled?: boolean
  onCommit: (value: string) => void
}> = ({ value, ariaLabel, className, placeholder, disabled, onCommit }) => {
  const [draft, setDraft] = React.useState(value)
  React.useEffect(() => setDraft(value), [value])
  return (
    <TextField
      className={className}
      value={draft}
      disabled={disabled}
      onChange={setDraft}
      onCommit={onCommit}
      onEscape={() => setDraft(value)}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
    />
  )
}

/** Settings → Surfing: general browsing preferences (nothing ad-block/privacy related). */
const WebSection: FC = () => {
  const { snap } = useWeb()
  const s = snap.settings
  const set = getStore()
  const { Row, Toggle, SelectField } = api.ui.settings
  const [homepageDraft, setHomepageDraft] = React.useState(s.homepage)
  React.useEffect(() => {
    setHomepageDraft(s.homepage)
  }, [s.homepage])
  return (
    <Section className="web-settings">
      <Row title={uiText('auto.31a5c06a74ed')} description={uiText('auto.9cc07137e896')}>
        <Toggle checked={s.openExternalInApp} onChange={(v) => set?.setSetting('openExternalInApp', v)} label={uiText('auto.31a5c06a74ed')} />
      </Row>
      <Row title={uiText('surfing.settings.newTab.title')} description={uiText('surfing.settings.newTab.description')}>
        <Toggle checked={s.openWebsiteOnNewTab} onChange={(v) => set?.setSetting('openWebsiteOnNewTab', v)} label={uiText('surfing.settings.newTab.title')} />
      </Row>
      <Row title={uiText('auto.ac066591edb7')} description={uiText('auto.b47d4d632c6c')}>
        <TextField
          value={homepageDraft}
          onChange={setHomepageDraft}
          onCommit={(value) => set?.setSetting('homepage', value.trim())}
          onEscape={() => setHomepageDraft(s.homepage)}
          placeholder="https://…"
          ariaLabel={uiText('auto.ac066591edb7')}
        />
      </Row>
      <Row title={uiText('auto.fb6e677a8ac9')} description={uiText('auto.3f045ed5057a')}>
        <SelectField
          value={s.searchEngine}
          onChange={(v) => set?.setSetting('searchEngine', v as SearchEngineId)}
          options={[
            { value: 'google', label: uiText('auto.2b681c0a24ba') },
            { value: 'bing', label: uiText('auto.271a389c22c7') },
            { value: 'duckduckgo', label: 'DuckDuckGo' },
            { value: 'baidu', label: 'Baidu' },
            { value: 'yahoo', label: 'Yahoo' }
          ]}
          ariaLabel={uiText('auto.fb6e677a8ac9')}
        />
      </Row>
    </Section>
  )
}

/** One profile's blocker controls. The newline-separated list reaches Electron
 * as one coalesced update, so multi-line edits rebuild its engine only once. */
const ProfileAdblockSettings: FC<{ profile: WebProfile }> = ({ profile }) => {
  const store = getStore()
  const { Row, Toggle } = api.ui.settings
  const parseRows = React.useCallback((rules: string): string[] => {
    const rows = rules.split('\n').map((value) => value.trim()).filter(Boolean)
    return rows.length > 0 ? rows : ['']
  }, [])
  const [ruleRows, setRuleRows] = React.useState<string[]>(() => parseRows(profile.adblockRules))
  React.useEffect(() => setRuleRows(parseRows(profile.adblockRules)), [parseRows, profile.adblockRules])
  const commitRows = (next: string[]): void => {
    let keptEmpty = false
    const normalized = next.filter((value) => {
      if (value.trim()) return true
      if (keptEmpty) return false
      keptEmpty = true
      return true
    })
    const visible = normalized.length > 0 ? normalized : ['']
    setRuleRows(visible)
    store?.setProfileAdblockSetting(profile.id, 'adblockRules', visible.map((value) => value.trim()).filter(Boolean).join('\n'))
  }
  return (
    <>
      <Row title={uiText('auto.9e195b5c3352')} description={uiText('auto.c11923624db2')}>
        <Toggle checked={profile.adblockEnabled} onChange={(v) => store?.setProfileAdblockSetting(profile.id, 'adblockEnabled', v)} label={uiText('auto.9e195b5c3352')} />
      </Row>

      <Row className="web-adblock-list-row" title={uiText('auto.f51d3afd314d')} description={uiText('auto.df231132fa35')}>
        <div className="web-adblock-rules">
          {ruleRows.map((value, index) => (
            <div className="settings-row-control web-adblock-rule" key={index}>
              <DraftTextField
                value={value}
                disabled={!profile.adblockEnabled}
                onCommit={(nextValue) => commitRows(ruleRows.map((row, rowIndex) => rowIndex === index ? nextValue : row))}
                placeholder="https://…"
                ariaLabel={uiText('surfing.adblock.ruleLabel', { p0: index + 1 })}
              />
              <IconButton
                size="small"
                disabled={!profile.adblockEnabled || ruleRows.length === 1}
                title={uiText('surfing.adblock.remove')}
                ariaLabel={uiText('surfing.adblock.remove')}
                onClick={() => commitRows(ruleRows.filter((_, rowIndex) => rowIndex !== index))}
              >
                ×
              </IconButton>
            </div>
          ))}
          <div className="web-adblock-add"><Button
            size="small"
            disabled={!profile.adblockEnabled || ruleRows.some((value) => !value.trim())}
            title={uiText('surfing.adblock.add')}
            aria-label={uiText('surfing.adblock.add')}
            onClick={() => {
              if (!ruleRows.some((value) => !value.trim())) setRuleRows([...ruleRows, ''])
            }}
          >
            <span aria-hidden="true">+ </span>{uiText('surfing.adblock.add')}
          </Button></div>
        </div>
      </Row>

      <Row className="web-adblock-frequency-row" title={uiText('auto.c47910540e86')} description={uiText('auto.7e3785a04a80')}>
        <div className="web-adblock-frequency">
        <RangeField
          value={profile.adblockFrequency}
          onChange={(value) => store?.setProfileAdblockSetting(profile.id, 'adblockFrequency', value)}
          min={0}
          max={30}
          disabled={!profile.adblockEnabled}
          ariaLabel={uiText('auto.c47910540e86')}
          style={{ width: '100%', maxWidth: '100%' }}
        />
        </div>
      </Row>

    </>
  )
}

/** The profile's mark, clicked to pick a different glyph from the shared menu. */
const IconPicker: FC<{ profile: WebProfile; large?: boolean; onChange: (icon: string) => void }> = ({ profile, large, onChange }) => {
  const ref = React.useRef<HTMLButtonElement>(null)
  const open = (): void => {
    const anchor = ref.current
    if (!anchor) return
    void api.ui.openMenu(
      [
        {
          // A real id, never '': the shared menu selects by id and an empty
          // string is falsy, so the letter row could be clicked but never chosen.
          id: 'letter',
          label: uiText('auto.ee14050617b7'),
          type: 'radio',
          checked: !profile.icon,
          icon: <ProfileMark name={profile.name} className="web-profile-mark web-profile-mark--plain" />,
          onSelect: () => onChange('')
        },
        ...profileGlyphs().map((g) => ({
          id: g.id,
          label: g.label,
          type: 'radio' as const,
          checked: profile.icon === g.id,
          icon: <ProfileGlyph id={g.id} />,
          onSelect: () => onChange(g.id)
        }))
      ],
      { anchor, align: 'start' }
    )
  }
  return (
    <button
      ref={ref}
      className={`web-profile-swatch settings-list-glyph${large ? ' settings-list-glyph--lg' : ''}`}
      title={uiText('auto.f1247003fc00')}
      aria-label={uiText('auto.f1247003fc00')}
      aria-haspopup="menu"
      onClick={open}
    >
      <ProfileMark icon={profile.icon} name={profile.name} className="web-profile-mark--plain" />
    </button>
  )
}

/** The round glyph well a profile is listed by: the incognito mark for the
 *  private profile, its own chosen glyph (or letter) for every other. */
const ProfileWell: FC<{ profile: WebProfile; large?: boolean }> = ({ profile, large }) => (
  <span className={`settings-list-glyph${large ? ' settings-list-glyph--lg' : ''}`}>
    {profile.private ? (
      <IncognitoIcon />
    ) : (
      <ProfileMark icon={profile.icon} name={profile.name} className="web-profile-mark--plain" />
    )}
  </span>
)

/** A sub-page band: a chevron back to the list, then this page's own name. */
const CrumbBand: FC<{ current: string; onBack: () => void }> = ({ current, onBack }) => {
  const label = uiText('auto.98242d9b169a')
  return (
    <div className="settings-listpage-crumbs">
      <button type="button" className="settings-listpage-back" aria-label={label} title={label} onClick={onBack}>
        <ChevronLeftIcon />
      </button>
      <span className="settings-crumb settings-crumb-current">{current}</span>
    </div>
  )
}

interface ProfileStats {
  favorites: number
  reading: number
  history: number
}

/** Which surface the Profiles page is showing — the list, one profile, or the add form. */
type ProfileView = { kind: 'list' } | { kind: 'add' } | { kind: 'profile'; id: string }

/**
 * Settings → Profiles: the same full-bleed list page Accounts and AI Providers
 * use — a header band with `+`, one row per profile, and that profile's own
 * detail page behind its chevron. Incognito is listed too (it is a real,
 * always-present session) and stays fully read-only in Settings.
 */
const ProfilesSection: FC = () => {
  const { snap } = useWeb()
  const store = getStore()
  const [view, setView] = React.useState<ProfileView>({ kind: 'list' })
  const backToList = (): void => setView({ kind: 'list' })

  // The snapshot mirrors only the *active* profile's lists, so hydrate every
  // profile once to count what each holds. `loadProfileLists` dedupes and caches,
  // so this is one read per profile per session.
  const [stats, setStats] = React.useState<Record<string, ProfileStats>>({})
  const profileIds = snap.profiles.map((p) => p.id).join(',')
  React.useEffect(() => {
    if (!store) return
    let alive = true
    const ids = profileIds ? profileIds.split(',') : []
    void Promise.all(ids.map((id) => store.ensureProfileLoaded(id))).then(() => {
      if (!alive) return
      setStats(Object.fromEntries(ids.map((id) => [id, store.profileStats(id)])))
    })
    return () => {
      alive = false
    }
  }, [profileIds, store])

  const remove = (profile: WebProfile): void => {
    void api.ui
      .confirm({
        title: uiText('auto.7035d2d95fb4'),
        message: uiText('auto.0345643b3e41', { p0: profile.name }),
        actions: [
          { label: uiText('auto.77dfd2135f4d'), value: 'cancel', variant: 'ghost' },
          { label: uiText('auto.f6fdbe48dc54'), value: 'delete', variant: 'danger' }
        ]
      })
      .then((choice) => {
        if (choice !== 'delete') return
        backToList()
        store?.deleteProfile(profile.id)
      })
  }

  if (view.kind === 'add') {
    return <AddProfile onBack={backToList} onCreated={(id) => setView({ kind: 'profile', id })} />
  }

  if (view.kind === 'profile') {
    const profile = snap.profiles.find((p) => p.id === view.id)
    if (profile) {
      return (
        <ProfileDetail
          profile={profile}
          stats={stats[profile.id]}
          onBack={backToList}
          onRemove={() => remove(profile)}
        />
      )
    }
  }

  // Incognito is pinned last: it is permanent chrome, not one of the user's own.
  const listed = [...snap.profiles.filter((p) => !p.private), ...snap.profiles.filter((p) => p.private)]

  return (
    <section className="settings-section web-settings settings-listpage">
      <div className="settings-listpage-header">
        <h4 className="settings-label">{uiText('auto.0c2a93009914')}</h4>
        <Button
          className="settings-listpage-add"
          size="small"
          aria-label={uiText('auto.b8e7f05b3ae2')}
          title={uiText('auto.b8e7f05b3ae2')}
          onClick={() => setView({ kind: 'add' })}
        >
          +
        </Button>
      </div>

      <div className="settings-list">
        {listed.map((profile) => (
          <ProfileRow
            key={profile.id}
            profile={profile}
            stats={stats[profile.id]}
            onOpen={() => setView({ kind: 'profile', id: profile.id })}
          />
        ))}
      </div>
    </section>
  )
}

const ProfileRow: FC<{ profile: WebProfile; stats: ProfileStats | undefined; onOpen: () => void }> = ({
  profile,
  stats,
  onOpen
}) => (
  <div
    className="settings-list-row"
    role="button"
    tabIndex={0}
    onClick={onOpen}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onOpen()
      }
    }}
  >
    <ProfileWell profile={profile} />
    <span className="settings-list-meta">
      <span className="settings-list-name">{profile.name}</span>
      {/* What this session is currently holding — the one line that tells two
          same-named profiles apart at a glance. */}
      <span className="settings-list-sub">
        {profile.private
          ? uiText('auto.29423e2bbd96')
          : uiText('auto.b277d38a332a', { p0: stats?.favorites ?? 0, p1: stats?.reading ?? 0, p2: stats?.history ?? 0 })}
      </span>
    </span>
    {profile.private && <span className="web-profile-badge">{"private"}</span>}
    {profile.hidden && !profile.private && <span className="web-profile-badge">{"hidden"}</span>}
    <ChevronRightIcon className="settings-list-chevron" />
  </div>
)

/** One profile's own page: what it is called, what it looks like, what it holds. */
const ProfileDetail: FC<{
  profile: WebProfile
  stats: ProfileStats | undefined
  onBack: () => void
  onRemove: () => void
}> = ({ profile, stats, onBack, onRemove }) => {
  const { snap } = useWeb()
  const store = getStore()
  const { Row, Toggle } = api.ui.settings
  const deletable = canDeleteProfile(snap.profiles, profile.id)

  return (
    <section className="settings-section web-settings">
      <CrumbBand current={profile.name} onBack={onBack} />

      <div className="web-detail-identity">
        {profile.private ? (
          <ProfileWell profile={profile} large />
        ) : (
          <IconPicker profile={profile} large onChange={(icon) => store?.setProfileIcon(profile.id, icon)} />
        )}
        <div className="settings-list-meta">
          <span className="settings-list-name">{profile.name}</span>
          <span className="settings-list-sub">
            {profile.private
              ? uiText('auto.5eef7d318756')
              : uiText('auto.bfe3b7674b5f')}
          </span>
        </div>
      </div>

      {!profile.private && (
        <Row title={uiText('auto.77574766df8d')}>
          <DraftTextField
            value={profile.name}
            onCommit={(value) => store?.renameProfile(profile.id, value)}
            ariaLabel={uiText('auto.77574766df8d')}
          />
        </Row>
      )}

      {!profile.private && (
        <Row title={uiText('auto.2e5ec502b910')} description={uiText('auto.1688150cafb0')}>
          <Toggle
            checked={!profile.hidden}
            disabled={!profile.hidden && !canHideProfile(snap.profiles, profile.id)}
            onChange={(v) => store?.setProfileHidden(profile.id, !v)}
            label={uiText('auto.2e5ec502b910')}
          />
        </Row>
      )}

      <ProfileAdblockSettings profile={profile} />

      {!profile.private && (
        <Row className="web-profile-stats-row" title={uiText('auto.7f3842d0a2fe')} description={uiText('auto.133bf7c7c6e3')}>
          <div className="web-profile-stats" aria-label={uiText('auto.7f3842d0a2fe')}>
            <span><strong>{stats?.favorites ?? 0}</strong><span>{uiText('auto.07b3e447db02')}</span></span>
            <span><strong>{stats?.reading ?? 0}</strong><span>{uiText('auto.d80f6ec7eac0')}</span></span>
            <span><strong>{stats?.history ?? 0}</strong><span>{uiText('auto.018514a3d58a')}</span></span>
          </div>
        </Row>
      )}

      {!profile.private && <div className="settings-row-actions web-profile-actions">
        <Button variant="danger" onClick={() => void store?.clearBrowserData(profile.id)}>{uiText('auto.41c8cf8a5b5b')}</Button>
      </div>}
      {!profile.private && (
        <Row
          className="web-profile-delete-row"
          title={uiText('auto.7035d2d95fb4')}
          description={`${uiText('surfing.profile.deleteDescription')}${deletable ? '' : ` ${uiText('surfing.profile.deleteLast')}`}`}
        >
          <Button
            variant="danger"
            disabled={!deletable}
            onClick={onRemove}
          >
            {uiText('auto.f6fdbe48dc54')}
          </Button>
        </Row>
      )}
    </section>
  )
}

/** The `+` page: name a profile, then land on it. */
const AddProfile: FC<{ onBack: () => void; onCreated: (id: string) => void }> = ({ onBack, onCreated }) => {
  const { Row } = api.ui.settings
  const [name, setName] = React.useState('')
  const create = (): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    const id = getStore()?.addProfile(trimmed)
    if (id) onCreated(id)
    else onBack()
  }
  return (
    <section className="settings-section web-settings">
      <CrumbBand current={uiText('auto.b8e7f05b3ae2')} onBack={onBack} />
      <Row title={uiText('auto.77574766df8d')} description={uiText('surfing.profile.addDescription')}>
        <TextField
          value={name}
          onChange={setName}
          placeholder={uiText('auto.ab1af2941e7b')}
          ariaLabel={uiText('auto.77574766df8d')}
        />
      </Row>
      <div className="settings-row-actions">
        <Button variant="primary" disabled={!name.trim()} onMouseDown={(event) => event.preventDefault()} onClick={create}>
          {uiText('auto.b8e7f05b3ae2')}</Button>
      </div>
    </section>
  )
}

/** Settings → Surfing → Embeds: provider files for note fences. */
const EmbedsSection: FC = () => {
  const { Row } = api.ui.settings
  const [configuration, setConfiguration] = React.useState<EmbedProviderConfiguration | null>(null)
  const [error, setError] = React.useState('')
  const refresh = React.useCallback(() => {
    void loadEmbedProviders().then(setConfiguration)
  }, [])
  React.useEffect(() => {
    refresh()
    return api.data.files.onChanged(refresh)
  }, [refresh])

  if (!configuration) return <Section className="web-settings" />

  return (
    <Section className="web-settings">
      <Row
        title={uiText('surfing.embed.providers.title')}
        description={uiText('surfing.embed.providers.description')}
      >
        <Button variant="secondary" onClick={() => api.files.revealInFinder(EMBEDS_DIR)}>
          {uiText('surfing.embed.manage')}</Button>
      </Row>
      {configuration.providers.map((provider) => (
        <Row key={provider.id} title={provider.displayName}>
          <Button variant="ghost" size="small" onClick={() => {
            if (configuration.customized.includes(provider.id)) { api.files.revealInFinder(embedProviderPath(provider)); return }
            setError('')
            void customizeEmbedProvider(provider).then(() => { refresh(); api.files.revealInFinder(embedProviderPath(provider)) }).catch(() => setError(uiText('surfing.embed.custom.failed')))
          }}>
            {configuration.customized.includes(provider.id) ? api.files.revealLabel() : uiText('surfing.embed.customize')}</Button>
        </Row>
      ))}
      <Row title={uiText('surfing.embed.custom.title')} description={uiText('surfing.embed.custom.description')}>
        <Button
          variant="secondary"
          onClick={() => {
            setError('')
            void createCustomEmbedProvider().then((provider) => {
              refresh()
              api.files.revealInFinder(embedProviderPath(provider))
            }).catch(() => setError(uiText('surfing.embed.custom.failed')))
          }}
        >
          {uiText('surfing.embed.custom.add')}</Button>
      </Row>
      {(configuration.issues.length > 0 || error) && (
        <div className="web-embed-errors" role="status">
          {error && <div>{error}</div>}
          {configuration.issues.map((issue) => <div key={`${issue.path}:${issue.message}`}>{uiText('surfing.embed.invalid', { p0: issue.path })}</div>)}
        </div>
      )}
    </Section>
  )
}

/** `surfing.settings` — rendered once per manifest `settingsSections` id. */
export const Settings: FC<{ section?: string }> = ({ section }) => {
  const { snap } = useWeb()
  if (section === 'profiles') return <>{snap.profileError && <div role="alert">{snap.profileError} <Button variant="secondary" onClick={() => { void getStore()?.loadConfig() }}>{uiText('surfing.profile.reload')}</Button></div>}<ProfilesSection /></>
  if (section === 'embeds') return <EmbedsSection />
  return <WebSection />
}
