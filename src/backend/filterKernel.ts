import type { PluginBackendApi } from '@valley/plugin-sdk'
import { z } from 'zod'

/** The ad-block engines run in the plugin's Rust module (src/wasm, Brave's adblock engine): matching a request there
 *  takes microseconds, where the guest's JavaScript engine needed a millisecond per request. The module keeps every
 *  engine in a numbered slot; this file moves base64 and JSON in and out, so the guest never loops over bytes. */
export const KERNEL_ID = 'filters'
/** Bumped with the engine crate or the saved-engine layout; older caches are rebuilt from the lists. */
export const ENGINE_FORMAT = 'adblock-0.13.5/1'
/** The module's memory holds this many engines at most; evicted ones reload from the engine cache in milliseconds. */
export const KERNEL_ENGINES = 3
// Saved-engine bytes per `filters_save` piece (src/wasm/src/kernel.rs SAVE_CHUNK).
const SAVE_CHUNK = 3 * 768 * 1024
// Parsing a whole list and indexing every list run in the `filter.build` background operation, whose calls may take up to
// 500 ms; every other call stays within the default 50 ms.
const BUILD_MS = 500

export type Pause = () => Promise<void>
export const nextTurn: Pause = () => new Promise((resolve) => setTimeout(resolve, 0))
type Wasm = PluginBackendApi['wasm']
type Files = PluginBackendApi['data']['files']
type Handle = Awaited<ReturnType<Wasm['instantiate']>>
export type ListStamp = { url: string; at: number }

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const frame = (slot: number, head: number[], body = ''): Uint8Array => {
  const text = encoder.encode(body)
  const bytes = new Uint8Array(4 + head.length + text.length)
  new DataView(bytes.buffer).setUint32(0, slot, true)
  bytes.set(head, 4)
  bytes.set(text, 4 + head.length)
  return bytes
}
const le32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]

export type FilterReply = { cancel?: boolean; redirectURL?: string; appendResponseHeaders?: Record<string, string[]> }
export type CosmeticsReply = { styles: string; scripts: string[] }

/** One module instance shared by every engine. A trap releases the instance with all its engines; `reset` listeners
 *  then forget their slots and the next call instantiates a fresh module. */
export function createFilterKernel(wasm: Wasm) {
  let instance: Promise<Handle> | null = null
  let sequence = 0
  const resets = new Set<() => void>()
  const handle = (): Promise<Handle> => instance ??= wasm.instantiate(KERNEL_ID).catch((error: unknown) => { instance = null; throw error })
  const call = async (exportName: string, input: Uint8Array, api: Wasm = wasm, maxMs?: number): Promise<Uint8Array> => {
    const current = handle()
    const target = await current
    try { return await api.call(target, exportName, input, maxMs === undefined ? undefined : { maxMs }) } catch (error) {
      // The module's own error answer and a refused budget leave the instance usable; a trap releases it.
      const broken = (error as { code?: unknown })?.code === 'PLUGIN_WASM_DISPOSED' || /trapped|aborted/.test(String((error as Error)?.message))
      if (broken && instance === current) {
        instance = null
        void wasm.dispose(target).catch(() => {})
        resets.forEach((reset) => reset())
      }
      throw error
    }
  }
  const json = async <T>(exportName: string, input: Uint8Array): Promise<T> => JSON.parse(decoder.decode(await call(exportName, input))) as T
  return {
    slot: (): number => ++sequence,
    onReset(listener: () => void): () => void { resets.add(listener); return () => resets.delete(listener) },
    /** Parses the lists and indexes them; `background` is the `filter.build` operation's API. */
    async build(slot: number, listsBase64: string[], background: Wasm, pause: Pause = nextTurn): Promise<void> {
      for (const list of listsBase64) {
        await pause()
        await call('filters_add', frame(slot, [], list), background, BUILD_MS)
      }
      await pause()
      await call('filters_build', frame(slot, []), background, BUILD_MS)
    },
    async resources(slot: number, resourcesBase64: string): Promise<void> { await call('filters_resources', frame(slot, [], resourcesBase64)) },
    /** The saved engine as base64 pieces, each complete on its own. */
    async save(slot: number, pause: Pause = nextTurn): Promise<string[]> {
      const pieces: string[] = []
      for (let offset = 0; ; offset += SAVE_CHUNK) {
        if (offset) await pause()
        const piece = decoder.decode(await call('filters_save', frame(slot, le32(offset))))
        pieces.push(piece)
        if (piece.length < SAVE_CHUNK / 3 * 4) return pieces
      }
    },
    async load(slot: number, pieces: string[], pause: Pause = nextTurn): Promise<void> {
      for (let index = 0; index < pieces.length; index++) {
        if (index) await pause()
        await call('filters_load', frame(slot, [index === pieces.length - 1 ? 1 : 0], pieces[index]))
      }
    },
    async drop(slot: number): Promise<void> { if (instance) await call('filters_drop', frame(slot, [])) },
    request: (slot: number, input: { phase?: 'request' | 'response'; url: string; sourceUrl: string; type: string; method: string }): Promise<FilterReply> =>
      json('filters_request', frame(slot, [input.phase === 'response' ? 1 : 0], `${input.url}\n${input.sourceUrl}\n${input.type}\n${input.method}`)),
    cosmetics: (slot: number, input: { url: string; classes?: string[]; ids?: string[]; initial?: boolean }): Promise<CosmeticsReply> =>
      json('filters_cosmetics', frame(slot, [], JSON.stringify({ url: input.url, classes: input.classes ?? [], ids: input.ids ?? [], initial: input.initial !== false })))
  }
}
export type FilterKernel = ReturnType<typeof createFilterKernel>

