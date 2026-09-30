import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import { z } from 'zod'
import { ARCHIVE_MAX_BYTES, type ArchiveReadResult, type ArchiveFailure } from '../archives'

const schema = z.object({
  relPath: z.string().min(1).max(4096).refine(path => !path.startsWith('/') && !/[\\\0]/.test(path) && !path.split('/').some(part => part === '..' || part === '.valley') && /\.(mhtml|mht|har)$/i.test(path)),
  offset: z.number().int().min(0).max(ARCHIVE_MAX_BYTES),
  expected: z.object({ size: z.number().int().nonnegative(), mtimeMs: z.number().finite() }).strict().optional()
}).strict()

export async function readArchiveChunk(api: PluginBackendApi, raw: unknown, cancellation: PluginBackendOperationContext['cancellation']): Promise<ArchiveReadResult | { error: ArchiveFailure }> {
  const input = schema.parse(raw)
  cancellation.throwIfAborted()
  let handle: string | undefined
  try {
    const grant = await api.storage.open({ area: 'vault', path: input.relPath, kind: 'file', mode: 'read' })
    handle = grant.handle
    cancellation.throwIfAborted()
    const location = { handle, path: '' }
    const before = await api.storage.stat(location)
    if (!before || before.kind !== 'file') return { error: 'readError' }
    if (before.size > ARCHIVE_MAX_BYTES) return { error: 'tooLarge' }
    if (input.expected && (input.expected.size !== before.size || input.expected.mtimeMs !== before.mtimeMs)) return { error: 'changed' }
    cancellation.throwIfAborted()
    const chunk = await api.storage.readBytes(location, { offset: input.offset, maxBytes: 512 * 1024 })
    cancellation.throwIfAborted()
    const after = await api.storage.stat(location)
    if (!after || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return { error: 'changed' }
    return { ...chunk, size: before.size, mtimeMs: before.mtimeMs }
  } catch (error) {
    if (cancellation.aborted) throw error
    return { error: 'readError' }
  } finally { if (handle) await api.storage.close(handle) }
}

export function registerArchiveReader(api: PluginBackendApi): () => void {
  return api.rpc.handleOperation('archive.readChunk', (payload, context) => readArchiveChunk(api, payload, context.cancellation))
}
