import { uiText } from './localization'
import { api } from './runtime'
import { pluginDataDirectoryPath } from '@valley/plugin-sdk/paths'
import {
  BUILT_IN_PROVIDERS,
  embedRendererForProvider,
  embedRendererModuleSource,
  installRuntimeEmbedRenderers
} from './embeds/registry'
import type {
  EmbedProvider,
  EmbedProviderPresentation,
  EmbedProviderTheme,
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

export const EMBEDS_REL_DIR = 'embeds'
const PROVIDER_FILENAME = 'provider.json'
const RENDERER_FILENAME = 'renderer.tsx'
export const EMBEDS_DIR = `${pluginDataDirectoryPath('surfing')}/${EMBEDS_REL_DIR}`
export const WEB_FENCE_LANGUAGE = 'surfing'

export interface EmbedProviderIssue {
  path: string
  message: string
}

export interface EmbedProviderConfiguration {
  providers: EmbedProvider[]
  customized: string[]
  issues: EmbedProviderIssue[]
  rendererStamp?: string
}

const BUILT_INS = BUILT_IN_PROVIDERS

function providerRelPath(directory: string): string {
  return `${EMBEDS_REL_DIR}/${directory}/${PROVIDER_FILENAME}`
}

function providerPath(directory: string): string {
  return `${EMBEDS_DIR}/${directory}/${PROVIDER_FILENAME}`
}

function rendererRelPath(directory: string): string {
  return `${EMBEDS_REL_DIR}/${directory}/${RENDERER_FILENAME}`
}

function rendererPath(directory: string): string {
  return `${EMBEDS_DIR}/${directory}/${RENDERER_FILENAME}`
}

function safeDirectory(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(value) && !value.includes('..')
}

function parseJson(raw: string, path: string, issues: EmbedProviderIssue[]): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    issues.push({ path, message: uiText('surfing.embedValidation.json') })
    return null
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validatePresentation(value: unknown, path: string, issues: EmbedProviderIssue[]): EmbedProviderPresentation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: uiText('surfing.embedValidation.presentation') })
    return null
  }
  const record = value as Record<string, unknown>
  const initialHeight = record.initialHeight
  const autoSize = record.autoSize
  const fullWidth = record.fullWidth
  const minHeight = record.minHeight
  const maxHeight = record.maxHeight
  const aspectRatio = record.aspectRatio
  const httpReferrer = record.httpReferrer
  const fitWidth = record.fitWidth
  if (!finiteNumber(initialHeight) || initialHeight < 1 || initialHeight > 2000 || typeof autoSize !== 'boolean' || typeof fullWidth !== 'boolean') {
    issues.push({ path, message: uiText('surfing.embedValidation.presentationFields') })
    return null
  }
  if ((minHeight !== undefined && (!finiteNumber(minHeight) || minHeight < 1 || minHeight > 2000)) ||
      (maxHeight !== undefined && (!finiteNumber(maxHeight) || maxHeight < 1 || maxHeight > 2000)) ||
      (finiteNumber(minHeight) && finiteNumber(maxHeight) && minHeight > maxHeight)) {
    issues.push({ path, message: uiText('surfing.embedValidation.height') })
    return null
  }
  if (aspectRatio !== undefined && (typeof aspectRatio !== 'string' || !/^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/.test(aspectRatio))) {
    issues.push({ path, message: uiText('surfing.embedValidation.aspect') })
    return null
  }
  if (httpReferrer !== undefined) {
    try {
      const url = new URL(String(httpReferrer))
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported')
    } catch {
      issues.push({ path, message: uiText('surfing.embedValidation.referrer') })
      return null
    }
  }
  if (fitWidth !== undefined) {
    if (!fitWidth || typeof fitWidth !== 'object' || Array.isArray(fitWidth)) {
      issues.push({ path, message: uiText('surfing.embedValidation.fit') })
      return null
    }
    const fit = fitWidth as Record<string, unknown>
    if (!finiteNumber(fit.naturalWidth) || fit.naturalWidth < 1 || fit.naturalWidth > 2000 ||
        !finiteNumber(fit.maxScale) || fit.maxScale < 1 || fit.maxScale > 4) {
      issues.push({ path, message: uiText('surfing.embedValidation.fitFields') })
      return null
    }
  }
  return {
    initialHeight,
    autoSize,
    fullWidth,
    ...(finiteNumber(minHeight) ? { minHeight } : {}),
    ...(finiteNumber(maxHeight) ? { maxHeight } : {}),
    ...(typeof aspectRatio === 'string' ? { aspectRatio } : {}),
    ...(typeof httpReferrer === 'string' ? { httpReferrer } : {}),
    ...(fitWidth && typeof fitWidth === 'object' && !Array.isArray(fitWidth) ? {
      fitWidth: {
        naturalWidth: Number((fitWidth as Record<string, unknown>).naturalWidth),
        maxScale: Number((fitWidth as Record<string, unknown>).maxScale)
      }
    } : {})
  }
}

