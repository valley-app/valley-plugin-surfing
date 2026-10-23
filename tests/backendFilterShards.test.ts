import { afterEach, describe, expect, it, vi } from 'vitest'
import { FiltersEngine, Request, type RequestType } from '@ghostery/adblocker'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { createFilters } from '../src/backend'
import { SHARD_LIMITS, assemble, buildShards, decodeBase64Text, listChunks } from '../src/backend/filterShards'
import { createMockValleyApi } from './mock'

const list = [
  '||ads.example.test^',
  '||tracker.example.test^$third-party',
  '/banner/*/ad.$image',
  '||cdn.example.test/pixel.gif',
  '@@||ads.example.test/allowed.js',
  '||important.example.test^$important',
  '@@||important.example.test^',
  '||redirect.example.test/lib.js$script,redirect=noopjs',
  '||example.test^$csp=script-src \'none\'',
  '@@||quiet.example.test^$csp',
  '||quiet.example.test^$csp=script-src \'none\'',
  '@@||nohide.example.test^$generichide',
  '||blocked-twice.example.test^',
  '||blocked-twice.example.test^$badfilter',
  '!#if env_never',
  '||preprocessed.example.test^',
  '!#endif',
  '##.advert',
  '##.sponsor',
  '###top-ad',
  'example.test##.local-ad',
  'example.test#@#.advert',
  '##a[href^="https://ads.example.test"]',
  'shop.example.test##.promo',
  'shop.example.test#@#.promo',
  'example.test##+js(set-constant, adsEnabled, false)'
].join('\n')
const resources = JSON.stringify({ scriptlets: [{ name: 'set-constant.js', aliases: ['set-constant'], body: 'function setConstant(){}', dependencies: [], executionWorld: 'MAIN', requiresTrust: false }], redirects: [{ name: 'noop.js', aliases: ['noopjs'], body: '(function(){})()', contentType: 'application/javascript' }] })
const tiny = { chunkLines: 4, networkFilters: 2, cosmeticFilters: 2 }
const now = async (): Promise<void> => {}
const requests: Array<[string, string, RequestType]> = [
  ['https://ads.example.test/track.js', 'https://news.test', 'script'],
  ['https://ads.example.test/allowed.js', 'https://news.test', 'script'],
  ['https://tracker.example.test/t.js', 'https://news.test', 'script'],
  ['https://tracker.example.test/t.js', 'https://tracker.example.test', 'script'],
  ['https://img.test/banner/x/ad.png', 'https://news.test', 'image'],
  ['https://cdn.example.test/pixel.gif', 'https://news.test', 'image'],
  ['https://important.example.test/a.js', 'https://news.test', 'script'],
  ['https://redirect.example.test/lib.js', 'https://news.test', 'script'],
  ['https://blocked-twice.example.test/a.js', 'https://news.test', 'script'],
  ['https://preprocessed.example.test/a.js', 'https://news.test', 'script'],
  ['https://clean.test/app.js', 'https://news.test', 'script']
]
const selectors = (styles: string): string[] => [...new Set(styles.split(/[\n,{}]/).map((part) => part.trim()).filter((part) => part && !part.includes(':')))].sort()

async function sharded(text = list, limits = tiny): Promise<FiltersEngine> {
  const parts = await buildShards([text], { enableCompression: true }, resources, now, () => false, limits)
  return assemble(parts!)
}

afterEach(() => vi.restoreAllMocks())

