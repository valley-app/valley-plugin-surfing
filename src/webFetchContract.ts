export const WEB_FETCH_TIMEOUT_MS = 30_000
export type WebFetchFailure = 'url' | 'blocked' | 'timeout' | 'tooLarge' | 'redirect' | 'network'
export type WebFetchResponse = { url: string; status: number; contentType: string; bytes: number; bodyBase64: string }

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** The URL a fetch requests: plain HTTP is upgraded to HTTPS except on an exact loopback host (127.0.0.1, localhost, [::1]), and credentials, other schemes and fragments are refused or dropped. */
export function fetchTarget(input: string): string | null {
  let url: URL
  try { url = new URL(input.trim()) } catch { return null }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) url = new URL(`https:${url.href.slice(5)}`)
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) return null
  url.hash = ''
  return url.href
}
