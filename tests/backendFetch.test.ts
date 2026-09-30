import { describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { fetchUrl } from '../src/backend/fetch'

function backend(fetch: (request: { url: string; requestId?: string }) => Promise<unknown>) {
  const network = { fetch: vi.fn(fetch), cancel: vi.fn(async () => true) }
  return { network, api: { network } as unknown as PluginBackendApi }
}

describe('backend URL fetch', () => {
  it('upgrades plain HTTP to HTTPS and reports the response facts', async () => {
    const { api, network } = backend(async () => ({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, bodyBase64: btoa('<p>Moss</p>') }))
    const result = await fetchUrl(api, { url: 'http://forest.example/moss#top' }, new AbortController().signal)
    expect(network.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://forest.example/moss', method: 'GET', timeoutMs: 30_000 }))
    expect(result).toEqual({ url: 'https://forest.example/moss', status: 200, contentType: 'text/html; charset=utf-8', bytes: 11, bodyBase64: btoa('<p>Moss</p>') })
  })

  it('refuses non-HTTP schemes and URL credentials without a request', async () => {
    const { api, network } = backend(async () => ({ status: 200, headers: {}, bodyBase64: '' }))
    for (const url of ['ftp://forest.example/file', 'javascript:alert(1)', 'https://user:secret@forest.example/', 'not a url']) {
      expect(await fetchUrl(api, { url }, new AbortController().signal)).toEqual({ error: 'url' })
    }
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it('classifies host network failures', async () => {
    const cases: Array<[string, string]> = [
      ['Endpoint address is not allowed', 'blocked'],
      ['HTTP request timed out', 'timeout'],
      ['HTTP response limit exceeded', 'tooLarge'],
      ['Only HTTPS redirects are allowed', 'redirect'],
      ['getaddrinfo ENOTFOUND forest.example', 'network']
    ]
    for (const [message, code] of cases) {
      const { api } = backend(async () => { throw new Error(message) })
      expect(await fetchUrl(api, { url: 'https://forest.example/' }, new AbortController().signal)).toMatchObject({ error: code })
    }
  })

  it('cancels the host request when the operation is cancelled', async () => {
    const controller = new AbortController()
    let requestId: string | undefined
    const { api, network } = backend(async (request) => {
      requestId = request.requestId
      controller.abort(new Error('Cancelled'))
      throw new Error('Network request cancelled')
    })
    await expect(fetchUrl(api, { url: 'https://forest.example/' }, controller.signal)).rejects.toThrow('Network request cancelled')
    expect(requestId).toMatch(/^surfing-fetch-/)
    expect(network.cancel).toHaveBeenCalledWith(requestId)
  })
})
