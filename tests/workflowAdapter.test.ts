import Ajv from 'ajv'
import { expect, it, vi } from 'vitest'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import { validateWorkflowContribution, type WorkflowContributionContract } from '@valley/plugin-sdk/workflow'
import { createWorkflowAdapter, executeWorkflowOperation } from '../src/backend/workflow'
import config from '../config.json'

const contract = (config.runtime.services as unknown as Array<{ id: string; metadata?: { workflow?: WorkflowContributionContract } }>).find(service => service.id === 'workflow.provider')!.metadata!.workflow!
function fixture() {
  const schemas = new Map<string, ReturnType<Ajv['compile']>>()
  const rpc = new Map<string, (input: unknown, context?: PluginBackendOperationContext) => unknown>()
  const api = { pluginId: contract.providerId, schema: {
    compile: async ({ schema }: { schema: object | boolean }) => { const handle = crypto.randomUUID(); schemas.set(handle, new Ajv({ strict: false, validateFormats: false, allowUnionTypes: true }).compile(schema)); return { handle, digest: handle } },
    validate: async ({ handle, value }: { handle: string; value: unknown }) => { const validate = schemas.get(handle)!; return { valid: Boolean(validate(value)), issues: [] } },
    release: async (handle: string) => { schemas.delete(handle) }
  }, services: { emit: vi.fn() }, rpc: { emit: vi.fn(), handle: (method: string, handler: (input: unknown) => unknown) => { rpc.set(method, handler); return () => rpc.delete(method) }, handleOperation: (method: string, handler: (input: unknown, context: PluginBackendOperationContext) => unknown) => { rpc.set(method, (input, context) => handler(input, context!)); return () => rpc.delete(method) } } } as unknown as PluginBackendApi
  return { api, rpc }
}
it('publishes an explicit Draft-07 catalogue without executing registered owner handlers', async () => {
  const { api, rpc } = fixture()
  const validated = await validateWorkflowContribution(api, contract)
  expect(contract.nodes.length).toBeGreaterThan(0)
  expect(config.runtime.services.find(service => service.id === 'workflow.catalog')?.operation).toBe(true)
  expect(contract.nodes.every(node => node.parameterSchema.$schema === 'http://json-schema.org/draft-07/schema#' && node.description && node.effect && node.executionMode)).toBe(true)
  expect(contract.nodes.some(node => /credential|password|policy\.patch|plan\.approve/i.test(node.id))).toBe(false)
  let configured = true
  const adapter = createWorkflowAdapter(api, { readiness: () => configured ? { state: 'Available' } : { state: 'Unconfigured', reason: 'Owner configuration is missing' } })
  const handler = vi.fn(() => ({ value: 'owner result' }))
  const off = adapter.operation('fixture.owner', handler)
  await adapter.ready
  const first = await rpc.get('workflow.catalog')!({}, { id: 'catalogue-read', api, cancellation: new AbortController().signal } as PluginBackendOperationContext) as WorkflowContributionContract
  expect(first.nodes.every(node => node.readiness?.state === 'Available')).toBe(true)
  expect(Object.fromEntries(first.nodes.flatMap(node => node.outputs.flatMap(port => port.collection ? [[node.id + ':' + port.id, port.collection.selector]] : [])))).toEqual({"profiles.list:output":"$.profiles","saved.list:output":"$.pages","history.list:output":"$.pages","providers.list:output":"$.providers"})
  configured = false
  const next = await rpc.get('workflow.catalog')!({}, { id: 'catalogue-read', api, cancellation: new AbortController().signal } as PluginBackendOperationContext) as WorkflowContributionContract
  expect(next.nodes.every(node => node.readiness?.state === 'Unconfigured')).toBe(true)
  expect(handler).not.toHaveBeenCalled()
  off(); adapter.dispose(); await validated.dispose()
})
it('passes the authenticated owner and cancellation unchanged and preserves input lineage', async () => {
  const { api } = fixture(), controller = new AbortController()
  const context = { id: 'authenticated-operation', api, cancellation: controller.signal } as PluginBackendOperationContext
  const handler = vi.fn(async () => ({ ok: true, data: { accepted: true } }))
  const binding = { method: 'owner.method', constants: { mode: 'selected' }, inputProperty: 'values', result: 'driver', wrap: false, effect: 'read' }
  const request = { nodeTypeId: 'selected', parameters: { count: 3 }, items: [{ json: { original: true } }] }
  expect(await executeWorkflowOperation(binding, handler, request, context)).toEqual({ items: [{ json: { accepted: true }, pairedItem: { itemIndex: 0 } }] })
  expect(handler).toHaveBeenCalledWith({ mode: 'selected', values: { count: 3 } }, context)
  controller.abort()
  await expect(executeWorkflowOperation(binding, handler, request, context)).rejects.toThrow()
  expect(handler).toHaveBeenCalledOnce()
})
it('retains uncertain accepted effects and never marks fatal failures retryable', async () => {
  const { api } = fixture(), context = { id: 'authenticated-operation', api, cancellation: new AbortController().signal } as PluginBackendOperationContext
  const request = { nodeTypeId: 'selected', parameters: {}, items: [] }
  await expect(executeWorkflowOperation({ method: 'owner.method', result: 'driver', wrap: false, effect: 'execute' }, async () => ({ ok: false, error: 'Receipt was not saved', outcome: 'remote-complete' }), request, context)).rejects.toMatchObject({ outcomeUnknown: true, fatal: true, transient: false, retryable: false })
  expect(await executeWorkflowOperation({ method: 'owner.method', wrap: true, effect: 'read' }, async () => false, request, context)).toEqual({ items: [{ json: { value: false } }] })
})
