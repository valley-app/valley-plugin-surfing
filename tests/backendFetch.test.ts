import { assertCommandOutput } from './commandContracts'
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
    assertCommandOutput('fetch.url', {}, result)
    expect(result).toEqual({ url: 'https://forest.example/moss', status: 200, contentType: 'text/html; charset=utf-8', bytes: 11, bodyBase64: btoa('<p>Moss</p>') })
  })

  it('keeps plain HTTP only for exact loopback hosts', async () => {
    const { api, network } = backend(async () => ({ status: 200, headers: { 'content-type': 'text/plain' }, bodyBase64: btoa('Moos') }))
    for (const [input, expected] of [
      ['http://127.0.0.1:4810/moss#top', 'http://127.0.0.1:4810/moss'],
      ['http://localhost:4810/moss', 'http://localhost:4810/moss'],
      ['http://LOCALHOST:4810/moss', 'http://localhost:4810/moss'],
      ['http://[::1]:4810/moss', 'http://[::1]:4810/moss'],
      ['http://127.0.0.2:4810/moss', 'https://127.0.0.2:4810/moss'],
      ['http://localhost.example/moss', 'https://localhost.example/moss'],
      ['http://evil.localhost/moss', 'https://evil.localhost/moss'],
      ['http://[::2]/moss', 'https://[::2]/moss']
    ]) {
      network.fetch.mockClear()
      expect(await fetchUrl(api, { url: input }, new AbortController().signal)).toMatchObject({ url: expected, status: 200 })
      expect(network.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: expected }))
    }
    expect(await fetchUrl(api, { url: 'http://user:secret@127.0.0.1:4810/' }, new AbortController().signal)).toEqual({ error: 'url' })
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
