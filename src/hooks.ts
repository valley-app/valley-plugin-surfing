import { React, api } from './runtime'
import { getStore, type WebSnapshot, type WebStore } from './store'
import { DEFAULT_PROFILE_ID, DEFAULT_SETTINGS, reconcileProfiles } from './profiles'
import { WEB_ACTIVE_CONTEXT_V1, type ActiveWebContext } from '@valley/plugin-sdk'

const EMPTY: WebSnapshot = {
  tabs: {},
  profiles: reconcileProfiles([]),
  activeProfileId: DEFAULT_PROFILE_ID,
  settings: DEFAULT_SETTINGS,
  favorites: [],
  readingList: [],
  history: [],
  agentActivity: []
}
const noopSubscribe = (): (() => void) => () => {}
const emptySnapshot = (): WebSnapshot => EMPTY

/** Subscribe a view to the plugin session's host-owned runtime store. */
export function useWeb(): { store: WebStore | null; snap: WebSnapshot } {
  const store = getStore()
  const snap = React.useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : emptySnapshot
  )
  return { store, snap }
}

function getActiveWeb(): ActiveWebContext | null {
  return api.interop.state.get(WEB_ACTIVE_CONTEXT_V1)
}
function subscribeActiveWeb(cb: () => void): () => void {
  return api.interop.state.subscribe(WEB_ACTIVE_CONTEXT_V1, cb)
}

/** Subscribe to the currently-focused web page (published under the `surfing.active`
 *  shared-context key by the active `surfing.page`). Used by the sidebar to add the
 *  current page to the reading list. The published value is replaced only on
 *  change, so it's snapshot-stable. */
export function useActiveWebContext(): ActiveWebContext | null {
  return React.useSyncExternalStore(subscribeActiveWeb, getActiveWeb, getActiveWeb)
}

/** The host's General-settings date/time format (Preferences), for timestamping
 *  Timeline entries the same way the rest of the app displays dates/times. */
export function useHostDateFormat(): { dateFormat: string; timeFormat: '24h' | '12h' } {
  const state = React.useSyncExternalStore(api.subscribe, api.getState, api.getState)
  return { dateFormat: state.dateFormat, timeFormat: state.timeFormat }
}
