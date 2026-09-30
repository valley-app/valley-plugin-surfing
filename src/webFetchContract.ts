export const WEB_FETCH_TIMEOUT_MS = 30_000
export type WebFetchFailure = 'url' | 'blocked' | 'timeout' | 'tooLarge' | 'redirect' | 'network'
export type WebFetchResponse = { url: string; status: number; contentType: string; bytes: number; bodyBase64: string }

/** The HTTPS URL a fetch requests: plain HTTP is upgraded, and credentials, other schemes and fragments are refused or dropped. */
export function fetchTarget(input: string): string | null {
  let url: URL
  try { url = new URL(input.trim()) } catch { return null }
  if (url.protocol === 'http:') url = new URL(`https:${url.href.slice(5)}`)
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null
  url.hash = ''
  return url.href
}
