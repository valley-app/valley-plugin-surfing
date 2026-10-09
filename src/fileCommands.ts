import type { MountedPluginView, ValleyPluginApi } from '@valley/plugin-sdk'
import type { CommandContext, CommandFileTarget } from '@valley/plugin-sdk/commands'
import { React, api } from './runtime'

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const text = (maxLength = 65536) => ({ type: 'string', maxLength })
const targetSchema = object({ mountId: text(256), generation: { type: 'integer', minimum: 0 } })
export const surfingFileActionSchema = { oneOf: [...['reload', 'previous', 'next'].map(type => object({ type: { const: type } })), ...['draft', 'search', 'select', 'anchor'].map(type => object({ type: { const: type }, value: text(type === 'draft' ? 32768 : 65536) }))] }
export type SurfingFileAction = { type: 'reload' | 'previous' | 'next' | 'save' } | { type: 'draft' | 'search' | 'select' | 'anchor'; value: string }
export interface SurfingFileController { snapshot(): Record<string, unknown>; run(action: SurfingFileAction, validate: () => Promise<void>): void | Promise<void> }
interface Entry { target: MountedPluginView; controller: SurfingFileController; signature: string; revision: string; pending: boolean }
const registry = (owner = api) => owner.runtime.getOrCreate('surfing.fileCommands', () => ({ entries: new Map<string, Entry>(), identity: crypto.randomUUID(), sequence: 0 }))
const keyOf = (target: Pick<MountedPluginView, 'mountId' | 'generation'>) => JSON.stringify([target.mountId, target.generation])
const refused = (code: string, message: string) => Object.assign(new Error(message), { code, outcome: 'not-applied' })
function strict(raw: unknown, keys: string[], required = keys): Record<string, unknown> { if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key)) || required.some(key => !(key in raw))) throw new Error('Expected a strict Surfing file action.'); return raw as Record<string, unknown> }
function parse(raw: unknown, route: 'inspect' | 'control' | 'save' = 'inspect') {
  const input = strict(raw, route === 'inspect' ? ['target'] : ['target', 'expectedRevision', 'action']), target = strict(input.target, ['mountId', 'generation'])
  if (typeof target.mountId !== 'string' || !target.mountId || target.mountId.length > 256 || !Number.isSafeInteger(target.generation) || Number(target.generation) < 0) throw new Error('Expected the exact Surfing file mount generation.')
  const exact = { mountId: target.mountId, generation: Number(target.generation) }
  if (route === 'inspect') return { target: exact }
  if (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 256) throw new Error('Expected the observed Surfing file revision.')
  const action = strict(input.action, ['type', 'value'], ['type']), type = action.type
  if (route === 'save') { if (type !== 'save') throw new Error('Only a shortcut save uses the save route.'); strict(action, ['type']) }
  else if (['draft', 'search', 'select', 'anchor'].includes(String(type))) { strict(action, ['type', 'value']); if (typeof action.value !== 'string' || action.value.length > (type === 'draft' ? 32768 : 65536)) throw new Error('Invalid or oversized Surfing file control text.') }
  else { if (!['reload', 'previous', 'next'].includes(String(type))) throw new Error('Unsupported Surfing file control.'); strict(action, ['type']) }
  return { target: exact, expectedRevision: input.expectedRevision, action: action as unknown as SurfingFileAction }
}
function observe(owner: ValleyPluginApi, target: Pick<MountedPluginView, 'mountId' | 'generation'>) {
  const state = registry(owner), entry = state.entries.get(keyOf(target))
  if (!entry) throw refused('TARGET_REPLACED', 'The exact Surfing file view is unavailable.')
  const view = entry.controller.snapshot(), signature = JSON.stringify(view)
  if (new TextEncoder().encode(signature).byteLength > 131072) throw refused('OUTPUT_TOO_LARGE', 'This complete Surfing file observation exceeds its response bound.')
  if (signature !== entry.signature) { entry.signature = signature; entry.revision = `${state.identity}:${++state.sequence}` }
  return { entry, result: { target, filePath: entry.target.filePath, revision: entry.revision, view } }
}
export function useSurfingFileCommands(target: MountedPluginView | undefined, controller: SurfingFileController): void {
  const latest = React.useRef(controller); latest.current = controller
  const [owner] = React.useState(() => api), key = target ? keyOf(target) : null
  React.useEffect(() => { if (!key || !target) return; const state = registry(owner), entry: Entry = { target, controller: { snapshot: () => latest.current.snapshot(), run: (action, validate) => latest.current.run(action, validate) }, signature: '', revision: '', pending: false }; if (state.entries.has(key)) throw new Error('Duplicate Surfing file mount.'); state.entries.set(key, entry); return () => { if (state.entries.get(key) === entry) state.entries.delete(key) } }, [owner, key])
}
export function registerSurfingFileCommands(owner: ValleyPluginApi): () => void {
  const boolean = { type: 'boolean' }, integer = { type: 'integer', minimum: 0 }, nullableText = { anyOf: [text(), { type: 'null' }] }
  const archiveProperties = { loading: boolean, error: nullableText, documentRevision: integer }
  const viewSchema = { oneOf: [object({ kind: { const: 'shortcut' }, loading: boolean, saving: boolean, prepared: boolean, draft: text(32768), savedUrl: text(32768), editorRevision: integer, dirty: boolean, uncertain: boolean }), object({ kind: { const: 'mhtml' }, ...archiveProperties, anchors: { type: 'array', maxItems: 1000, items: text() }, currentAnchor: nullableText }), object({ kind: { const: 'har' }, ...archiveProperties, search: text(), page: integer, pageCount: { type: 'integer', minimum: 1 }, selected: nullableText, requests: { type: 'array', maxItems: 100, items: object({ key: text(), index: integer, method: text(), url: text(), status: { type: 'number' } }) } })] }
  const inputSchema = (route: 'inspect' | 'control' | 'save') => object({ target: targetSchema, ...(route !== 'inspect' ? { expectedRevision: text(256), action: route === 'save' ? object({ type: { const: 'save' } }) : surfingFileActionSchema } : {}) })
  const fileTargets = (input: ReturnType<typeof parse>, save = false): CommandFileTarget[] => [{ kind: 'file', path: observe(owner, input.target).entry.target.filePath, fileOperation: save ? 'write' : 'read' }]
  const inspect = owner.commands.register({ id: 'file-view-inspect', label: 'Surfing: inspect exact shortcut or offline archive', sideEffect: 'read', paletteSafe: false, input: { schema: inputSchema('inspect'), parse }, outputSchema: object({ target: targetSchema, filePath: text(32768), revision: text(256), view: viewSchema }), fileTargets, recovery: 'observational', idempotent: true, limits: { requestBytes: 131072, responseBytes: 131072 }, run: input => observe(owner, input.target).result })
  const invoke = async (input: ReturnType<typeof parse>, context: CommandContext) => {
    const { entry, result } = observe(owner, input.target)
    if (!input.action || entry.pending || result.revision !== input.expectedRevision) throw refused('REVISION_CONFLICT', 'Surfing file state changed. Inspect its exact view again.')
    const assert = () => { if (context.cancellation?.aborted) throw refused('CANCELLED', 'The Surfing file action was cancelled before dispatch.'); if (registry(owner).entries.get(keyOf(input.target)) !== entry) throw refused('TARGET_REPLACED', 'The Surfing file mount changed before dispatch.') }
    const validate = async () => { assert(); const before = observe(owner, input.target).result.revision; if (context.validateBeforeRun && !await context.validateBeforeRun(fileTargets(input, input.action!.type === 'save'))) throw refused('PERMISSION_DENIED', 'The Surfing file action was denied.'); assert(); if (observe(owner, input.target).result.revision !== before) throw refused('REVISION_CONFLICT', 'Surfing state changed during authorization.') }
    await validate(); if (observe(owner, input.target).result.revision !== input.expectedRevision) throw refused('REVISION_CONFLICT', 'Surfing state changed before dispatch.')
    entry.pending = true
    try { await entry.controller.run(input.action, validate); if (registry(owner).entries.get(keyOf(input.target)) !== entry) throw new Error('The Surfing file mount changed after dispatch.'); return { value: { status: 'queued' as const, target: input.target, action: input.action.type }, revert: null } }
    catch (cause) { if ((cause as { outcome?: string })?.outcome === 'not-applied') throw cause; throw Object.assign(new Error('The Surfing file action dispatched without confirmed effect; inspect its original execution and retained draft instead of replaying.'), { code: 'EFFECT_UNVERIFIED', outcome: 'unknown', retryable: false, cause }) }
    finally { entry.pending = false; entry.signature = ''; entry.revision = `${registry(owner).identity}:${++registry(owner).sequence}` }
  }
  const offs = [inspect]
  for (const route of ['control', 'save'] as const) offs.push(owner.commands.register({ id: `file-view-${route}`, label: 'Surfing: change exact file viewer or save observed shortcut', sideEffect: 'write', paletteSafe: false, input: { schema: inputSchema(route), parse: raw => parse(raw, route) }, outputSchema: object({ status: { const: 'queued' }, target: targetSchema, action: text(256) }), fileTargets: input => fileTargets(input, route === 'save'), revision: input => observe(owner, input.target).result, revisionRequirements: [{ argument: 'expectedRevision', inspectionCommand: 'surfing:file-view-inspect', description: 'Exact mounted raw shortcut draft, archive generation and HAR selection/page or MHTML anchors.' }], recovery: 'non-replayable', idempotent: false, limits: { requestBytes: 131072, responseBytes: 131072 }, preview: input => input, run: invoke }))
  return () => { offs.forEach(off => off()); registry(owner).entries.clear() }
}
