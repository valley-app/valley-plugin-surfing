import { uiText } from './localization'
import { pluginDataDirectoryPath } from '@valley/plugin-sdk/paths'
import type { EmbedProvider, EmbedProviderPresentation, EmbedProviderTheme } from './embeds/types'
export const EMBEDS_REL_DIR = 'embeds'
export const PROVIDER_FILENAME = 'provider.json'
export const RENDERER_FILENAME = 'renderer.tsx'
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
  catalogRevision: number
  revisions: Record<string, { provider: number; renderer: number }>
  rendererStamp?: string
}


export function providerRelPath(directory: string): string {
  return `${EMBEDS_REL_DIR}/${directory}/${PROVIDER_FILENAME}`
}

export function providerPath(directory: string): string {
  return `${EMBEDS_DIR}/${directory}/${PROVIDER_FILENAME}`
}

export function rendererRelPath(directory: string): string {
  return `${EMBEDS_REL_DIR}/${directory}/${RENDERER_FILENAME}`
}

export function rendererPath(directory: string): string {
  return `${EMBEDS_DIR}/${directory}/${RENDERER_FILENAME}`
}

export function safeDirectory(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(value) && !value.includes('..')
}

export function parseJson(raw: string, path: string, issues: EmbedProviderIssue[]): unknown {
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

export function validateProvider(value: unknown, directory: string, issues: EmbedProviderIssue[]): EmbedProvider | null {
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

