import { z } from 'zod'
import type { DatasetKey, DatasetRecord, DatasetWhere, PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import { canDeleteProfile, canHideProfile, INCOGNITO_PROFILE_ID, newProfileId, normalizeProfile, normalizeProfileAdblock, normalizeSavedPage, profileSettingsPatchSchema, reconcileProfiles, type WebProfile } from '../profiles'

type Owner = Pick<PluginBackendOperationContext['api'], 'data' | 'rpc'>
const revision = z.number().int().nonnegative()
const id = z.string().min(1).max(256)
const page = z.object({ url: z.string().min(1).max(8192), title: z.string().max(8192), ts: z.number().nonnegative() }).strict()
const profile = z.object({ id, name: z.string().min(1).max(500), createdAt: z.number().nonnegative(), private: z.boolean().optional(), icon: z.string().max(128).optional(), hidden: z.boolean().optional(), adblockEnabled: z.boolean(), adblockRules: z.string().max(65536), adblockFrequency: z.number().int().min(0).max(3650) }).strict()
const expected = z.object({ profiles: revision, adblock: revision }).strict()
export const dataSchemas = {
  'profiles.list': z.object({}).strict(),
  'profiles.set': z.object({ profiles: z.array(profile).min(2).max(1000), expected }).strict(),
  'profiles.create': z.object({ name: z.string().trim().min(1).max(500), expected }).strict(),
  'profiles.patch': z.object({ id, patch: profileSettingsPatchSchema, expected }).strict(),
  'profiles.delete': z.object({ id, expected }).strict(),
  'saved.list': z.object({ profileId: id, kind: z.enum(['favorite', 'reading']) }).strict(),
  'saved.set': z.object({ profileId: id, kind: z.enum(['favorite', 'reading']), pages: z.array(page).max(10000), expectedRevision: revision }).strict(),
  'history.list': z.object({ profileId: id }).strict(),
  'history.clear': z.object({ profileId: id, expectedRevision: revision }).strict(),
  'history.append': z.object({ profileId: id, page, id }).strict()
}
export const dataOutputSchemas = {
  profiles: z.object({ profiles: z.array(profile), revisions: expected, browserCleanupDeferred: z.array(id) }).strict(),
  pages: z.object({ pages: z.array(page), revision }).strict(),
  appended: z.object({ recorded: z.boolean() }).strict()
}
function keyFor(row: DatasetRecord, fields: string[]): DatasetKey { return Object.fromEntries(fields.map(field => { const value = row[field]; if (typeof value !== 'string') throw new Error('Invalid stored record identity'); return [field, value] })) }
function conflict(message = 'Stored data changed; reload before saving'): never { throw Object.assign(new Error(message), { code: 'REVISION_CONFLICT', outcome: 'not-applied' }) }
export function createDataOwner(api: Owner, guard: () => void = () => {}) {
  const rows = async (dataset: string, where?: DatasetWhere) => {
    const records: DatasetRecord[] = []
    let cursor: string | undefined, observed: number | undefined
    do {
      guard()
      const result = await api.data.dataset(dataset).query({ where, limit: 1000, cursor })
      if (!Number.isSafeInteger(result.revision) || observed !== undefined && observed !== result.revision) conflict()
      observed = result.revision; records.push(...result.rows); cursor = result.cursor
    } while (cursor)
    guard()
    return { rows: records, revision: observed! }
  }
  const snapshot = async () => {
    const [profiles, adblock] = await Promise.all([rows('profiles'), rows('profile_adblock')])
    const byId = new Map(adblock.rows.map(row => [row.profileId, row]))
    const values = reconcileProfiles(profiles.rows.map(normalizeProfile).filter((value): value is WebProfile => value !== null)).map(value => ({ ...value, ...normalizeProfileAdblock(byId.get(value.id) ?? {}) }))
    return { profiles: values, revisions: { profiles: profiles.revision, adblock: adblock.revision }, browserCleanupDeferred: [] as string[], records: { profiles, adblock } }
  }
  const list = async () => { const { records: _, ...result } = await snapshot(); return result }
  const replace = async (raw: unknown) => {
    const input = dataSchemas['profiles.set'].parse(raw), current = await snapshot()
    if (current.revisions.profiles !== input.expected.profiles || current.revisions.adblock !== input.expected.adblock) conflict()
    if (new Set(input.profiles.map(value => value.id)).size !== input.profiles.length || input.profiles.filter(value => value.private).length !== 1 || !input.profiles.some(value => value.id === INCOGNITO_PROFILE_ID && value.private) || !input.profiles.some(value => !value.private && !value.hidden)) throw new Error('Profiles must retain one private profile and at least one visible normal profile')
    const oldPrivate = current.profiles.find(value => value.private)!, nextPrivate = input.profiles.find(value => value.private)!
    if (['id', 'name', 'createdAt', 'icon', 'hidden'].some(key => JSON.stringify(oldPrivate[key as keyof WebProfile]) !== JSON.stringify(nextPrivate[key as keyof WebProfile]))) throw new Error('Private profile identity cannot change')
    const removed = current.profiles.filter(value => !input.profiles.some(next => next.id === value.id)).map(value => value.id)
    if (removed.some(value => !canDeleteProfile(current.profiles, value))) throw new Error('The private or last normal profile cannot be removed')
    const normal = input.profiles.filter(value => !value.private).map(({ id, name, createdAt, icon, hidden }) => ({ id, name, createdAt, icon: icon ?? null, hidden: hidden ?? null }))
    const blocker = input.profiles.map(({ id: profileId, adblockEnabled, adblockRules, adblockFrequency }) => ({ profileId, adblockEnabled, adblockRules, adblockFrequency }))
    const entries: Array<{ dataset: string; key: string[]; next: DatasetRecord[]; previous: { rows: DatasetRecord[]; revision: number } }> = [{ dataset: 'profiles', key: ['id'], next: normal, previous: current.records.profiles }, { dataset: 'profile_adblock', key: ['profileId'], next: blocker, previous: current.records.adblock }]
    for (const dataset of removed.length ? ['visits', 'saved_pages'] : []) {
      const previous = await rows(dataset)
      entries.push({ dataset, key: dataset === 'visits' ? ['id'] : ['profileId', 'kind', 'url'], next: previous.rows.filter(row => !removed.includes(String(row.profileId))), previous })
    }
    if (entries.every(entry => JSON.stringify(entry.previous.rows) === JSON.stringify(entry.next))) return { profiles: input.profiles, revisions: current.revisions, browserCleanupDeferred: [] }
    guard()
    const result = await api.data.transaction(entries.flatMap(entry => [
      ...entry.previous.rows.length ? [{ dataset: entry.dataset, operation: 'delete-many' as const, keys: entry.previous.rows.map(row => keyFor(row, entry.key)) }] : [],
      { dataset: entry.dataset, operation: 'upsert' as const, values: entry.next }
    ]), { expected: entries.map(entry => ({ dataset: entry.dataset, revision: entry.previous.revision })) })
    api.rpc.emit('data.changed', { domains: ['profiles', ...(removed.length ? ['saved', 'history'] : [])] })
    return { profiles: input.profiles, revisions: { profiles: result.revision, adblock: result.revision }, browserCleanupDeferred: removed }
  }
  const profileFor = async (profileId: string) => {
    const current = await snapshot(), selected = current.profiles.find(value => value.id === profileId)
    if (!selected) throw new Error('Browser profile is unavailable')
    return { current, selected }
  }
  const pageList = async (dataset: 'saved_pages' | 'visits', input: { profileId: string; kind?: string }) => {
    const { selected } = await profileFor(input.profileId)
    const result = await rows(dataset, { profileId: input.profileId, ...(input.kind ? { kind: input.kind } : {}) })
    const ordered = result.rows.sort((a, b) => dataset === 'visits' ? Number(b.ts) - Number(a.ts) : Number(a.position) - Number(b.position))
    return { pages: selected.private ? [] : ordered.map(normalizeSavedPage).filter((value): value is z.infer<typeof page> => value !== null), revision: result.revision }
  }
  const replacePages = async (dataset: 'saved_pages' | 'visits', input: { profileId: string; kind?: string; pages: z.infer<typeof page>[]; expectedRevision: number }) => {
    const { current, selected } = await profileFor(input.profileId)
    if (selected.private) throw new Error('Private profile data is session-only')
    if (new Set(input.pages.map(value => value.url)).size !== input.pages.length) throw new Error('Saved page URLs must be unique')
    const existing = await rows(dataset, { profileId: input.profileId, ...(input.kind ? { kind: input.kind } : {}) })
    if (existing.revision !== input.expectedRevision) conflict()
    const keys = existing.rows.map(row => keyFor(row, dataset === 'visits' ? ['id'] : ['profileId', 'kind', 'url']))
    guard()
    const result = await api.data.transaction([
      ...(keys.length ? [{ dataset, operation: 'delete-many' as const, keys }] : []),
      { dataset, operation: 'upsert', values: input.pages.map((value, position) => ({ ...value, profileId: input.profileId, kind: input.kind!, position })) }
    ], { expected: [{ dataset, revision: input.expectedRevision }, { dataset: 'profiles', revision: current.revisions.profiles }] })
    api.rpc.emit('data.changed', { domains: [dataset === 'visits' ? 'history' : 'saved'], profileId: input.profileId })
    return { pages: input.pages, revision: result.revision }
  }
  return {
    'profiles.list': async (raw: unknown) => { dataSchemas['profiles.list'].parse(raw); return list() },
    'profiles.set': replace,
    'profiles.create': async (raw: unknown) => { const input = dataSchemas['profiles.create'].parse(raw), current = await list(); return replace({ expected: input.expected, profiles: [...current.profiles, { id: newProfileId(), name: input.name, createdAt: Date.now(), ...normalizeProfileAdblock({}) }] }) },
    'profiles.patch': async (raw: unknown) => {
      const input = dataSchemas['profiles.patch'].parse(raw), { current, selected } = await profileFor(input.id)
      if (selected.private && ['name', 'icon', 'hidden'].some(key => Object.hasOwn(input.patch, key))) throw new Error('Private profile identity cannot change')
      if (input.patch.hidden && !canHideProfile(current.profiles, input.id)) throw new Error('The last visible profile cannot be hidden')
      return replace({ expected: input.expected, profiles: current.profiles.map(value => value.id === input.id ? { ...value, ...input.patch } : value) })
    },
    'profiles.delete': async (raw: unknown) => { const input = dataSchemas['profiles.delete'].parse(raw), current = await list(); if (!canDeleteProfile(current.profiles, input.id)) throw new Error('Profile cannot be deleted'); return replace({ expected: input.expected, profiles: current.profiles.filter(value => value.id !== input.id) }) },
    'saved.list': (raw: unknown) => pageList('saved_pages', dataSchemas['saved.list'].parse(raw)),
    'saved.set': (raw: unknown) => replacePages('saved_pages', dataSchemas['saved.set'].parse(raw)),
    'history.list': (raw: unknown) => pageList('visits', dataSchemas['history.list'].parse(raw)),
    'history.clear': (raw: unknown) => replacePages('visits', { ...dataSchemas['history.clear'].parse(raw), pages: [] }),
    'history.append': async (raw: unknown) => {
      const input = dataSchemas['history.append'].parse(raw), { current, selected } = await profileFor(input.profileId)
      if (selected.private) return { recorded: false }
      if (!/^https?:/i.test(input.page.url)) throw new Error('History accepts HTTP(S) URLs only')
      guard()
      await api.data.transaction([{ dataset: 'visits', operation: 'insert', values: [{ ...input.page, id: input.id, profileId: input.profileId }] }], { expected: [{ dataset: 'profiles', revision: current.revisions.profiles }] })
      return { recorded: true }
    }
  }
}
export type ProfilesSnapshot = z.infer<typeof dataOutputSchemas.profiles>
export type PagesSnapshot = z.infer<typeof dataOutputSchemas.pages>
export function registerDataOwner(api: PluginBackendApi): () => void {
  const ui = createDataOwner(api)
  const disposers = Object.keys(dataSchemas).flatMap(method => [
    api.rpc.handle(`data.${method}`, input => ui[method as keyof typeof ui](input)),
    api.rpc.handleOperation(`command.${method}`, (input, context) => createDataOwner(context.api, () => context.cancellation.throwIfAborted())[method as keyof typeof ui](input))
  ])
  return () => disposers.forEach(dispose => dispose())
}