function validateTheme(value: unknown, path: string, issues: EmbedProviderIssue[]): EmbedProviderTheme | null | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: uiText('surfing.embedValidation.theme') })
    return null
  }
  const record = value as Record<string, unknown>
  const queryParameter = typeof record.queryParameter === 'string' ? record.queryParameter.trim() : ''
  const values = record.values
  if (!/^[a-z][a-z0-9_-]*$/i.test(queryParameter) || !values || typeof values !== 'object' || Array.isArray(values)) {
    issues.push({ path, message: uiText('surfing.embedValidation.themeFields') })
    return null
  }
  const themes = values as Record<string, unknown>
  if (!['light', 'dark'].every((theme) => typeof themes[theme] === 'string' && Boolean(String(themes[theme]).trim()))) {
    issues.push({ path, message: uiText('surfing.embedValidation.themeValues') })
    return null
  }
  return {
    queryParameter,
    values: {
      light: String(themes.light).trim(),
      dark: String(themes.dark).trim()
    }
  }
}

function validateProvider(value: unknown, directory: string, issues: EmbedProviderIssue[]): EmbedProvider | null {
  const path = providerPath(directory)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: uiText('surfing.embedValidation.definition') })
    return null
  }
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const displayName = typeof record.displayName === 'string' ? record.displayName.trim() : ''
  const language = typeof record.language === 'string' ? record.language.trim() : ''
  const template = typeof record.template === 'string' ? record.template.trim() : ''
  const kind = record.kind
  const valueParser = record.valueParser
  const order = record.order
  if (record.schemaVersion !== 1 || !safeDirectory(id) || id !== directory || !displayName || !/^[a-z][a-z0-9_-]*$/i.test(language)) {
    issues.push({ path, message: uiText('surfing.embedValidation.identity') })
    return null
  }
  if (language.toLowerCase() === WEB_FENCE_LANGUAGE) {
    issues.push({ path, message: uiText('surfing.embedValidation.reserved', { value: language }) })
    return null
  }
  if (kind !== 'youtube' && kind !== 'x' && kind !== 'generic') {
    issues.push({ path, message: uiText('surfing.embedValidation.kind') })
    return null
  }
  if ((kind === 'youtube' && id !== 'youtube') || (kind === 'x' && id !== 'x')) {
    issues.push({ path, message: uiText('surfing.embedValidation.builtinId') })
    return null
  }
  if (valueParser !== 'youtube-video-id' && valueParser !== 'x-post-id' && valueParser !== 'identity') {
    issues.push({ path, message: uiText('surfing.embedValidation.parser') })
    return null
  }
  if ((kind === 'youtube' && valueParser !== 'youtube-video-id') || (kind === 'x' && valueParser !== 'x-post-id')) {
    issues.push({ path, message: uiText('surfing.embedValidation.builtinParser') })
    return null
  }
  if (!finiteNumber(order)) {
    issues.push({ path, message: uiText('surfing.embedValidation.order') })
    return null
  }
  if ((template.match(/\{value\}/g) ?? []).length > 1) {
    issues.push({ path, message: uiText('surfing.embedValidation.templateValue') })
    return null
  }
  try {
    const url = new URL(template.replace('{value}', 'value'))
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported')
  } catch {
    issues.push({ path, message: uiText('surfing.embedValidation.templateUrl') })
    return null
  }
  const presentation = validatePresentation(record.presentation, path, issues)
  const theme = validateTheme(record.theme, path, issues)
  if (!presentation || theme === null) return null
  return {
    schemaVersion: 1,
    id,
    displayName,
    language,
    template,
    kind,
    valueParser,
    presentation,
    ...(theme ? { theme } : {}),
    order,
    directory
  }
}

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

