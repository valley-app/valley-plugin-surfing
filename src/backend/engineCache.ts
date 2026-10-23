import { ENGINE_VERSION, FiltersEngine, Resources } from '@ghostery/adblocker'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { z } from 'zod'
import { SHARD_LIMITS, nextTurn, type Pause, type ShardedParts } from './filterShards'

/** Serialized shard engines in owner-local text files, so a backend start loads the ad-block engine instead of rebuilding
 *  it from the lists (about 15 s of guest turns). One file per shard keeps each decode within a bounded number of turns.
 *  Every file starts with the write's generation and the manifest, written last, names that generation and each file's
 *  byte length, so a partial or mixed write never loads; the engine's own checksum (Config.integrityCheck) catches
 *  damaged bytes. Hashing the text instead would push megabytes through the guest's TextEncoder bridge. Anything that
 *  does not check out makes the caller build from the lists as before. */
export const ENGINE_CACHE_FORMAT = 2
const BYTES_PER_TURN = 256 * 1024
const ENCODE_SLICE = 3 * 8192

type Files = PluginBackendApi['data']['files']
type Kind = 'core' | 'network' | 'cosmetic'
export type ListStamp = { url: string; at: number }
const manifestSchema = z.object({
  format: z.literal(ENGINE_CACHE_FORMAT),
  engineVersion: z.number(),
  shardLimits: z.object({ chunkLines: z.number(), networkFilters: z.number(), cosmeticFilters: z.number() }).strict(),
  lists: z.array(z.object({ url: z.string(), at: z.number() }).strict()),
  generation: z.string().min(1).max(64),
  badFilterIds: z.array(z.number()),
  files: z.array(z.object({ name: z.string(), kind: z.enum(['core', 'network', 'cosmetic']), bytes: z.number().int().min(0) }).strict())
}).strict()
export type EngineManifest = z.infer<typeof manifestSchema>
export type SerializedCore = { bytes: Uint8Array }

