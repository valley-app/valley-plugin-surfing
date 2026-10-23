import { Config, FiltersEngine, parseFilters, type CosmeticFilter, type NetworkFilter, type Request } from '@ghostery/adblocker'

/** The backend runs in a guest with a fixed CPU budget per turn, and building one engine from EasyList and EasyPrivacy
 *  takes many times that budget. Lists are therefore parsed in line chunks and indexed as small shard engines, one step
 *  per turn; a core engine keeps every special rule (exceptions, $important, redirects, CSP, hide exceptions, resources)
 *  and reads its ordinary blocking and cosmetic rules from the shards, so matching keeps the engine's own semantics.
 *  Blocking rules are indexed as soon as a shard's worth is parsed: holding every parsed rule at once makes the guest's
 *  cycle collector, which walks the whole heap, cost most of a turn by itself. */
export const SHARD_LIMITS = { chunkLines: 2000, networkFilters: 2000, cosmeticFilters: 2000 }

export type Pause = () => Promise<void>
export const nextTurn: Pause = () => new Promise((resolve) => setTimeout(resolve, 0))

type Excluded = (filter: NetworkFilter | CosmeticFilter) => boolean
type NetworkBucket = { match(request: Request, excluded: Excluded): NetworkFilter | undefined; matchAll(request: Request, excluded: Excluded): NetworkFilter[] }
type StylesheetOptions = { getBaseRules?: boolean; allowGenericHides?: boolean; hidingStyle?: string }
type CosmeticBucket = {
  getCosmeticsFilters(input: Record<string, unknown>): { filters: CosmeticFilter[]; unhides: CosmeticFilter[] }
  getStylesheetsFromFilters(input: { filters: CosmeticFilter[]; extendedFilters: CosmeticFilter[] }, options: StylesheetOptions): { stylesheet: string; extended: unknown[] }
  getBaseStylesheet(): string
}
type Buckets = { filters: NetworkBucket; cosmetics: CosmeticBucket }
const buckets = (engine: FiltersEngine): Buckets => engine as unknown as Buckets
const DEFAULT_HIDING_STYLE = 'display: none !important;'

/** UTF-8 text from base64 without a per-byte guest loop: escape/decodeURIComponent run natively. Invalid UTF-8 falls back
 *  to TextDecoder over bytes built a slice per turn. */
export async function decodeBase64Text(base64: string, pause: Pause = nextTurn): Promise<string> {
  const binary = atob(base64)
  let text: string
  try { text = decodeURIComponent(escape(binary)) } catch {
    const bytes = new Uint8Array(binary.length)
    for (let start = 0; start < binary.length; start += 262144) {
      if (start) await pause()
      const end = Math.min(binary.length, start + 262144)
      for (let index = start; index < end; index++) bytes[index] = binary.charCodeAt(index)
    }
    await pause()
    return new TextDecoder().decode(bytes)
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Line chunks that never split a `!#if … !#endif` block, so each chunk's preprocessors stay complete. */
export function listChunks(text: string, size = SHARD_LIMITS.chunkLines): string[] {
  const lines = text.split('\n')
  const chunks: string[] = []
  let start = 0
  let depth = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (line.startsWith('!#if')) depth++
    else if (line.startsWith('!#endif') && depth > 0) depth--
    if (depth === 0 && index + 1 - start >= size) { chunks.push(lines.slice(start, index + 1).join('\n')); start = index + 1 }
  }
  if (start < lines.length) chunks.push(lines.slice(start).join('\n'))
  return chunks
}

/** The engine's own bucket routing (FiltersEngine.update): only filters that land in `filters` are ordinary. */
const ordinary = (filter: NetworkFilter): boolean => !filter.isCSP() && !filter.isHtmlFilteringRule() && !filter.isGenericHide() && !filter.isSpecificHide()
  && !filter.isException() && !filter.isImportant() && !filter.isRedirect() && !filter.isRemoveParam()

function groups<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size))
  return result
}

/** `$badfilter` disables a blocking rule by ID at match time (NetworkFilterBucket.isFilterDisabled); the view applies the
 *  IDs from every list to every shard. */
function networkView(shards: FiltersEngine[], badFilterIds: Set<number>): NetworkBucket {
  const allowed = (excluded: Excluded): Excluded => badFilterIds.size ? (filter) => badFilterIds.has((filter as NetworkFilter).getId()) || excluded(filter) : excluded
  return {
    match(request, excluded) {
      const skip = allowed(excluded)
      for (const shard of shards) { const filter = buckets(shard).filters.match(request, skip); if (filter) return filter }
      return undefined
    },
    matchAll: (request, excluded) => { const skip = allowed(excluded); return shards.flatMap((shard) => buckets(shard).filters.matchAll(request, skip)) }
  }
}

/** Every cosmetic shard carries all unhide rules, so each shard's base stylesheet and generic-rule split equal what one
 *  engine would compute for its share of the hide rules. */
