import { describe, expect, it } from 'vitest'
import { WORKSPACE_DETAILS_V1 } from '@valley/plugin-sdk'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { registerSurfingDetails } from '../src/workspaceDetails'
import type { WebStore, WebTabState } from '../src/store'

describe('website workspace details', () => {
  it('uses the requested instance and trusted main-frame connection state', () => {
    const mock = createMockValleyApi()
    const tabs: Record<string, WebTabState> = {
      first: { url: 'https://good.example/page', title: 'Good', profileId: 'main' },
      second: { url: 'https://old.example', title: 'Second', profileId: 'main', connection: { status: 'certificate-error', url: 'https://bad.example/page', revision: 3 } }
    }
    const store = { getTab: (id: string) => tabs[id], getSnapshot: () => ({ profiles: [{ id: 'main', name: 'Research' }] }), subscribe: () => () => {} } as unknown as WebStore
    const off = registerSurfingDetails(mock.api, store)
    try {
      const provider = mock.api.interop.extensions.providers(WORKSPACE_DETAILS_V1)[0].extension
      const context = { instanceId: 'second', selectedItemIds: ['hostname', 'connection'] }
      expect(provider.getSnapshot(context).items).toMatchObject({ hostname: { text: 'bad.example' }, connection: { text: 'Certificate error' }, profile: { text: 'Research' } })
      expect(provider.getSnapshot({ ...context, instanceId: 'first' }).items.connection.text).toBe('Unavailable')
      expect(provider.getSnapshot({ ...context, instanceId: 'missing' }).items).toEqual({})
      tabs.second.connection = { status: 'loading', url: 'http://redirect.example/', revision: 4 }
      expect(provider.getSnapshot(context).items).toMatchObject({ hostname: { text: 'redirect.example' }, connection: { text: 'Loading' } })
      tabs.second.connection = { status: 'http', url: 'http://redirect.example/', revision: 5 }
      expect(provider.getSnapshot(context).items.connection.text).toBe('HTTP')
    } finally { off() }
  })
})