export const sha256 = async (value: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
export const engineCacheDirectory = async (configurationKey: string): Promise<string> => `filter-engine/${await sha256(configurationKey)}`

/** Base64 of `bytes`, at most BYTES_PER_TURN per turn; slices are multiples of 3 bytes so their base64 concatenates. */
export async function encodeBytes(bytes: Uint8Array, pause: Pause = nextTurn): Promise<string> {
  const pieces: string[] = []
  for (let start = 0; start < bytes.length; start += ENCODE_SLICE) {
    if (start && start % BYTES_PER_TURN < ENCODE_SLICE) await pause()
    pieces.push(btoa(String.fromCharCode.apply(null, bytes.subarray(start, start + ENCODE_SLICE) as unknown as number[])))
  }
  return pieces.join('')
}

/** Bytes from base64; atob runs natively, the per-byte copy runs at most BYTES_PER_TURN per turn. */
export async function decodeBytes(base64: string, pause: Pause = nextTurn): Promise<Uint8Array> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let start = 0; start < binary.length; start += BYTES_PER_TURN) {
    if (start) await pause()
    const end = Math.min(binary.length, start + BYTES_PER_TURN)
    for (let index = start; index < end; index++) bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** The core has to be serialized before `assemble` replaces its blocking and cosmetic buckets with the shard views. Its
 *  resources are left out: serializing them takes longer than a guest turn, while updateResources from the cached
 *  resources list takes milliseconds, so the loader applies them again. */
export const serializeCore = (parts: ShardedParts): SerializedCore => {
  const core = parts.core as unknown as { resources: Resources }
  const resources = core.resources
  core.resources = new Resources()
  try { return { bytes: parts.core.serialize() } } finally { core.resources = resources }
}

const sameLimits = (limits: EngineManifest['shardLimits']): boolean => limits.chunkLines === SHARD_LIMITS.chunkLines
  && limits.networkFilters === SHARD_LIMITS.networkFilters && limits.cosmeticFilters === SHARD_LIMITS.cosmeticFilters

export async function readManifest(files: Files, directory: string): Promise<EngineManifest | null> {
  const text = await files.readText(`${directory}/manifest.json`)
  if (!text) return null
  const parsed = manifestSchema.safeParse((() => { try { return JSON.parse(text) } catch { return null } })())
  if (!parsed.success || parsed.data.engineVersion !== ENGINE_VERSION || !sameLimits(parsed.data.shardLimits)) return null
  if (parsed.data.files.filter((file) => file.kind === 'core').length !== 1) return null
  return parsed.data
}

/** Loads the shard engines one file per step. Returns null when there is no usable cache; throws on a damaged file. */
export async function loadParts(files: Files, directory: string, pause: Pause = nextTurn, cancelled: () => boolean = () => false): Promise<{ parts: ShardedParts; manifest: EngineManifest } | null> {
  const manifest = await readManifest(files, directory)
  if (!manifest) return null
  const parts: ShardedParts = { core: undefined as unknown as FiltersEngine, network: [], cosmetic: [], badFilterIds: new Set(manifest.badFilterIds) }
  for (const file of manifest.files) {
    await pause()
    if (cancelled()) return null
    const text = await files.readText(`${directory}/${file.name}`)
    if (text === null) throw new Error(`Filter engine cache file ${file.name} is missing`)
    const prefix = `${manifest.generation}\n`
    if (!text.startsWith(prefix)) throw new Error(`Filter engine cache file ${file.name} belongs to another write`)
    const bytes = await decodeBytes(text.slice(prefix.length), pause)
    if (bytes.length !== file.bytes) throw new Error(`Filter engine cache file ${file.name} has ${bytes.length} bytes, expected ${file.bytes}`)
    await pause()
    if (cancelled()) return null
    const engine = FiltersEngine.deserialize(bytes)
    if (file.kind === 'core') parts.core = engine
    else parts[file.kind].push(engine)
  }
  return { parts, manifest }
}

const write = async (files: Files, path: string, content: string): Promise<void> => {
  const first = await files.writeTextGuarded(path, content, null)
  if (first.ok) return
  if (first.reason !== 'conflict') throw new Error(`Filter engine cache file ${path} could not be written`)
  // The directory belongs to this configuration only; replace whatever an earlier write left there.
  const second = await files.writeTextGuarded(path, content, first.current)
  if (!second.ok) throw new Error(`Filter engine cache file ${path} changed while it was written`)
}

/** Writes the cache one shard per step: the manifest is invalidated first and written again last, so a reader sees
 *  either the previous complete set, nothing, or the new complete set. */
export async function persistParts(files: Files, directory: string, parts: ShardedParts, core: SerializedCore, lists: ListStamp[],
  pause: Pause = nextTurn, cancelled: () => boolean = () => false): Promise<boolean> {
  const entries: Array<{ name: string; kind: Kind; engine?: FiltersEngine; bytes?: Uint8Array }> = [
    { name: 'core.txt', kind: 'core', bytes: core.bytes },
    ...parts.network.map((engine, index) => ({ name: `n-${index}.txt`, kind: 'network' as const, engine })),
    ...parts.cosmetic.map((engine, index) => ({ name: `c-${index}.txt`, kind: 'cosmetic' as const, engine }))
  ]
  if (await files.readText(`${directory}/manifest.json`) !== null) await write(files, `${directory}/manifest.json`, JSON.stringify({ format: 0 }))
  const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const written: EngineManifest['files'] = []
  for (const entry of entries) {
    await pause()
    if (cancelled()) return false
    const bytes = entry.bytes ?? entry.engine!.serialize()
    const text = await encodeBytes(bytes, pause)
    await pause()
    if (cancelled()) return false
    await write(files, `${directory}/${entry.name}`, `${generation}\n${text}`)
    written.push({ name: entry.name, kind: entry.kind, bytes: bytes.length })
  }
  if (cancelled()) return false
  const manifest: EngineManifest = { format: ENGINE_CACHE_FORMAT, engineVersion: ENGINE_VERSION, shardLimits: { ...SHARD_LIMITS },
    lists: [...lists].sort((a, b) => a.url.localeCompare(b.url)), generation, badFilterIds: [...parts.badFilterIds], files: written }
  await write(files, `${directory}/manifest.json`, JSON.stringify(manifest))
  return true
}
