import { z } from 'zod'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import { BUILT_IN_PROVIDERS, embedRendererForProvider, embedRendererModuleSource } from '../embeds/registry'
import { EMBEDS_REL_DIR, providerPath, providerRelPath, rendererRelPath, safeDirectory, parseJson, validateProvider, type EmbedProviderConfiguration, type EmbedProviderIssue } from '../embedProviderData'
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
  'providers.set': z.object({ provider: providerSchema, expected: expectedSchema }).strict()
}
export const providerOutputs = {
  list: z.object({ providers: z.array(providerSchema), customized: z.array(z.string()), issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()), revisions: z.record(revisions), catalogRevision: revision }).strict(),
  saved: z.object({ provider: providerSchema, revisions, catalogRevision: revision }).strict()
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
  const list = async (): Promise<EmbedProviderConfiguration> => {
    const catalog = await scope('read', handle => api.storage.readDocument({ handle, path: 'embeds/catalog.json' }))
    const entries = await api.data.files.list(EMBEDS_REL_DIR), providers = [...BUILT_IN_PROVIDERS], customized: string[] = [], issues: EmbedProviderIssue[] = [], observed: EmbedProviderConfiguration['revisions'] = {}
    const directories = [...new Set([...providers.map(provider => provider.directory), ...entries.filter(entry => entry.isDirectory && safeDirectory(entry.name)).map(entry => entry.name)])]
    for (const directory of directories) {
      const docs = await documents(directory)
      observed[directory] = { provider: docs.provider.revision, renderer: docs.renderer.revision }
      if (!docs.provider.content.trim()) continue
      const path = providerPath(directory), provider = validateProvider(parseJson(docs.provider.content, path, issues), directory, issues)
      if (!provider) continue
      if (providers.some(value => value.id.toLowerCase() !== provider.id.toLowerCase() && value.language.toLowerCase() === provider.language.toLowerCase())) { issues.push({ path, message: 'Provider language must be unique' }); continue }
      const index = providers.findIndex(value => value.id.toLowerCase() === provider.id.toLowerCase())
      if (index >= 0) providers[index] = provider; else providers.push(provider)
      customized.push(provider.id)
    }
    return { providers: providers.sort((a, b) => a.order - b.order || a.displayName.localeCompare(b.displayName)), customized, issues, revisions: observed, catalogRevision: catalog.revision }
  }
  const save = async (provider: EmbedProvider, expected: z.infer<typeof expectedSchema>, customize: boolean) => {
    const issues: EmbedProviderIssue[] = [], checked = validateProvider(provider, provider.directory, issues)
    if (!checked) throw new Error(issues.map(issue => issue.message).join('; '))
    const snapshot = await list()
    if (snapshot.providers.some(value => value.id !== checked.id && value.language.toLowerCase() === checked.language.toLowerCase())) throw new Error('Provider language must be unique')
    if (snapshot.catalogRevision !== expected.catalog) throw Object.assign(new Error('Embed providers changed; reload before saving'), { code: 'REVISION_CONFLICT' })
    const current = await documents(checked.directory)
    const { directory: _, ...value } = checked
    const source = current.renderer.content || embedRendererModuleSource(embedRendererForProvider(checked))
    const contents = [customize && current.provider.content ? current.provider.content : `${JSON.stringify(value, null, 2)}\n`, source]
    guard()
    const result = await scope('write', handle => api.storage.writeDocuments([
      { location: { handle, path: providerRelPath(checked.directory) }, content: contents[0], expectedRevision: expected.provider },
      { location: { handle, path: rendererRelPath(checked.directory) }, content: contents[1], expectedRevision: expected.renderer },
      { location: { handle, path: 'embeds/catalog.json' }, content: JSON.stringify({ revision: expected.catalog + Number(contents[0] !== current.provider.content || contents[1] !== current.renderer.content) }), expectedRevision: expected.catalog }
    ]))
    api.rpc.emit('providers.changed', { id: checked.id })
    return { provider: checked, revisions: { provider: result.revisions[0], renderer: result.revisions[1] }, catalogRevision: result.revisions[2] }
  }
  return {
    'providers.list': async (raw: unknown) => { providerSchemas['providers.list'].parse(raw); return list() },
    'providers.create': async (raw: unknown) => {
      providerSchemas['providers.create'].parse(raw)
      const snapshot = await list(), used = new Set([...Object.keys(snapshot.revisions), ...snapshot.providers.map(value => value.language.toLowerCase()), 'surfing'])
      let suffix = 1, id = 'custom'
      while (used.has(id)) id = `custom-${++suffix}`
      return save({ schemaVersion: 1, id, displayName: suffix === 1 ? 'Custom' : `Custom ${suffix}`, language: id, template: 'https://example.com/embed/{value}', kind: 'generic', valueParser: 'identity', presentation: { initialHeight: 360, autoSize: false, fullWidth: true }, order: Math.max(0, ...snapshot.providers.map(value => value.order)) + 10, directory: id }, { provider: 0, renderer: 0, catalog: snapshot.catalogRevision }, false)
    },
    'providers.customize': async (raw: unknown) => {
      const input = providerSchemas['providers.customize'].parse(raw), snapshot = await list(), provider = snapshot.providers.find(value => value.id === input.id)
      if (!provider) throw new Error('Embed provider is unavailable')
      return save(provider, input.expected, true)
    },
    'providers.set': (raw: unknown) => { const input = providerSchemas['providers.set'].parse(raw); return save(input.provider, input.expected, false) }
  }
}
export function registerProviderOwner(api: PluginBackendApi): () => void {
  const ui = createProviderOwner(api), disposers = Object.keys(providerSchemas).flatMap(method => [
    api.rpc.handle(method, input => ui[method as keyof typeof ui](input)),
    api.rpc.handleOperation(`command.${method}`, (input, context) => createProviderOwner(context.api, () => context.cancellation.throwIfAborted())[method as keyof typeof ui](input))
  ])
  return () => disposers.forEach(dispose => dispose())
}