/** Saved engines in owner-local text files, so a backend start loads the engine instead of parsing the lists. Each piece
 *  file starts with the write's generation; the manifest, written last, names that generation and each piece's length,
 *  so a partial or mixed write never loads, and the engine's own deserializer rejects damaged bytes. */
const manifestSchema = z.object({
  format: z.literal(ENGINE_FORMAT),
  lists: z.array(z.object({ url: z.string(), at: z.number() }).strict()),
  generation: z.string().min(1).max(64),
  files: z.array(z.object({ name: z.string().regex(/^e-\d+\.txt$/), chars: z.number().int().min(0) }).strict()).min(1)
}).strict()
export type EngineManifest = z.infer<typeof manifestSchema>

export const sha256 = async (value: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
export const engineCacheDirectory = async (configurationKey: string): Promise<string> => `filter-engine/${await sha256(configurationKey)}`

export async function readManifest(files: Files, directory: string): Promise<EngineManifest | null> {
  const text = await files.readText(`${directory}/manifest.json`)
  if (!text) return null
  const parsed = manifestSchema.safeParse((() => { try { return JSON.parse(text) } catch { return null } })())
  return parsed.success ? parsed.data : null
}

/** The saved engine's pieces; null when there is no usable cache, an error when a piece is missing or from another write. */
export async function readEngine(files: Files, directory: string): Promise<{ pieces: string[]; manifest: EngineManifest } | null> {
  const manifest = await readManifest(files, directory)
  if (!manifest) return null
  const prefix = `${manifest.generation}\n`
  const pieces: string[] = []
  for (const file of manifest.files) {
    const text = await files.readText(`${directory}/${file.name}`)
    if (text === null) throw new Error(`Filter engine cache file ${file.name} is missing`)
    if (!text.startsWith(prefix) || text.length - prefix.length !== file.chars) throw new Error(`Filter engine cache file ${file.name} belongs to another write`)
    pieces.push(text.slice(prefix.length))
  }
  return { pieces, manifest }
}

const write = async (files: Files, path: string, content: string): Promise<void> => {
  const first = await files.writeTextGuarded(path, content, null)
  if (first.ok) return
  if (first.reason !== 'conflict') throw new Error(`Filter engine cache file ${path} could not be written`)
  // The directory belongs to this configuration only; replace whatever an earlier write left there.
  const second = await files.writeTextGuarded(path, content, first.current)
  if (!second.ok) throw new Error(`Filter engine cache file ${path} changed while it was written`)
}

/** Invalidates the manifest, writes the pieces, then the manifest: a reader sees the previous set, nothing, or this one. */
export async function writeEngine(files: Files, directory: string, pieces: string[], lists: ListStamp[], cancelled: () => boolean = () => false): Promise<boolean> {
  if (await files.readText(`${directory}/manifest.json`) !== null) await write(files, `${directory}/manifest.json`, JSON.stringify({ format: 0 }))
  const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const written: EngineManifest['files'] = []
  for (const [index, piece] of pieces.entries()) {
    if (cancelled()) return false
    await write(files, `${directory}/e-${index}.txt`, `${generation}\n${piece}`)
    written.push({ name: `e-${index}.txt`, chars: piece.length })
  }
  if (cancelled()) return false
  const manifest: EngineManifest = { format: ENGINE_FORMAT, lists: [...lists].sort((a, b) => a.url.localeCompare(b.url)), generation, files: written }
  await write(files, `${directory}/manifest.json`, JSON.stringify(manifest))
  return true
}