function cosmeticView(shards: FiltersEngine[]): CosmeticBucket {
  const base = (): string => shards.map((shard) => buckets(shard).cosmetics.getBaseStylesheet()).filter(Boolean).join('\n\n')
  return {
    getCosmeticsFilters(input) {
      const filters: CosmeticFilter[] = []
      for (const shard of shards) filters.push(...buckets(shard).cosmetics.getCosmeticsFilters(input).filters)
      return { filters, unhides: shards.length ? buckets(shards[0]).cosmetics.getCosmeticsFilters(input).unhides : [] }
    },
    getBaseStylesheet: base,
    getStylesheetsFromFilters(input, options) {
      const hidingStyle = options.hidingStyle ?? DEFAULT_HIDING_STYLE
      let stylesheet = options.getBaseRules === false || options.allowGenericHides === false || !shards.length ? '' : base()
      if (hidingStyle !== DEFAULT_HIDING_STYLE) stylesheet = stylesheet.split(DEFAULT_HIDING_STYLE).join(hidingStyle)
      if (!shards.length) return { stylesheet, extended: [] }
      const rest = buckets(shards[0]).cosmetics.getStylesheetsFromFilters(input, { ...options, getBaseRules: false })
      return { stylesheet: [stylesheet, rest.stylesheet].filter(Boolean).join('\n\n'), extended: rest.extended }
    }
  }
}

export type ShardedParts = { core: FiltersEngine; network: FiltersEngine[]; cosmetic: FiltersEngine[]; badFilterIds: Set<number> }

export function assemble(parts: ShardedParts): FiltersEngine {
  const engine = buckets(parts.core)
  engine.filters = networkView(parts.network, parts.badFilterIds)
  engine.cosmetics = cosmeticView(parts.cosmetic)
  return parts.core
}

/** Parse and index `lists` one bounded step per turn; `resources` (uBlock resources.json) goes to the core as
 *  FiltersEngine.fromLists does. `cancelled` stops between steps. */
export async function buildShards(lists: string[], options: Partial<Config>, resources: string | undefined, pause: Pause = nextTurn,
  cancelled: () => boolean = () => false, limits = SHARD_LIMITS): Promise<ShardedParts | null> {
  const config = new Config(options)
  const networkConfig = new Config({ ...options, loadCosmeticFilters: false })
  const special: NetworkFilter[] = []
  const html: CosmeticFilter[] = []
  const unhides: CosmeticFilter[] = []
  const hides: CosmeticFilter[] = []
  const parts: ShardedParts = { core: undefined as unknown as FiltersEngine, network: [], cosmetic: [], badFilterIds: new Set() }
  let blocking: NetworkFilter[] = []
  const flush = async (minimum: number): Promise<boolean> => {
    while (blocking.length >= minimum && blocking.length) {
      await pause()
      if (cancelled()) return false
      parts.network.push(new FiltersEngine({ networkFilters: blocking.slice(0, limits.networkFilters), config: networkConfig }))
      blocking = blocking.slice(limits.networkFilters)
    }
    return true
  }
  const preprocessors = new Map<string, ReturnType<typeof parseFilters>['preprocessors'][number]>()
  for (const list of lists) {
    for (const chunk of listChunks(list, limits.chunkLines)) {
      await pause()
      if (cancelled()) return null
      const parsed = parseFilters(chunk, config)
      for (const filter of parsed.networkFilters) {
        if (!ordinary(filter)) special.push(filter)
        else if (filter.isBadFilter()) parts.badFilterIds.add(filter.getIdWithoutBadFilter())
        else blocking.push(filter)
      }
      for (const filter of parsed.cosmeticFilters) (filter.isHtmlFiltering() ? html : filter.isUnhide() ? unhides : hides).push(filter)
      for (const preprocessor of parsed.preprocessors) {
        const known = preprocessors.get(preprocessor.condition)
        if (known) for (const id of preprocessor.filterIDs) known.filterIDs.add(id)
        else preprocessors.set(preprocessor.condition, preprocessor)
      }
      if (!await flush(limits.networkFilters)) return null
    }
  }
  if (!await flush(1)) return null
  await pause()
  if (cancelled()) return null
  parts.core = new FiltersEngine({ networkFilters: special, cosmeticFilters: html, preprocessors: [...preprocessors.values()], config })
  if (resources !== undefined) { await pause(); parts.core.updateResources(resources, '' + resources.length) }
  for (const group of groups(hides, limits.cosmeticFilters)) {
    await pause()
    if (cancelled()) return null
    parts.cosmetic.push(new FiltersEngine({ cosmeticFilters: [...group, ...unhides], config: new Config({ ...options, loadNetworkFilters: false }) }))
  }
  if (!hides.length && unhides.length) parts.cosmetic.push(new FiltersEngine({ cosmeticFilters: unhides, config: new Config({ ...options, loadNetworkFilters: false }) }))
  return parts
}