describe('sharded filter engine', () => {
  it('matches requests exactly like one engine built from the same lists', async () => {
    const whole = FiltersEngine.parse(list, { enableCompression: true })
    whole.updateResources(resources, '' + resources.length)
    const shards = await sharded()
    for (const [url, sourceUrl, type] of requests) {
      const request = () => Request.fromRawDetails({ url, sourceUrl, type })
      const expected = whole.match(request())
      const actual = shards.match(request())
      expect({ url, match: actual.match, redirect: actual.redirect?.dataUrl, exception: Boolean(actual.exception) })
        .toEqual({ url, match: expected.match, redirect: expected.redirect?.dataUrl, exception: Boolean(expected.exception) })
    }
    for (const url of ['https://example.test/', 'https://quiet.example.test/']) {
      const request = () => Request.fromRawDetails({ url, type: 'mainFrame' })
      expect(shards.getCSPDirectives(request())).toEqual(whole.getCSPDirectives(request()))
    }
  })

  it('returns the same cosmetic rules, unhides and scriptlets as one engine', async () => {
    const whole = FiltersEngine.parse(list, { enableCompression: true })
    whole.updateResources(resources, '' + resources.length)
    const shards = await sharded()
    for (const url of ['https://example.test/', 'https://shop.example.test/', 'https://nohide.example.test/', 'https://other.test/']) {
      const hostname = new URL(url).hostname
      const input = { url, hostname, domain: hostname.split('.').slice(-2).join('.'), classes: ['advert', 'sponsor', 'promo', 'local-ad'], ids: ['top-ad'], hrefs: ['https://ads.example.test/x'] }
      const expected = whole.getCosmeticsFilters(input)
      const actual = shards.getCosmeticsFilters(input)
      expect({ url, styles: selectors(actual.styles), scripts: actual.scripts.length }).toEqual({ url, styles: selectors(expected.styles), scripts: expected.scripts.length })
    }
  })

  it('never splits a preprocessor block across parse chunks', () => {
    const chunks = listChunks(['a', '!#if env_never', 'b', 'c', 'd', '!#endif', 'e'].join('\n'), 2)
    expect(chunks.find((chunk) => chunk.includes('!#if'))).toContain('!#endif')
    expect(chunks.join('\n').split('\n')).toHaveLength(7)
  })

  it('decodes base64 UTF-8 text without a byte loop and strips a byte-order mark', async () => {
    const encode = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    expect(await decodeBase64Text(encode('﻿||ä.test^\n##.wérbung'))).toBe('||ä.test^\n##.wérbung')
    expect(await decodeBase64Text(btoa('\xff\xfe ok'), now)).toBe(new TextDecoder().decode(new Uint8Array([0xff, 0xfe, 0x20, 0x6f, 0x6b])))
  })

  it('indexes a large list as bounded engine steps, each in its own turn, through the filter RPC', async () => {
    const rules = Array.from({ length: 9000 }, (_, index) => index % 3 ? `||host${index}.example.test^` : `example${index}.test##.ad-${index}`).join('\n')
    const mock = createMockValleyApi({ manifest: { id: 'surfing' } })
    const network = { fetch: vi.fn(async ({ url }: { url: string }) => ({ status: 200, headers: {}, bodyBase64: btoa(url.endsWith('resources.json') ? resources : rules) })) }
    const api = { data: mock.api.data, network, rpc: { handle: vi.fn(() => () => {}), emit: vi.fn() } } as unknown as PluginBackendApi
    const sizes: number[] = []
    const update = FiltersEngine.prototype.update
    vi.spyOn(FiltersEngine.prototype, 'update').mockImplementation(function (this: FiltersEngine, input, env) {
      sizes.push((input.newNetworkFilters?.length ?? 0) + (input.newCosmeticFilters?.length ?? 0))
      return update.call(this, input, env)
    })
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const filters = createFilters(api)
    await filters.configure({ profiles: [{ partition: 'persist:p', enabled: true, rules: 'https://filters.example.test/list.txt', frequencyDays: 7 }] })
    expect(await filters.request({ partition: 'persist:p', url: 'https://host1.example.test/a.js', type: 'script', method: 'GET', sourceUrl: 'https://news.test' })).toEqual({ cancel: true })
    expect(Math.max(...sizes)).toBeLessThanOrEqual(Math.max(SHARD_LIMITS.networkFilters, SHARD_LIMITS.cosmeticFilters))
    expect(sizes.length).toBeGreaterThanOrEqual(5)
    expect(timeout.mock.calls.filter(([, delay]) => !delay).length).toBeGreaterThanOrEqual(sizes.length)
  })
})
