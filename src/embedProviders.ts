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

export async function customizeEmbedProvider(provider: EmbedProvider): Promise<void> {
  const snapshot = await api.backend.call<EmbedProviderConfiguration>('providers.list', {})
  await api.backend.call('providers.customize', { id: provider.id, expected: { ...snapshot.revisions[provider.id] ?? { provider: 0, renderer: 0 }, catalog: snapshot.catalogRevision } })
}

export async function createCustomEmbedProvider(): Promise<EmbedProvider> {
  const result = await api.backend.call<{ provider: EmbedProvider }>('providers.create', {})
  return result.provider
}

export function embedProviderPath(provider: Pick<EmbedProvider, 'directory'>): string {
  return `${EMBEDS_DIR}/${provider.directory}`
}
