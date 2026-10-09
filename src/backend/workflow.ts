import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import { registerWorkflowContribution, type WorkflowContributionContract, type WorkflowExecutionRequest, type WorkflowContributionRegistrationOptions } from '@valley/plugin-sdk/workflow'
import config from '../../config.json'

type Handler = (input: unknown, context: PluginBackendOperationContext) => unknown | Promise<unknown>
type Binding = { method: string; constants?: Record<string, unknown>; inputProperty?: string; result?: string; wrap: boolean; effect: string }
const bindings: Record<string, Binding> = {
  "fetch.url": {
    "method": "fetch.url",
    "wrap": true,
    "effect": "read"
  },
  "profiles.list": {
    "method": "command.profiles.list",
    "wrap": false,
    "effect": "read"
  },
  "saved.list": {
    "method": "command.saved.list",
    "wrap": false,
    "effect": "read"
  },
  "history.list": {
    "method": "command.history.list",
    "wrap": false,
    "effect": "read"
  },
  "providers.list": {
    "method": "command.providers.list",
    "wrap": false,
    "effect": "read"
  }
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

export async function executeWorkflowOperation(binding: Binding, handler: Handler, request: WorkflowExecutionRequest, context: PluginBackendOperationContext) {
  context.cancellation.throwIfAborted()
  const input = binding.inputProperty ? { ...binding.constants, [binding.inputProperty]: request.parameters } : { ...request.parameters, ...binding.constants }
  let value: unknown
  try { value = await handler(input, context) }
  catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    const details = failure as Error & { fatal?: boolean; transient?: boolean; retryable?: boolean; outcome?: string; outcomeUnknown?: boolean }
    const unknown = details.outcome === 'unknown' || details.outcomeUnknown === true || binding.effect === 'execute' && details.outcome !== 'not-applied'
    if (details.fatal === undefined) details.fatal = true
    if (details.transient === undefined) details.transient = false
    if (details.retryable === undefined || unknown || details.fatal) details.retryable = false
    if (unknown) { details.outcome = 'unknown'; details.outcomeUnknown = true }
    throw failure
  }
  if (binding.result === 'driver') {
    if (!object(value) || value.ok !== true) {
      const unknown = object(value) && (value.outcome === 'unknown' || value.outcome === 'remote-complete') || binding.effect === 'execute' && !(object(value) && value.outcome === 'not-applied')
      throw Object.assign(new Error(object(value) && typeof value.error === 'string' ? value.error : 'Provider operation failed'), { code: object(value) && typeof value.code === 'string' ? value.code : 'PROVIDER_FAILED', fatal: true, transient: false, retryable: false, ...(unknown ? { outcome: 'unknown', outcomeUnknown: true } : {}) })
    }
    value = value.data ?? null
  } else if (binding.result === 'command') {
    if (!object(value) || !Object.hasOwn(value, 'value')) throw Object.assign(new Error('Provider receipt has no confirmed value'), { code: 'PROVIDER_INVALID_RESULT', outcome: 'unknown', outcomeUnknown: true, fatal: true, transient: false, retryable: false })
    value = value.value
  }
  const json = binding.wrap ? { value: value ?? null } : value
  if (!object(json)) throw Object.assign(new Error('Provider result is not a JSON object'), { code: 'PROVIDER_INVALID_RESULT', outcome: 'unknown', outcomeUnknown: true, fatal: true, transient: false, retryable: false })
  return { items: [{ json: JSON.parse(JSON.stringify(json)) as Record<string, unknown>, ...(request.items.length ? { pairedItem: { itemIndex: 0 } } : {}) }] }
}

export function createWorkflowAdapter(api: PluginBackendApi, options: WorkflowContributionRegistrationOptions = {}) {
  const handlers = new Map<string, Handler>()
  const operation: PluginBackendApi['rpc']['handleOperation'] = (method, handler) => {
    handlers.set(method, handler)
    const off = api.rpc.handleOperation(method, handler)
    return () => { if (handlers.get(method) === handler) handlers.delete(method); off() }
  }
  const local = (method: string, handler: Handler) => { handlers.set(method, handler); return () => { if (handlers.get(method) === handler) handlers.delete(method) } }
  const run = (method: string, input: unknown, context: PluginBackendOperationContext) => {
    const handler = handlers.get(method)
    if (!handler) throw Object.assign(new Error('Workflow backend operation is unavailable'), { code: 'PROVIDER_UNAVAILABLE', fatal: true, transient: false, retryable: false })
    return handler(input, context)
  }
  const contract = (config.runtime.services as unknown as Array<{ id: string; metadata?: { workflow?: WorkflowContributionContract } }>).find(service => service.id === 'workflow.provider')!.metadata!.workflow!
  const contribution = registerWorkflowContribution(api, contract, (request, context) => {
    const binding = bindings[request.nodeTypeId]
    if (!binding) throw new Error('Unknown registered Workflow block')
    return executeWorkflowOperation(binding, (input, scoped) => run(binding.method, input, scoped), request, context)
  }, options)
  void contribution.ready.catch(error => api.rpc.emit?.('workflow.registrationFailed', { message: error instanceof Error ? error.message : String(error) }))
  return { operation, local, run, ready: contribution.ready, dispose: contribution.dispose, emit: contribution.emit }
}
