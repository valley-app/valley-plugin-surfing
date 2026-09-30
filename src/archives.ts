import { z } from 'zod'

export const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024
export type ArchiveReadResult = { base64: string; nextOffset: number; done: boolean; size: number; mtimeMs: number }
export type ArchiveFailure = 'readError' | 'invalid' | 'tooLarge' | 'changed'
export class ArchiveError extends Error {
  constructor(readonly code: ArchiveFailure) { super(code) }
}

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/\s/g, '')), character => character.charCodeAt(0))
}

export function binaryString(bytes: Uint8Array): string {
  let value = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) value += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return value
}

export function contentType(value: string): { type: string; parameters: Record<string, string> } {
  const parameters: Record<string, string> = Object.create(null)
  for (const match of value.matchAll(/;\s*([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;\s]+))/g)) {
    parameters[match[1].toLowerCase()] = match[2]?.replace(/\\(.)/g, '$1') ?? match[3]
  }
  return { type: value.split(';')[0].trim().toLowerCase(), parameters }
}

export function decodeText(bytes: Uint8Array, charset = 'utf-8'): string {
  try { return new TextDecoder(charset).decode(bytes) } catch { throw new ArchiveError('invalid') }
}

export type ArchivePart = { type: string; charset?: string; location: string; id: string; bytes: Uint8Array }
export type MhtmlArchive = { root: ArchivePart; parts: ArchivePart[] }
const cid = (value: string): string => value.trim().replace(/^<|>$/g, '')
export function resolveArchiveUrl(value: string, base: string): string {
  try { return new URL(value, base).href } catch { return value }
}

export function parseMhtml(bytes: Uint8Array): MhtmlArchive {
  const parts: ArchivePart[] = []
  let count = 0
  const parse = (source: string, base: string, depth: number): ArchivePart | undefined => {
    if (depth > 20 || ++count > 10000) throw new ArchiveError('tooLarge')
    const split = /\r?\n\r?\n/.exec(source)
    if (!split) throw new ArchiveError('invalid')
    const headers: Record<string, string> = Object.create(null)
    for (const line of source.slice(0, split.index).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
      const colon = line.indexOf(':')
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
    }
    const body = source.slice(split.index + split[0].length)
    const { type, parameters } = contentType(headers['content-type'] ?? 'text/plain')
    const location = resolveArchiveUrl(headers['content-location'] ?? '', headers['content-base'] ? resolveArchiveUrl(headers['content-base'], base) : base)
    if (type.startsWith('multipart/')) {
      const boundary = parameters.boundary
      if (!boundary || boundary.length > 200) throw new ArchiveError('invalid')
      const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const markers = [...body.matchAll(new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g'))]
      if (markers.length < 2 || !markers.at(-1)?.[1]) throw new ArchiveError('invalid')
      const children: ArchivePart[] = []
      for (let index = 0; index < markers.length - 1; index++) {
        const marker = markers[index]
        if (marker[1]) break
        const child = parse(body.slice(marker.index! + marker[0].length, markers[index + 1].index).replace(/^\r?\n/, ''), location || base, depth + 1)
        if (child) children.push(child)
      }
      if (parameters.start) return children.find(part => part.id === cid(parameters.start))
      return type === 'multipart/alternative' ? children.find(part => part.type === 'text/html') ?? children[0] : children[0]
    }
    let decoded: Uint8Array
    const encoding = (headers['content-transfer-encoding'] ?? '8bit').toLowerCase()
    if (encoding === 'base64') decoded = fromBase64(body)
    else if (encoding === 'quoted-printable') {
      const unfolded = body.replace(/=\r?\n/g, '')
      if (/=(?![a-f\d]{2})/i.test(unfolded)) throw new ArchiveError('invalid')
      decoded = Uint8Array.from(unfolded.replace(/=([a-f\d]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), char => char.charCodeAt(0))
    } else if (['7bit', '8bit', 'binary'].includes(encoding)) decoded = Uint8Array.from(body, char => char.charCodeAt(0))
    else throw new ArchiveError('invalid')
    const part = { type, charset: parameters.charset, location, id: cid(headers['content-id'] ?? ''), bytes: decoded }
    parts.push(part)
    return part
  }
  try {
    const root = parse(binaryString(bytes), 'https://archive.invalid/', 0)
    if (!root || root.type !== 'text/html') throw new ArchiveError('invalid')
    return { root, parts }
  } catch (error) { throw error instanceof ArchiveError ? error : new ArchiveError('invalid') }
}

const pairs = z.array(z.object({ name: z.string(), value: z.string() }).passthrough()).default([])
const number = z.number().finite()
const entrySchema = z.object({
  startedDateTime: z.string().optional(), time: number.optional(),
  request: z.object({ method: z.string(), url: z.string(), headers: pairs, cookies: pairs, queryString: pairs,
    postData: z.object({ mimeType: z.string().optional(), text: z.string().optional(), params: z.array(z.object({ name: z.string(), value: z.string().optional(), fileName: z.string().optional() }).passthrough()).optional() }).passthrough().optional()
  }).passthrough(),
  response: z.object({ status: number, statusText: z.string().optional(), headers: pairs, cookies: pairs, bodySize: number.optional(),
    content: z.object({ size: number.optional(), mimeType: z.string().optional(), text: z.string().optional(), encoding: z.string().optional() }).passthrough().default({})
  }).passthrough(),
  timings: z.object({ blocked: number.optional(), dns: number.optional(), connect: number.optional(), ssl: number.optional(), send: number.optional(), wait: number.optional(), receive: number.optional() }).passthrough().optional()
}).passthrough()
export type HarEntry = z.infer<typeof entrySchema>

export function parseHar(bytes: Uint8Array): HarEntry[] {
  try { return z.object({ log: z.object({ entries: z.array(entrySchema) }) }).parse(JSON.parse(decodeText(bytes))).log.entries }
  catch { throw new ArchiveError('invalid') }
}

export function harBody(entry: HarEntry): { kind: 'text' | 'binary' | 'missing' | 'invalid'; text?: string } {
  const content = entry.response.content
  if (content.text === undefined) return { kind: 'missing' }
  const { type, parameters } = contentType(content.mimeType ?? '')
  const textual = !type || /^(text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded)$)/.test(type) || /\+(?:json|xml)$/.test(type)
  try {
    if (content.encoding && content.encoding !== 'base64') return { kind: 'invalid' }
    const bytes = content.encoding === 'base64' ? fromBase64(content.text) : null
    if (!textual) return { kind: 'binary' }
    const text = bytes ? decodeText(bytes, parameters.charset) : content.text
    try { return { kind: 'text', text: JSON.stringify(JSON.parse(text), null, 2) } } catch { return { kind: 'text', text } }
  } catch { return { kind: 'invalid' } }
}
