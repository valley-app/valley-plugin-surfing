import { z } from 'zod'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import { BUILT_IN_PROVIDERS, embedRendererForProvider, embedRendererModuleSource } from '../embeds/registry'
import { EMBEDS_REL_DIR, PROVIDER_FILENAME, RENDERER_FILENAME, providerPath, providerRelPath, rendererRelPath, safeDirectory, parseJson, validateProvider, type EmbedProviderConfiguration, type EmbedProviderIssue } from '../embedProviderData'
import type { EmbedProvider } from '../embeds/types'

type Owner = Pick<PluginBackendOperationContext['api'], 'data' | 'storage' | 'rpc'>
const revision = z.number().int().nonnegative()
const revisions = z.object({ provider: revision, renderer: revision }).strict()
const expectedSchema = revisions.extend({ catalog: revision }).strict()
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
export const providerSchema = z.object({ schemaVersion: z.literal(1), id: identifier, displayName: z.string().min(1).max(500), language: identifier, template: z.string().max(8192), kind: z.enum(['youtube', 'x', 'generic']), valueParser: z.enum(['youtube-video-id', 'x-post-id', 'identity']), presentation: z.object({ initialHeight: z.number().min(1).max(2000), autoSize: z.boolean(), fullWidth: z.boolean(), minHeight: z.number().min(1).max(2000).optional(), maxHeight: z.number().min(1).max(2000).optional(), aspectRatio: z.string().max(128).optional(), httpReferrer: z.string().max(8192).optional(), fitWidth: z.object({ naturalWidth: z.number().min(1).max(2000), maxScale: z.number().min(1).max(4) }).strict().optional() }).strict(), theme: z.object({ queryParameter: identifier, values: z.object({ light: z.string(), dark: z.string() }).strict() }).strict().optional(), order: z.number(), directory: identifier }).strict()
export const providerSchemas = {
  'providers.list': z.object({}).strict(),
  'providers.create': z.object({}).strict(),
  'providers.customize': z.object({ id: identifier, expected: expectedSchema }).strict(),
  'providers.set': z.object({ provider: providerSchema, expected: expectedSchema }).strict(),
  'providers.delete': z.object({ id: identifier, expected: expectedSchema }).strict()
}
export const providerOutputs = {
  list: z.object({ providers: z.array(providerSchema), customized: z.array(z.string()), issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()), revisions: z.record(revisions), catalogRevision: revision }).strict(),
  saved: z.object({ provider: providerSchema, revisions, catalogRevision: revision, restorable: z.boolean() }).strict(),
  deleted: z.object({ id: identifier, directory: identifier, revisions, catalogRevision: revision }).strict()
}
const CATALOG_PATH = `${EMBEDS_REL_DIR}/catalog.json`
function refused(code: string, message: string): never { throw Object.assign(new Error(message), { code, outcome: 'not-applied', retryable: false }) }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const sha256 = async (value: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
// The catalog holds one change token per owned provider directory, so removing a directory's entry restores the catalog bytes it had before that directory was created.
function catalogProviders(content: string): Record<string, unknown> {
  try { const value = JSON.parse(content) as unknown; return record(value) && record(value.providers) ? value.providers : {} } catch { return {} }
}
function catalogEntry(content: string, directory: string): string | undefined {
  const value = catalogProviders(content)[directory]
  return typeof value === 'string' ? value : undefined
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
function sameJson(content: string, value: unknown): boolean {
  try { return JSON.stringify(canonical(JSON.parse(content))) === JSON.stringify(canonical(value)) } catch { return false }
}
function catalogWith(content: string, directory: string, token: string | null): string | null {
  let parsed: unknown = {}
  try { parsed = content ? JSON.parse(content) : {} } catch { parsed = {} }
  const { providers, ...rest } = record(parsed) ? parsed : {}, entries: Record<string, unknown> = { ...(record(providers) ? providers : {}) }
  if (token === null) delete entries[directory]; else entries[directory] = token
  const next = Object.keys(entries).length ? { ...rest, providers: entries } : rest
  return Object.keys(next).length ? JSON.stringify(next) : null
}
export function createProviderOwner(api: Owner, guard: () => void = () => {}) {
  const scope = async <T>(mode: 'read' | 'write', work: (handle: string) => Promise<T>): Promise<T> => {
    guard()
    const grant = await api.storage.open({ area: 'metadata', path: 'plugins/data/surfing', kind: 'directory', mode })
    try { return await work(grant.handle) } finally { await api.storage.close(grant.handle) }
  }
  const documents = (directory: string) => scope('read', async handle => {
    const [provider, renderer] = await Promise.all([providerRelPath(directory), rendererRelPath(directory)].map(path => api.storage.readDocument({ handle, path })))
    guard()
    return { provider, renderer }
  })
  const read = async () => {
    const catalog = await scope('read', handle => api.storage.readDocument({ handle, path: CATALOG_PATH }))
    const entries = await api.data.files.list(EMBEDS_REL_DIR), providers = [...BUILT_IN_PROVIDERS], customized: string[] = [], issues: EmbedProviderIssue[] = [], observed: EmbedProviderConfiguration['revisions'] = {}
    const directories = [...new Set([...providers.map(provider => provider.directory), ...entries.filter(entry => entry.isDirectory && safeDirectory(entry.name)).map(entry => entry.name)])]
    const contents: Record<string, { provider: string; renderer: string }> = {}
    for (const directory of directories) {
      const docs = await documents(directory)
      observed[directory] = { provider: docs.provider.revision, renderer: docs.renderer.revision }
      contents[directory] = { provider: docs.provider.content, renderer: docs.renderer.content }
      if (!docs.provider.content.trim()) continue
      const path = providerPath(directory), provider = validateProvider(parseJson(docs.provider.content, path, issues), directory, issues)
      if (!provider) continue
      if (providers.some(value => value.id.toLowerCase() !== provider.id.toLowerCase() && value.language.toLowerCase() === provider.language.toLowerCase())) { issues.push({ path, message: 'Provider language must be unique' }); continue }
      const index = providers.findIndex(value => value.id.toLowerCase() === provider.id.toLowerCase())
      if (index >= 0) providers[index] = provider; else providers.push(provider)
      customized.push(provider.id)
    }
    const configuration: EmbedProviderConfiguration = { providers: providers.sort((a, b) => a.order - b.order || a.displayName.localeCompare(b.displayName)), customized, issues, revisions: observed, catalogRevision: catalog.revision }
    return { configuration, catalog: catalog.content, catalogExists: entries.some(entry => !entry.isDirectory && entry.name === 'catalog.json'), contents }
  }
  const list = async (): Promise<EmbedProviderConfiguration> => (await read()).configuration
  const commit = (entries: Array<{ path: string; content: string | null; expectedRevision: number }>, after: (handle: string) => Promise<void> = async () => {}) => scope('write', async handle => {
    let result: { revisions: number[] }
    try { result = await api.storage.writeDocuments(entries.map(entry => ({ location: { handle, path: entry.path }, content: entry.content, expectedRevision: entry.expectedRevision }))) }
    catch (error) {
      // Storage checks every expected revision before its transactional write, so a conflict is a known no-effect refusal.
      if (record(error) && error.code === 'REVISION_CONFLICT') throw Object.assign(error, { outcome: 'not-applied', retryable: false })
      throw error
    }
    await after(handle)
    return result
  })
  const save = async (provider: EmbedProvider, expected: z.infer<typeof expectedSchema>, customize: boolean) => {
    const issues: EmbedProviderIssue[] = [], checked = validateProvider(provider, provider.directory, issues)
    if (!checked) refused('INVALID_INPUT', issues.map(issue => issue.message).join('; '))
    const { configuration: snapshot, catalog, catalogExists } = await read()
    if (snapshot.providers.some(value => value.id !== checked.id && value.language.toLowerCase() === checked.language.toLowerCase())) refused('INVALID_INPUT', 'Provider language must be unique')
    if (snapshot.catalogRevision !== expected.catalog) refused('REVISION_CONFLICT', 'Embed providers changed; reload before saving')
    const current = await documents(checked.directory)
    // Storage reads a missing document as '', so only a listing tells an absent file from an existing empty one.
    const present = new Set((await api.data.files.list(`${EMBEDS_REL_DIR}/${checked.directory}`)).filter(entry => !entry.isDirectory).map(entry => entry.name))
    guard()
    const { directory: _, ...value } = checked
    const source = current.renderer.content || embedRendererModuleSource(embedRendererForProvider(checked))
    // A definition equal to the stored one keeps the stored bytes, so setting a hand-formatted provider back to itself writes nothing.
    const contents = [current.provider.content && (customize || sameJson(current.provider.content, value)) ? current.provider.content : `${JSON.stringify(value, null, 2)}\n`, source]
    const changed = contents[0] !== current.provider.content || contents[1] !== current.renderer.content
    const nextCatalog = changed ? catalogWith(catalog, checked.directory, await sha256(`${catalogEntry(catalog, checked.directory) ?? ''}\n${contents[0]}\n${contents[1]}`)) : catalogExists ? catalog : null
    // Deleting this provider at the returned revisions restores the exact prior bytes only when neither file existed, even empty, and dropping its catalog entry rebuilds the prior catalog (or its absence) byte for byte.
    const restorable = changed && !present.has(PROVIDER_FILENAME) && !present.has(RENDERER_FILENAME) && nextCatalog !== null && catalogWith(nextCatalog, checked.directory, null) === (catalogExists ? catalog : null)
    guard()
    const result = await commit([
      { path: providerRelPath(checked.directory), content: contents[0], expectedRevision: expected.provider },
      { path: rendererRelPath(checked.directory), content: contents[1], expectedRevision: expected.renderer },
      { path: CATALOG_PATH, content: nextCatalog, expectedRevision: expected.catalog }
    ])
    api.rpc.emit('providers.changed', { id: checked.id })
    return { provider: checked, revisions: { provider: result.revisions[0], renderer: result.revisions[1] }, catalogRevision: result.revisions[2], restorable }
  }
  const remove = async (input: z.infer<typeof providerSchemas['providers.delete']>) => {
    const { configuration: snapshot, catalog, contents } = await read()
    if (snapshot.catalogRevision !== input.expected.catalog) refused('REVISION_CONFLICT', 'Embed providers changed; reload before deleting')
    const provider = snapshot.providers.find(value => value.id === input.id && snapshot.customized.includes(value.id))
    const directory = provider?.directory ?? (contents[input.id]?.provider || contents[input.id]?.renderer ? input.id : undefined)
    if (!directory) refused('TARGET_NOT_FOUND', 'Embed provider has no editable files')
    const observed = snapshot.revisions[directory]
    if (observed.provider !== input.expected.provider || observed.renderer !== input.expected.renderer) refused('REVISION_CONFLICT', 'Embed provider files changed; reload before deleting')
    const nextCatalog = catalogWith(catalog, directory, null)
    guard()
    const folder = `${EMBEDS_REL_DIR}/${directory}`, empty = async (handle: string, path: string) => (await api.storage.list({ handle, path }).catch(() => null))?.length === 0
    const result = await commit([
      { path: providerRelPath(directory), content: null, expectedRevision: input.expected.provider },
      { path: rendererRelPath(directory), content: null, expectedRevision: input.expected.renderer },
      { path: CATALOG_PATH, content: nextCatalog, expectedRevision: input.expected.catalog }
    ], async handle => {
      if (await empty(handle, folder)) await api.storage.remove({ handle, path: folder }, { missingOk: true })
      if (nextCatalog === null && await empty(handle, EMBEDS_REL_DIR)) await api.storage.remove({ handle, path: EMBEDS_REL_DIR }, { missingOk: true })
    })
    api.rpc.emit('providers.changed', { id: provider?.id ?? input.id })
    return { id: provider?.id ?? input.id, directory, revisions: { provider: result.revisions[0], renderer: result.revisions[1] }, catalogRevision: result.revisions[2] }
  }
  return {
    'providers.list': async (raw: unknown) => { providerSchemas['providers.list'].parse(raw); return list() },
    'providers.create': async (raw: unknown) => {
      providerSchemas['providers.create'].parse(raw)
      const { configuration: snapshot, catalog } = await read(), used = new Set([...Object.keys(snapshot.revisions), ...Object.keys(catalogProviders(catalog)), ...snapshot.providers.map(value => value.language), 'surfing'].map(value => value.toLowerCase()))
      let suffix = 1, id = 'custom'
      while (used.has(id)) id = `custom-${++suffix}`
      const docs = await documents(id)
      return save({ schemaVersion: 1, id, displayName: suffix === 1 ? 'Custom' : `Custom ${suffix}`, language: id, template: 'https://example.com/embed/{value}', kind: 'generic', valueParser: 'identity', presentation: { initialHeight: 360, autoSize: false, fullWidth: true }, order: Math.max(0, ...snapshot.providers.map(value => value.order)) + 10, directory: id }, { provider: docs.provider.revision, renderer: docs.renderer.revision, catalog: snapshot.catalogRevision }, false)
    },
    'providers.customize': async (raw: unknown) => {
      const input = providerSchemas['providers.customize'].parse(raw), snapshot = await list(), provider = snapshot.providers.find(value => value.id === input.id)
      if (!provider) refused('TARGET_NOT_FOUND', 'Embed provider is unavailable')
      return save(provider, input.expected, true)
    },
    'providers.set': (raw: unknown) => { const input = providerSchemas['providers.set'].parse(raw); return save(input.provider, input.expected, false) },
    'providers.delete': (raw: unknown) => remove(providerSchemas['providers.delete'].parse(raw))
  }
}
export function registerProviderOwner(api: PluginBackendApi): () => void {
  const ui = createProviderOwner(api), disposers = Object.keys(providerSchemas).flatMap(method => [
    api.rpc.handle(method, input => ui[method as keyof typeof ui](input)),
    api.rpc.handleOperation(`command.${method}`, (input, context) => createProviderOwner(context.api, () => context.cancellation.throwIfAborted())[method as keyof typeof ui](input))
  ])
  return () => disposers.forEach(dispose => dispose())
}
