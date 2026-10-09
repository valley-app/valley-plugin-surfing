import config from '../config.json'

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const text = { type: 'string', maxLength: 16384 }
const count = { type: 'integer', minimum: 0 }
const array = (items: unknown, maxItems = 10000) => ({ type: 'array', items, maxItems })
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] })
type OwnerContract = { id: string; outputSchema: Record<string, unknown> }
const services = config.runtime.services as Array<{ metadata?: { commands?: OwnerContract[]; command?: OwnerContract } }>
const contracts = services.flatMap(service => service.metadata?.commands ?? (service.metadata?.command ? [service.metadata.command] : []))
function backend(id: string, ...path: string[]): Record<string, unknown> {
  const contract = contracts.find(command => command.id === id)
  if (!contract) throw new Error(`Missing Surfing owner result contract: ${id}`)
  const result = structuredClone(contract.outputSchema)
  delete result.$schema
  let fragment: unknown = result
  for (const key of path) fragment = (fragment as Record<string, unknown>)[key]
  if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) throw new Error(`Missing Surfing owner result fragment: ${id}.${path.join('.')}`)
  return fragment as Record<string, unknown>
}
const profile = backend('profiles.list', 'properties', 'profiles', 'items')
const history = backend('history.list', 'properties', 'pages', 'items')
const providerConfiguration = backend('providers.list')
;(providerConfiguration.properties as Record<string, unknown>).rendererStamp = text
const provider = backend('providers.create', 'properties', 'provider')
const tab = object({ instanceId: text, url: text, title: text })
const opened = object({ instanceId: text, url: text, title: text }, ['instanceId', 'url'])
const action = { anyOf: [object({ info: text }), object({ done: { const: true } })] }
const fetched = object({ url: text, title: text, status: nullable({ type: 'integer', minimum: 100, maximum: 599 }), contentType: text, bytes: count, durationMs: { type: 'number', minimum: 0 }, mode: { enum: ['fetch', 'rendered'] }, cached: { type: 'boolean' }, startIndex: count, nextStartIndex: nullable(count), totalChars: count, content: { type: 'string', maxLength: 50000 }, instanceId: text }, ['url', 'title', 'status', 'contentType', 'bytes', 'durationMs', 'mode', 'cached', 'startIndex', 'nextStartIndex', 'totalChars', 'content'])
const profileId = object({ profileId: text })
const profileSettings = object({ profile, revision: { type: 'string', pattern: '^[a-f0-9]{64}$(?![\\s\\S])' } })
const saved = object({ profileId: text, kind: { enum: ['favorite', 'reading'] }, url: text, title: text, ts: count, position: count })
export const surfingCommandResults: Record<string, Record<string, unknown>> = {
  open: opened, list: object({ tabs: array(object({ ...tab.properties, profileId: text })) }), switch: object({ instanceId: text }), close: object({ instanceId: text }),
  clip: { anyOf: [object({ cancelled: { const: true } }), object({ relPath: text, url: text, title: text })] }, fetch: fetched, 'fetch-rendered': fetched,
  'list-profiles': array(profile), 'read-profile-settings': profileSettings, 'patch-profile-settings': profileSettings,
  'create-profile': profile, 'delete-profile': profileId, 'clear-history': profileId, 'clear-browser-data': profileId, 'read-history': array(history),
  'save-page': object({ profileId: text, kind: { enum: ['favorite', 'reading'] }, url: text }), 'remove-page': object({ profileId: text, kind: { enum: ['favorite', 'reading'] }, url: text }),
  'list-saved-pages': object({ rows: array(saved, 1000), revisions: array(count, 1000), cursor: text, revision: count }, ['rows', 'revision']),
  'list-embed-providers': providerConfiguration, 'create-embed-provider': object({ provider, path: text }), 'customize-embed-provider': object({ provider, path: text }),
  'browser-list-tabs': object({ tabs: array(tab) }), 'browser-open-tab': opened,
  'browser-snapshot': object({ url: text, title: text, count, text: { type: 'string', maxLength: 1048576 }, elements: array(object({ ref: count, role: text, name: text, value: text, disabled: { type: 'boolean' }, inViewport: { type: 'boolean' } }, ['ref', 'role', 'name'])) }),
  'browser-read-page': object({ text: { type: 'string', maxLength: 1048576 } }),
  'browser-screenshot': object({ dataBase64: { type: 'string', maxLength: 16777216 }, mime: { enum: ['image/png', 'image/jpeg', 'image/webp'] } }),
  ...Object.fromEntries(['switch-tab', 'close-tab', 'navigate', 'back', 'forward', 'reload', 'click', 'type', 'select', 'scroll', 'press-key'].map(id => [`browser-${id}`, action]))
}
export function surfingCommandResult(id: string): Record<string, unknown> {
  const result = surfingCommandResults[id]
  if (!result) throw new Error(`Missing Surfing result contract: ${id}`)
  return result
}
