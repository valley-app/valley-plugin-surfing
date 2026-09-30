import { z } from 'zod'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import { fetchTarget, WEB_FETCH_TIMEOUT_MS, type WebFetchFailure, type WebFetchResponse } from '../webFetchContract'

const schema = z.object({ url: z.string().min(1).max(8192) }).strict()
const HEADERS = {
  accept: 'text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5',
  'user-agent': 'Mozilla/5.0 (compatible; SurfingFetch/2.0)'
}
let sequence = 0

function failure(error: unknown): WebFetchFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (/address is not allowed|private-network grant|not declared/i.test(message)) return 'blocked'
  if (/timed out/i.test(message)) return 'timeout'
  if (/response limit exceeded/i.test(message)) return 'tooLarge'
  if (/redirect/i.test(message)) return 'redirect'
  return 'network'
}

function byteLength(base64: string): number {
  return Math.max(0, base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0))
}

export async function fetchUrl(
  api: PluginBackendApi,
  raw: unknown,
  cancellation: PluginBackendOperationContext['cancellation']
): Promise<WebFetchResponse | { error: WebFetchFailure; message?: string }> {
  const url = fetchTarget(schema.parse(raw).url)
  if (!url) return { error: 'url' }
  cancellation.throwIfAborted()
  const requestId = `surfing-fetch-${Date.now().toString(36)}-${(sequence++).toString(36)}`
  const cancel = (): void => { void api.network.cancel(requestId).catch(() => {}) }
  cancellation.addEventListener('abort', cancel, { once: true })
  try {
    const response = await api.network.fetch({ url, method: 'GET', headers: HEADERS, requestId, timeoutMs: WEB_FETCH_TIMEOUT_MS })
    cancellation.throwIfAborted()
    const contentType = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''
    return { url, status: response.status, contentType, bytes: byteLength(response.bodyBase64), bodyBase64: response.bodyBase64 }
  } catch (error) {
    if (cancellation.aborted) throw error
    return { error: failure(error), message: error instanceof Error ? error.message : String(error) }
  } finally {
    cancellation.removeEventListener('abort', cancel)
  }
}

export function registerFetch(api: PluginBackendApi): () => void {
  return api.rpc.handleOperation('fetch.url', (payload, context) => fetchUrl(api, payload, context.cancellation))
}
