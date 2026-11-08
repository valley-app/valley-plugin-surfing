import { METADATA_PANEL_SEGMENT_V1, provideBookmarkSurface, type PluginCommand, type PluginInspectionSubject, type PluginProperty, type ValleyPluginApi } from '@valley/plugin-sdk'
import { z } from 'zod'
import { surfingCommandResult } from './commandResults'
import { api, React } from './runtime'
import type { WebStore } from './store'
import { canDeleteProfile, canHideProfile, INCOGNITO_PROFILE_ID, profileSettingsPatchSchema } from './profiles'
import { EyeglassesIcon } from './icons'
import { loadEmbedProviders, customizeEmbedProvider, createCustomEmbedProviderSaved, embedProviderFilesRevert, embedProviderPath, type SavedEmbedProvider } from './embedProviders'
import { uiText } from './localization'
import type { InteropValueSchema } from '@valley/plugin-sdk'
import { readSurfingFileBookmark, subscribeSurfingFileBookmarks, updateSurfingFileBookmark, type SurfingFileBookmarkState } from './workspaceDetails'

const bookmarkStateSchema = {
  "type": "object",
  "properties": {
    "profileId": {
      "type": "string"
    },
    "url": {
      "type": "string"
    },
    "title": {
      "type": "string"
    }
  },
  "required": [
    "profileId"
  ],
  "additionalProperties": false
} satisfies InteropValueSchema



const refused = (code: string, message: string) => Object.assign(new Error(message), { code, outcome: 'not-applied', retryable: false })
type CommandContext = Parameters<PluginCommand<unknown, unknown, 'write'>['run']>[1]
type Revert = { label: string; run(ctx: CommandContext): Promise<void>; reapply?(ctx: CommandContext): Promise<void> }
const object =(raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(uiText('surfing.error.input'))
  return raw as Record<string, unknown>
}
const required = (value: unknown, key: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(uiText('surfing.error.required', { value: key }))
  return value.trim()
}
const safeUrl = (raw: unknown): string => {
  const value = required(raw, 'url')
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error(uiText('surfing.error.url'))
  return url.href
}
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const string = { type: 'string', minLength: 1 }

function profileFor(store: WebStore, id: string) {
  const profile = store.getSnapshot().profiles.find((item) => item.id === id)
  if (!profile) throw refused('TARGET_NOT_FOUND', uiText('surfing.error.profile'))
  return profile
}

async function profileRevision(store: WebStore, profileId: string): Promise<string> {
  const before = JSON.stringify(profileFor(store, profileId))
  const bytes = new TextEncoder().encode(before)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  if (JSON.stringify(profileFor(store, profileId)) !== before) throw refused('REVISION_CONFLICT', uiText('surfing.error.profileChanged'))
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function inspectProfile(store: WebStore, subject?: PluginInspectionSubject): PluginProperty[] {
  const profileId = String(subject?.item?.state.profileId ?? subject?.view.profileId ?? store.getSnapshot().activeProfileId)
  const profile = profileFor(store, profileId)
  return [
    { id: 'profileId', label: uiText('surfing.surface.profile'), value: profile.id, readOnly: true },
    { id: 'private', label: uiText('surfing.surface.private'), value: profile.private === true, readOnly: true },
    { id: 'hidden', label: uiText('surfing.surface.hidden'), value: String(profile.hidden === true), readOnly: true }
  ]
}

function websiteTarget(store: WebStore, subject?: PluginInspectionSubject) {
  const directId = subject?.instanceId ?? '__single'
  const direct = store.getTab(directId)
  if (direct) return { id: directId, tab: direct }
  const url = subject?.item?.state.url
  const profileId = subject?.item?.state.profileId ?? subject?.view.profileId
  const match = Object.entries(store.getSnapshot().tabs).find(([, tab]) =>
    (typeof url !== 'string' || tab.url === url) && (typeof profileId !== 'string' || tab.profileId === profileId)
  )
  return match ? { id: match[0], tab: match[1] } : null
}

function inspectWebsite(store: WebStore, subject?: PluginInspectionSubject): PluginProperty[] {
  const tab = websiteTarget(store, subject)?.tab
  if (!tab) throw new Error(uiText('surfing.error.closedTab'))
  const metadata = tab.metadata ?? {}
  const security = uiText(`details.connection.${tab.connection?.status ?? 'unavailable'}`)
  return [
    { id: 'title', label: uiText('surfing.surface.title'), value: tab.title, readOnly: true },
    { id: 'url', label: uiText('surfing.surface.url'), value: tab.url, readOnly: true },
    { id: 'security', label: uiText('surfing.surface.security'), value: security, readOnly: true },
    ...(metadata.icon ? [
      { id: 'icon', label: uiText('surfing.surface.icon'), value: metadata.icon, readOnly: true },
      { id: 'iconUrl', label: uiText('surfing.surface.websiteIcon'), value: metadata.icon, readOnly: true }
    ] : []),
    ...(metadata.language ? [{ id: 'language', label: uiText('surfing.surface.language'), value: metadata.language, readOnly: true }] : [])
  ]
}

function Properties({ store, subject, kind }: { store: WebStore; subject?: PluginInspectionSubject; kind: 'profile' | 'website' }): React.ReactElement {
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [fields, setFields] = React.useState<PluginProperty[]>([])
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    try { setFields(kind === 'profile' ? inspectProfile(store, subject) : inspectWebsite(store, subject)); setError('') } catch { setFields([]); setError(uiText('surfing.surface.missing')) }
  }, [snapshot, store, subject, kind])
  const readOnlyValue = (field: PluginProperty): React.ReactNode => {
    const value = String(field.value ?? '')
    if (kind === 'website' && field.id === 'icon') return <span className="web-metadata-icon"><img src={value} alt="" referrerPolicy="no-referrer" /></span>
    if (typeof field.value === 'boolean') return api.ui.t(field.value ? 'common.yes' : 'common.no')
    return value
  }
  return <div className="right-panel-body props-info">{error && <p role="alert">{error}</p>}<dl className="props-info-table">{fields.map((field) => <div className="props-info-row" key={field.id}>
    <dt className="props-info-key">{field.label}</dt><dd className="props-info-value">
    {readOnlyValue(field)}
    </dd>
  </div>)}</dl></div>
}

