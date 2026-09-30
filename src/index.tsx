/** Surfing: website tabs with isolated profiles, web file views, page embeds, and assistant browsing and URL fetch tools. */
import {
  BROWSER_AUTOMATION_V1,
  AGENT_TOOL_PROVIDER_V1,
  WEB_NAVIGATOR_V1,
  type ValleyPluginApi,
  type ValleyPluginModule
} from '@valley/plugin-sdk'
import { initRuntime } from './runtime'
import { injectStyles } from './styles'
import { createStore, disposeStore } from './store'
import { createBrowserAutomationService, registerWebCommands } from './commands'
import { registerWebFences } from './embeds'
import { ensureEmbedProviders } from './embedProviders'
import { Page } from './Page'
import { UrlFileView } from './UrlFileView'
import { MhtmlFileView, HarFileView } from './ArchiveFileViews'
import { Panel } from './Panel'
import { Settings } from './Settings'
import { initLocalization, uiText } from './localization'
import { createWebFetcher } from './webFetch'
import { surfingAgentTools, registerBrowserAgentCommands } from './agentTools'
import { registerSurfingDetails } from './workspaceDetails'
import { registerSurfingSurfaces } from './surfaces'

export function register(api: ValleyPluginApi): () => Promise<void> {
  initLocalization(api)
  initRuntime(api)
  const disposeStyles = injectStyles()
  const store = createStore(api)
  let active = true
  store.startOverlay()
  const ready = store.loadConfig()
  const providersReady = ready.then(() => active ? ensureEmbedProviders() : { providers: [], customized: [], issues: [] })
  const offDetails = registerSurfingDetails(api, store)
  const offSurfaces = registerSurfingSurfaces(api, store, ready)
  const fetcher = createWebFetcher(api, store)
  const offCommands = registerWebCommands(api, store, fetcher)
  const offLinkHandler = api.links.register({
    id: 'browse', label: api.ui.t('manifest.name'), version: '1.0.0', categories: ['website'],
    open: ({ value }) => {
      const instanceId = store.openTab(value)
      api.workspace.openMainTab({ instanceId, title: value })
      return { status: 'opened' }
    }
  })
  const offNavigator = api.interop.services.provide(WEB_NAVIGATOR_V1, {
    open: ({ url, title, newTab }) => {
      const instanceId = store.openTab(url)
      api.workspace.openMainTab({
        instanceId,
        title: title ?? (url.trim() || uiText('auto.6f23a36f0aa1')),
        newTab
      })
    }
  })
  const browserAutomation = createBrowserAutomationService(api, store)
  const offBrowserAutomation = api.interop.services.provide(BROWSER_AUTOMATION_V1, browserAutomation)
  const offAgentCommands = registerBrowserAgentCommands(api, browserAutomation)
  const offAgentTools = api.interop.services.provide(AGENT_TOOL_PROVIDER_V1, surfingAgentTools(browserAutomation, api, fetcher))
  let disposal: Promise<void> | undefined
  let offNewTab: (() => void) | null = null
  const syncNewTabHandler = (): void => {
    if (!active) return
    if (store.settings.openWebsiteOnNewTab && !offNewTab) {
      offNewTab = api.workspace.registerNewTabHandler(({ paneId }) => {
        const instanceId = store.openTab('')
        api.workspace.openMainTab({
          instanceId,
          title: uiText('auto.6f23a36f0aa1'),
          newTab: true,
          paneId
        })
      })
    } else if (!store.settings.openWebsiteOnNewTab && offNewTab) {
      offNewTab()
      offNewTab = null
    }
  }
  const offNewTabSetting = store.subscribe(syncNewTabHandler)
  void ready.then(syncNewTabHandler)
  const offFences = registerWebFences(providersReady)

  api.registerView('surfing.page', Page)
  api.registerView('surfing.url', UrlFileView)
  api.registerView('surfing.mhtml', MhtmlFileView)
  api.registerView('surfing.har', HarFileView)
  api.registerView('surfing.panel', Panel)
  api.registerView('surfing.settings', Settings)

  return () => {
    if (disposal) return disposal
    active = false
    offNewTabSetting()
    offNewTab?.()
      offNavigator()
      offLinkHandler()
    offBrowserAutomation()
    offAgentTools()
    offAgentCommands()
    offDetails()
    offSurfaces()
    const commandsDrained = offCommands()
    offFences()
    const drained = disposeStore(api, store)
    disposeStyles()
    return disposal = Promise.allSettled([drained, commandsDrained]).then(results => {
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
  }
}

const plugin: ValleyPluginModule = { register }
export default plugin
