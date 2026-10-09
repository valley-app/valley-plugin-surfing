import { uiText } from './localization'
import { api } from './runtime'
import {
  installRuntimeEmbedRenderers
} from './embeds/registry'
import type {
  EmbedProvider,
  EmbedRenderer
} from './embeds/types'

export type {
  EmbedProvider,
  EmbedProviderKind,
  EmbedProviderPresentation,
  EmbedProviderTheme,
  EmbedThemeName,
  EmbedValueParser
} from './embeds/types'

export { EMBEDS_REL_DIR, EMBEDS_DIR, WEB_FENCE_LANGUAGE } from './embedProviderData'
export type { EmbedProviderIssue, EmbedProviderConfiguration } from './embedProviderData'
import { EMBEDS_DIR, rendererPath, rendererRelPath, type EmbedProviderIssue, type EmbedProviderConfiguration } from './embedProviderData'
function validateRenderer(value: unknown, provider: EmbedProvider, path: string, issues: EmbedProviderIssue[]): EmbedRenderer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: uiText('surfing.embedValidation.renderer') })
    return null
  }
  const renderer = value as Record<string, unknown>
  if (renderer.kind !== provider.kind || renderer.valueParser !== provider.valueParser ||
      typeof renderer.parseValue !== 'function' || typeof renderer.matchesUrl !== 'function' ||
      typeof renderer.fullWidthCss !== 'string' || !renderer.fullWidthCss.trim() || renderer.fullWidthCss.length > 50_000 ||
      typeof renderer.measureRootScript !== 'string' || !renderer.measureRootScript.trim() || renderer.measureRootScript.length > 5_000) {
    issues.push({ path, message: uiText('surfing.embedValidation.rendererFields') })
    return null
  }
  return renderer as unknown as EmbedRenderer
}

function rendererHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

async function loadRenderer(provider: EmbedProvider, issues: EmbedProviderIssue[]): Promise<{ renderer: EmbedRenderer; stamp: string } | null> {
  const path = rendererPath(provider.directory)
  const relPath = rendererRelPath(provider.directory)
  const raw = await api.data.files.readText(relPath)
  if (!raw?.trim()) return null
  const compiled = await api.data.files.compileModule(relPath)
  if (compiled.error || !compiled.code) {
    issues.push({ path, message: compiled.error || uiText('surfing.embedValidation.emptyRenderer') })
    return null
  }
  const url = URL.createObjectURL(new Blob([compiled.code], { type: 'text/javascript' }))
  try {
    const module = await import(/* @vite-ignore */ url) as Record<string, unknown>
    const renderer = validateRenderer(module.default ?? module.renderer, provider, path, issues)
    return renderer ? { renderer, stamp: rendererHash(compiled.code) } : null
  } catch (error) {
    issues.push({ path, message: error instanceof Error ? error.message : String(error) })
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

let rendererLoadSequence = 0

export async function loadEmbedProviders(loadRenderers = true): Promise<EmbedProviderConfiguration> {
  const loadSequence = loadRenderers ? ++rendererLoadSequence : rendererLoadSequence
  const configuration = await api.backend.call<EmbedProviderConfiguration>('providers.list', {})
  const { providers, issues, customized } = configuration
  const runtimeRenderers = new Map<string, EmbedRenderer>()
  const stamps: string[] = []
  for (const provider of loadRenderers ? providers : []) {
    const loaded = await loadRenderer(provider, issues)
    if (!loaded) continue
    runtimeRenderers.set(provider.directory, loaded.renderer)
    stamps.push(`${provider.directory}:${loaded.stamp}`)
  }
  if (loadRenderers && loadSequence === rendererLoadSequence) installRuntimeEmbedRenderers(runtimeRenderers)
  return { ...configuration, providers, customized, issues, rendererStamp: stamps.join('|') }
}

export async function ensureEmbedProviders(): Promise<EmbedProviderConfiguration> {
  return loadEmbedProviders()
}

export interface SavedEmbedProvider {
  provider: EmbedProvider
  revisions: { provider: number; renderer: number }
  catalogRevision: number
  /** True only when deleting the provider at these revisions restores the exact bytes it had before this save. */
  restorable: boolean
}

export async function customizeEmbedProvider(provider: EmbedProvider): Promise<SavedEmbedProvider> {
  const snapshot = await api.backend.call<EmbedProviderConfiguration>('providers.list', {})
  return api.backend.call<SavedEmbedProvider>('providers.customize', { id: provider.id, expected: { ...snapshot.revisions[provider.id] ?? { provider: 0, renderer: 0 }, catalog: snapshot.catalogRevision } })
}

export async function createCustomEmbedProviderSaved(): Promise<SavedEmbedProvider> {
  return api.backend.call<SavedEmbedProvider>('providers.create', {})
}

export async function createCustomEmbedProvider(): Promise<EmbedProvider> {
  return (await createCustomEmbedProviderSaved()).provider
}

type ProviderRevisions = Pick<SavedEmbedProvider, 'revisions' | 'catalogRevision'>

/** Undo deletes the files the forward write created, guarded by the revisions it produced; redo writes them again. Offered only for a restorable save. */
export function embedProviderFilesRevert(label: string, saved: SavedEmbedProvider, recreate: (expected: { provider: number; renderer: number; catalog: number }) => Promise<SavedEmbedProvider>) {
  let current: ProviderRevisions = saved, restorable = saved.restorable
  const expected = () => ({ ...current.revisions, catalog: current.catalogRevision })
  return {
    label,
    run: async () => {
      if (!restorable) throw Object.assign(new Error('Deleting this embed provider would not restore its exact prior files'), { code: 'ACTION_UNAVAILABLE', outcome: 'not-applied', retryable: false })
      current = await api.backend.call<ProviderRevisions>('providers.delete', { id: saved.provider.id, expected: expected() })
    },
    reapply: async () => { const next = await recreate(expected()); current = next; restorable = next.restorable }
  }
}

export function embedProviderPath(provider: Pick<EmbedProvider, 'directory'>): string {
  return `${EMBEDS_DIR}/${provider.directory}`
}