export function registerSurfingSurfaces(pluginApi: ValleyPluginApi, store: WebStore, ready: Promise<void>): () => void {
  const root = pluginApi.getState().realm?.path
  let active = true, revoked = false
  const offRealm = pluginApi.subscribeState(['realm'], ({ state }) => { if (state.realm?.path !== root) revoked = true })
  const current = () => active && !revoked && pluginApi.getState().realm?.path === root
  // An undo/redo after a realm switch or unload would reach another realm's owner; refuse it before any effect.
  const scoped = (revert: Revert): Revert => {
    const check = () => { if (!current()) throw refused('OWNER_CHANGED', uiText('surfing.error.realmChanged')) }
    const reapply = revert.reapply
    return { ...revert, run: async ctx => { check(); await revert.run(ctx) }, ...(reapply ? { reapply: async (ctx: CommandContext) => { check(); await reapply(ctx) } } : {}) }
  }
  const register = <I, O, E extends 'read' | 'write'>(command: PluginCommand<I, O, E>): (() => void) => pluginApi.commands.register<I, O, E>({
    ...command, outputSchema: surfingCommandResult(command.id),
    limits: { requestBytes: 1048576, responseBytes: 16777216 },
    recovery: command.sideEffect === 'read' ? 'observational' : 'non-replayable',
    run: async (input: I, context) => {
      await ready.catch((cause: unknown) => { throw Object.assign(new Error(cause instanceof Error ? cause.message : String(cause), { cause }), { code: 'ACTION_UNAVAILABLE', outcome: 'not-applied', retryable: false }) })
      if (!current()) throw refused('OWNER_CHANGED', uiText('surfing.error.profile'))
      context.cancellation?.throwIfAborted()
      const result = await command.run(input, context)
      if (command.sideEffect !== 'write') return result
      const written = result as unknown as { revert: Revert | Revert[] | null }
      if (!written.revert) return result
      return { ...written, revert: Array.isArray(written.revert) ? written.revert.map(scoped) : scoped(written.revert) } as unknown as typeof result
    }
  } as typeof command & { outputSchema: Record<string, unknown> })
  const fileSchema: InteropValueSchema = { type: 'object', properties: { path: { type: 'string' }, search: { type: 'string' }, page: { type: 'number' }, selected: { type: 'union', anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['path', 'search', 'page', 'selected'], additionalProperties: false }
  const filePath = (value: unknown): value is string => typeof value === 'string' && /\.(?:url|mht(?:ml)?|har)$/i.test(value)
  const surfaces = ['main_workspace', 'left_sidebar'] as const
  const offs = surfaces.map((surface) => provideBookmarkSurface(pluginApi, {
    id: `surfing.${surface}`, surface, subscribe: listener => { const offStore = store.subscribe(listener), offFiles = subscribeSurfingFileBookmarks(pluginApi, listener); return () => { offStore(); offFiles() } },
    getSnapshot: (instanceId) => {
      if (surface === 'main_workspace' && filePath(instanceId)) {
        const state = readSurfingFileBookmark(pluginApi, instanceId)
        const title = instanceId.split('/').pop()!
        const view = { ...state, selected: null }
        return { title, view, filePath: instanceId, ...(state.selected ? { item: { id: state.selected, title, state: { ...state } } } : {}) }
      }
      const snapshot = store.getSnapshot()
      const tab = surface === 'main_workspace' ? store.getTab(instanceId ?? '__single') : undefined
      const profile = profileFor(store, tab?.profileId ?? snapshot.activeProfileId)
      const view = { profileId: profile.id }
      const readingAction = tab?.url && !profile.private ? [{
        id: 'reading-list',
        label: uiText('surfing.readingList.add'),
        icon: <EyeglassesIcon />,
        onSelect: async () => {
          await store.ensureProfileLoaded(profile.id)
          await store.addToReadingList(profile.id, { url: tab.url, title: tab.title, ts: Date.now() })
        }
      }] : []
      return { title: profile.private ? profile.name : tab?.title || tab?.url || profile.name, view,
        ...(tab && tab.url && !profile.private ? { item: { id: JSON.stringify([profile.id, tab.url]), title: tab.title || tab.url, state: { ...view, url: tab.url, title: tab.title } } }
          : surface === 'left_sidebar' ? { item: { id: profile.id, title: profile.name, state: view } } : {}),
        ...(surface === 'main_workspace' ? { actions: readingAction } : {}),
        ...(tab ? { navigation: { canGoBack: store.canGoBack(instanceId ?? '__single'), canGoForward: store.canGoForward(instanceId ?? '__single'), goBack: () => store.goBack(instanceId ?? '__single'), goForward: () => store.goForward(instanceId ?? '__single') } } : {})
      }
    },
    restore: async (state, instanceId) => {
      await ready
      if (surface === 'main_workspace' && filePath(state.path)) {
        if (!await pluginApi.realm.fileInfo(state.path)) throw new Error(uiText('surfing.shortcut.readError'))
        updateSurfingFileBookmark(pluginApi, state.path, state as unknown as SurfingFileBookmarkState)
        await pluginApi.workspace.openFile(state.path)
        return
      }
      const profileId = required(state.profileId, 'profileId')
      const profile = profileFor(store, profileId)
      if (surface === 'left_sidebar') { store.setActiveProfile(profileId); return }
      store.restoreTab(instanceId ?? '__single', { url: state.url !== undefined && !profile.private ? safeUrl(state.url) : '', title: typeof state.title === 'string' && !profile.private ? state.title : '', profileId })
    }
  }, { stateSchema: { type: 'union', anyOf: [bookmarkStateSchema, fileSchema] }, itemStateSchema: { type: 'union', anyOf: [{ ...bookmarkStateSchema, required: surface === 'left_sidebar' ? bookmarkStateSchema.required : [...bookmarkStateSchema.required, 'url'] }, fileSchema] }, description: (snapshot, item) => typeof snapshot.view.path === 'string' && snapshot.view.path ? snapshot.view.path : uiText(item ? 'bookmark.item' : 'bookmark.view'), validate: state => { if (state.path !== undefined) return filePath(state.path) && Number.isSafeInteger(state.page) && Number(state.page) >= 0; required(state.profileId, 'profileId'); if (state.url !== undefined) safeUrl(state.url); return true } }))
  offs.push(pluginApi.interop.extensions.provide(METADATA_PANEL_SEGMENT_V1, { id: 'surfing.websiteProperties', label: 'Website metadata', labelKey: 'surfing.metadata.website', icon: 'globe', pluginSurfaces: ['main_workspace'], inspect: ({ subject }) => inspectWebsite(store, subject), render: ({ subject }) => <Properties store={store} subject={subject} kind="website" /> }))
  offs.push(pluginApi.interop.extensions.provide(METADATA_PANEL_SEGMENT_V1, { id: 'surfing.profileProperties', label: 'Profile metadata', labelKey: 'surfing.metadata.profile', icon: 'user', pluginSurfaces: ['main_workspace'], inspect: ({ subject }) => inspectProfile(store, subject), render: ({ subject }) => <Properties store={store} subject={subject} kind="profile" /> }))
  const profileInput = { schema: schema({ profileId: string }, ['profileId']), parse: (raw: unknown) => ({ profileId: required(object(raw).profileId, 'profileId') }) }
  offs.push(register({ id: 'list-profiles', label: 'Surfing: List browser profiles', labelKey: 'surfing.command.listProfiles', sideEffect: 'read', paletteSafe: false, run: async () => { await ready; return store.getSnapshot().profiles } }))
  const patchRequest = z.object({ profileId: z.string().min(1).max(256), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), patch: profileSettingsPatchSchema }).strict()
  offs.push(register({ id: 'read-profile-settings', label: 'Surfing: Read profile and ad-block settings', labelKey: 'surfing.command.readProfileSettings', sideEffect: 'read', paletteSafe: false, input: profileInput,
    run: async ({ profileId }) => { await ready; await store.flushProfiles(); return { profile: profileFor(store, profileId), revision: await profileRevision(store, profileId) } } }))
  offs.push(register({ id: 'patch-profile-settings', label: 'Surfing: Update profile and ad-block settings', labelKey: 'surfing.command.patchProfileSettings', sideEffect: 'write', paletteSafe: false,
    input: { schema: schema({ profileId: { type: 'string', minLength: 1, maxLength: 256 }, expectedRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' }, patch: { ...schema({ name: { type: 'string', minLength: 1, maxLength: 500 }, icon: { type: 'string', maxLength: 128 }, hidden: { type: 'boolean' }, adblockEnabled: { type: 'boolean' }, adblockRules: { type: 'string', maxLength: 65536 }, adblockFrequency: { type: 'integer', minimum: 0, maximum: 3650 } }), minProperties: 1 } }, ['profileId', 'expectedRevision', 'patch']), parse: raw => patchRequest.parse(raw) },
    preview: input => input, revision: ({ profileId }) => profileRevision(store, profileId),
    run: async ({ profileId, expectedRevision, patch }) => {
      await ready
      if (expectedRevision !== await profileRevision(store, profileId)) throw refused('REVISION_CONFLICT', uiText('surfing.error.profileChanged'))
      const profile = profileFor(store, profileId)
      if (profile.private && ['name', 'icon', 'hidden'].some(key => Object.hasOwn(patch, key))) throw refused('ACTION_UNAVAILABLE', uiText('surfing.error.incognito'))
      if (patch.hidden === true && !canHideProfile(store.getSnapshot().profiles, profileId)) throw refused('ACTION_UNAVAILABLE', uiText('surfing.error.lastProfile'))
      await store.patchProfileSettings(profileId, patch)
      return { value: { profile: profileFor(store, profileId), revision: await profileRevision(store, profileId) }, revert: null }
    } }))
  offs.push(register({ id: 'create-profile', label: 'Surfing: Create a browser profile', labelKey: 'surfing.command.createProfile', sideEffect: 'write', paletteSafe: false, input: { schema: schema({ name: string }, ['name']), parse: (raw) => ({ name: required(object(raw).name, 'name') }) }, preview: (input) => input, run: async ({ name }) => { await ready; const id = await store.createProfile(name); return { value: profileFor(store, id), revert: null } } }))
  offs.push(register({ id: 'delete-profile', label: 'Surfing: Delete a browser profile', labelKey: 'surfing.command.deleteProfile', sideEffect: 'write', paletteSafe: false, input: profileInput, preview: (input) => input, revision: ({ profileId }) => profileFor(store, profileId), run: async ({ profileId }) => {
    profileFor(store, profileId)
    if (profileId === INCOGNITO_PROFILE_ID) throw refused('ACTION_UNAVAILABLE', uiText('surfing.error.incognito'))
    if (!canDeleteProfile(store.getSnapshot().profiles, profileId)) throw refused('ACTION_UNAVAILABLE', uiText('surfing.error.lastProfile'))
    await store.deleteProfile(profileId); return { value: { profileId }, revert: null }
  } }))
  for (const operation of ['clear-history', 'clear-browser-data'] as const) offs.push(register({ id: operation, label: operation === 'clear-history' ? 'Surfing: Clear browser history' : 'Surfing: Clear browser data', labelKey: `surfing.command.${operation}`, sideEffect: 'write', paletteSafe: false, input: profileInput, preview: (input) => input, run: async ({ profileId }) => { profileFor(store, profileId); if (operation === 'clear-history') await store.clearHistory(profileId); else await store.clearBrowserData(profileId); return { value: { profileId }, revert: null } } }))
  offs.push(register({ id: 'read-history', label: 'Surfing: Read browser history', labelKey: 'surfing.command.readHistory', sideEffect: 'read', paletteSafe: false, input: profileInput, run: async ({ profileId }) => { profileFor(store, profileId); return store.readHistory(profileId) } }))
  const pageInput = { schema: schema({ profileId: string, kind: { type: 'string', enum: ['favorite', 'reading'] }, url: string, title: { type: 'string' } }, ['profileId', 'kind', 'url']), parse: (raw: unknown) => {
    const value = object(raw); if (!['favorite', 'reading'].includes(String(value.kind))) throw new Error(uiText('surfing.error.invalid', { value: 'kind' }))
    return { profileId: required(value.profileId, 'profileId'), kind: value.kind as 'favorite' | 'reading', url: safeUrl(value.url), title: typeof value.title === 'string' ? value.title : '' }
  } }
  for (const operation of ['save-page', 'remove-page'] as const) offs.push(register({ id: operation, label: operation === 'save-page' ? 'Surfing: Save a page' : 'Surfing: Remove a saved page', labelKey: `surfing.command.${operation}`, sideEffect: 'write', paletteSafe: false, input: pageInput, preview: (input) => input, run: async ({ profileId, kind, url, title }) => {
    profileFor(store, profileId); await store.ensureProfileLoaded(profileId)
    if (kind === 'favorite') {
      if (operation === 'remove-page') await store.removeFavorite(profileId, url)
      else if (!store.isFavorite(profileId, url)) await store.toggleFavorite(profileId, { url, title, ts: Date.now() })
    } else if (operation === 'remove-page') await store.removeFromReadingList(profileId, url)
    else await store.addToReadingList(profileId, { url, title, ts: Date.now() })
    return { value: { profileId, kind, url }, revert: null }
  } }))
  offs.push(register({ id: 'list-saved-pages', label: 'Surfing: List saved pages', labelKey: 'surfing.command.listSavedPages', sideEffect: 'read', paletteSafe: false, input: { schema: schema({ profileId: string, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } }, ['profileId']), parse: (raw) => {
    const value = object(raw)
    const limit = value.limit ?? 100
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 1000) throw new Error(uiText('surfing.error.invalid', { value: 'limit (1–1000)' }))
    if (value.cursor !== undefined && typeof value.cursor !== 'string') throw new Error(uiText('surfing.error.invalid', { value: 'cursor' }))
    return { profileId: required(value.profileId, 'profileId'), cursor: value.cursor as string | undefined, limit: Number(limit) }
  } }, run: async ({ profileId, cursor, limit }) => { await ready; profileFor(store, profileId); return pluginApi.data.dataset('surfing.saved_pages').query({ where: { profileId }, cursor, limit }) } }))
  offs.push(register({ id: 'list-embed-providers', label: 'Surfing: List embed providers', labelKey: 'surfing.command.listEmbedProviders', sideEffect: 'read', paletteSafe: false,
    run: () => loadEmbedProviders(false) }))
  offs.push(register({ id: 'create-embed-provider', label: 'Surfing: Create an embed provider', labelKey: 'surfing.command.createEmbedProvider', sideEffect: 'write', paletteSafe: false,
    run: async () => { const saved = await createCustomEmbedProviderSaved(), provider = saved.provider; return { value: { provider, path: embedProviderPath(provider) }, revert: saved.restorable ? embedProviderFilesRevert(`Create ${provider.displayName}`, saved, expected => api.backend.call<SavedEmbedProvider>('providers.set', { provider, expected })) : null } } }))
  offs.push(register({ id: 'customize-embed-provider', label: 'Surfing: Customize an embed provider', labelKey: 'surfing.command.customizeEmbedProvider', sideEffect: 'write', paletteSafe: false,
    input: { schema: schema({ id: { type: 'string', minLength: 1, maxLength: 128 } }, ['id']), parse: raw => ({ id: required(object(raw).id, 'id') }) },
    preview: input => input, run: async ({ id }) => { const configuration = await loadEmbedProviders(false); const provider = configuration.providers.find(value => value.id === id); if (!provider) throw refused('TARGET_NOT_FOUND', uiText('surfing.embed.providerMissing')); const saved = await customizeEmbedProvider(provider); return { value: { provider, path: embedProviderPath(provider) }, revert: saved.restorable ? embedProviderFilesRevert(`Customize ${provider.displayName}`, saved, expected => api.backend.call<SavedEmbedProvider>('providers.customize', { id: provider.id, expected })) : null } } }))
  return () => { active = false; offRealm(); offs.forEach((off) => off()) }
}