export async function loadEmbedProviders(): Promise<EmbedProviderConfiguration> {
  const loadSequence = ++rendererLoadSequence
  const issues: EmbedProviderIssue[] = []
  const entries = await api.data.files.list(EMBEDS_REL_DIR)
  let providers: EmbedProvider[] = [...BUILT_INS]
  const customized: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory || !safeDirectory(entry.name)) continue
    const path = providerPath(entry.name)
    const raw = await api.data.files.readText(providerRelPath(entry.name)) ?? ''
    if (!raw.trim()) {
      issues.push({ path, message: uiText('surfing.embedValidation.missingFile', { value: PROVIDER_FILENAME }) })
      continue
    }
    const provider = validateProvider(parseJson(raw, path, issues), entry.name, issues)
    if (!provider) continue
    const id = provider.id.toLowerCase()
    const language = provider.language.toLowerCase()
    if (providers.some((entry) => entry.id.toLowerCase() !== id && entry.language.toLowerCase() === language)) {
      issues.push({ path, message: uiText('surfing.embedValidation.unique') })
      continue
    }
    const previous = providers.findIndex((entry) => entry.id.toLowerCase() === id)
    if (previous >= 0) providers[previous] = provider
    else providers.push(provider)
    customized.push(provider.id)
  }
  providers.sort((left, right) => left.order - right.order || left.displayName.localeCompare(right.displayName))
  const runtimeRenderers = new Map<string, EmbedRenderer>()
  const stamps: string[] = []
  for (const provider of providers) {
    const loaded = await loadRenderer(provider, issues)
    if (!loaded) continue
    runtimeRenderers.set(provider.directory, loaded.renderer)
    stamps.push(`${provider.directory}:${loaded.stamp}`)
  }
  if (loadSequence === rendererLoadSequence) installRuntimeEmbedRenderers(runtimeRenderers)
  return { providers, customized, issues, rendererStamp: stamps.join('|') }
}

function providerJson(provider: EmbedProvider): string {
  const { directory: _directory, ...data } = provider
  return `${JSON.stringify(data, null, 2)}\n`
}

async function guardedWrite(path: string, content: string): Promise<void> {
  const current = await api.data.files.readTextBaseline(path)
  const result = await api.data.files.writeTextGuarded(path, content, current?.baseline ?? null)
  if (!result.ok) throw new Error(uiText('surfing.error.embedChanged', { value: path }))
}

async function writeProviders(providers: EmbedProvider[]): Promise<void> {
  for (const provider of providers) {
    await guardedWrite(providerRelPath(provider.directory), providerJson(provider))
    const rendererPath = rendererRelPath(provider.directory)
    if (await api.data.files.readText(rendererPath) === null) {
      await guardedWrite(rendererPath, embedRendererModuleSource(embedRendererForProvider(provider)))
    }
  }
}

export async function ensureEmbedProviders(): Promise<EmbedProviderConfiguration> {
  return loadEmbedProviders()
}

export async function customizeEmbedProvider(provider: EmbedProvider): Promise<void> {
  const path = providerRelPath(provider.directory)
  if (await api.data.files.readText(path) === null) await guardedWrite(path, providerJson(provider))
  const renderer = rendererRelPath(provider.directory)
  if (await api.data.files.readText(renderer) === null) await guardedWrite(renderer, embedRendererModuleSource(embedRendererForProvider(provider)))
}

export async function createCustomEmbedProvider(): Promise<EmbedProvider> {
  const configuration = await loadEmbedProviders()
  const entries = await api.data.files.list(EMBEDS_REL_DIR)
  const ids = new Set([...configuration.providers.map(provider => provider.id.toLowerCase()), ...entries.filter(entry => entry.isDirectory).map(entry => entry.name.toLowerCase())])
  const languages = new Set([WEB_FENCE_LANGUAGE, ...configuration.providers.map(provider => provider.language.toLowerCase())])
  let suffix = 1
  let id = 'custom'
  while (ids.has(id) || languages.has(id)) id = `custom-${++suffix}`
  const provider: EmbedProvider = {
    schemaVersion: 1,
    id,
    displayName: suffix === 1 ? uiText('surfing.embedValidation.custom') : `${uiText('surfing.embedValidation.custom')} ${suffix}`,
    language: suffix === 1 ? 'custom' : `custom-${suffix}`,
    template: 'https://example.com/embed/{value}',
    kind: 'generic',
    valueParser: 'identity',
    presentation: { initialHeight: 360, autoSize: false, fullWidth: true },
    order: Math.max(0, ...configuration.providers.map((provider) => provider.order)) + 10,
    directory: id
  }
  await writeProviders([provider])
  return provider
}

export function embedProviderPath(provider: Pick<EmbedProvider, 'directory'>): string {
  return `${EMBEDS_DIR}/${provider.directory}`
}
