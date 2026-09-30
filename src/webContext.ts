import {
  TEXT_SELECTION_ACTION_V1,
  WEB_ACTIVE_CONTEXT_V1,
  type ActiveWebContext
} from '@valley/plugin-sdk'
import { api } from './runtime'

export type { ActiveWebContext }

export function current(): ActiveWebContext | null {
  return api.interop.state.get(WEB_ACTIVE_CONTEXT_V1)
}

export function publishWebContext(ctx: ActiveWebContext): void {
  const prev = current()
  if (prev && prev.instanceId === ctx.instanceId && prev.url === ctx.url && prev.title === ctx.title) return
  api.interop.state.publish(WEB_ACTIVE_CONTEXT_V1, ctx)
}

export function clearWebContext(instanceId: string): void {
  const prev = current()
  if (!prev || prev.instanceId !== instanceId) return
  api.interop.state.publish(WEB_ACTIVE_CONTEXT_V1, null)
}

export function requestWebNoteFromSelection(url: string, snippet: string): void {
  const action = api.interop.extensions.providers(TEXT_SELECTION_ACTION_V1)
    .find(({ extension }) => extension.surfaces.includes('web'))
  if (!action) return
  void action.extension.run({ surface: 'web', url, text: snippet.trim().slice(0, 200) })
}
