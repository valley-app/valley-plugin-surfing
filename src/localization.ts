import type { BundledPluginTranslationCatalogs, ValleyPluginApi } from '@valley/plugin-sdk'
import en from '../locales/en.json'
import de from '../locales/de.json'
import es from '../locales/es.json'
import fr from '../locales/fr.json'
import zhCN from '../locales/zh-CN.json'

const catalogs = { en, de, es, fr, 'zh-CN': zhCN } satisfies BundledPluginTranslationCatalogs

function english(key: string, params?: Parameters<ValleyPluginApi['ui']['t']>[1]): string {
  const fallback = (catalogs.en as Record<string, string>)[key] ?? key
  return fallback.replace(/\{\{([^}]+)\}\}/g, (_match: string, name: string) => String(params?.[name] ?? ''))
}

let translate: ValleyPluginApi['ui']['t'] = english

export function initLocalization(api: ValleyPluginApi): void {
  api.ui.registerCatalogs(catalogs)
  translate = createUiText(api)
}

export function createUiText(api: ValleyPluginApi): ValleyPluginApi['ui']['t'] {
  return (key, params) => {
    const value = api.ui.t(key, params)
    return value === key ? english(key, params) : value
  }
}

export function uiText(key: string, params?: Parameters<ValleyPluginApi['ui']['t']>[1]): string {
  return translate(key, params)
}
