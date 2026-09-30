import { describe, expect, it } from 'vitest'
import {
  canDeleteProfile,
  canHideProfile,
  DEFAULT_ADBLOCK_FREQUENCY,
  DEFAULT_ADBLOCK_RULES,
  DEFAULT_PROFILE_ID,
  DEFAULT_SETTINGS,
  INCOGNITO_PROFILE_ID,
  incognitoProfile,
  normalizeProfile,
  normalizeSettings,
  reconcileProfiles,
  switcherProfiles,
  type WebProfile
} from '../src/profiles'

const profile = (id: string, patch: Partial<WebProfile> = {}): WebProfile => ({
  id,
  name: id.toUpperCase(),
  createdAt: 1,
  adblockEnabled: true,
  adblockRules: DEFAULT_ADBLOCK_RULES,
  adblockFrequency: DEFAULT_ADBLOCK_FREQUENCY,
  ...patch
})

describe('reconcileProfiles', () => {
  it('carries icon and hidden through a round trip', () => {
    const [fungi, spores] = reconcileProfiles([
      profile('fungi', { icon: 'leaf' }),
      profile('spores', { hidden: true })
    ])
    expect(fungi.icon).toBe('leaf')
    expect(spores.hidden).toBe(true)
  })

  it('omits the flags when they are unset', () => {
    const [fungi] = reconcileProfiles([profile('fungi')])
    expect(fungi).toEqual({
      id: 'fungi',
      name: 'FUNGI',
      createdAt: 1,
      adblockEnabled: true,
      adblockRules: DEFAULT_ADBLOCK_RULES,
      adblockFrequency: DEFAULT_ADBLOCK_FREQUENCY
    })
  })

  it('still pins Default as the fallback and Incognito last', () => {
    const profiles = reconcileProfiles([])
    expect(profiles.map((p) => p.id)).toEqual([DEFAULT_PROFILE_ID, INCOGNITO_PROFILE_ID])
  })

  it('preserves a customized Default alongside additional profiles', () => {
    const profiles = reconcileProfiles([
      profile(DEFAULT_PROFILE_ID, { name: 'Canopy', icon: 'leaf' }),
      profile('fungi')
    ])
    expect(profiles.map((entry) => entry.id)).toEqual([DEFAULT_PROFILE_ID, 'fungi', INCOGNITO_PROFILE_ID])
    expect(profiles[0]).toMatchObject({ name: 'Canopy', icon: 'leaf' })
  })
})

describe('canDeleteProfile', () => {
  it('protects the last normal profile but allows deleting Default when another remains', () => {
    const onlyDefault = reconcileProfiles([])
    expect(canDeleteProfile(onlyDefault, DEFAULT_PROFILE_ID)).toBe(false)
    const withAnother = reconcileProfiles([...onlyDefault, profile('fungi')])
    expect(canDeleteProfile(withAnother, DEFAULT_PROFILE_ID)).toBe(true)
    expect(canDeleteProfile(withAnother, 'fungi')).toBe(true)
    expect(canDeleteProfile(withAnother, INCOGNITO_PROFILE_ID)).toBe(false)
  })
})

describe('normalizeProfile', () => {
  it('reads icon and hidden tolerantly', () => {
    expect(normalizeProfile({ id: 'fungi', name: 'Fungi', icon: ' leaf ', hidden: true })).toEqual({
      id: 'fungi',
      name: 'Fungi',
      createdAt: 0,
      icon: 'leaf',
      hidden: true,
      adblockEnabled: true,
      adblockRules: DEFAULT_ADBLOCK_RULES,
      adblockFrequency: DEFAULT_ADBLOCK_FREQUENCY
    })
  })

  it('drops a blank icon and a non-boolean hidden', () => {
    const p = normalizeProfile({ id: 'fungi', icon: '   ', hidden: 'yes' })
    expect(p).not.toBeNull()
    expect(p?.icon).toBeUndefined()
    expect(p?.hidden).toBeUndefined()
  })
})

describe('switcherProfiles', () => {
  it('lists the shown normal profiles in order, never the private one', () => {
    const profiles = [profile('fungi'), profile('spores', { hidden: true }), incognitoProfile()]
    expect(switcherProfiles(profiles).map((p) => p.id)).toEqual(['fungi'])
  })

  it('falls back to the first normal profile when every one is hidden', () => {
    const profiles = [profile('fungi', { hidden: true }), profile('spores', { hidden: true }), incognitoProfile()]
    expect(switcherProfiles(profiles).map((p) => p.id)).toEqual(['fungi'])
  })
})

describe('canHideProfile', () => {
  it('refuses to hide the last visible profile', () => {
    const profiles = [profile('fungi'), incognitoProfile()]
    expect(canHideProfile(profiles, 'fungi')).toBe(false)
  })

  it('allows hiding while another profile stays visible', () => {
    const profiles = [profile('fungi'), profile('spores'), incognitoProfile()]
    expect(canHideProfile(profiles, 'fungi')).toBe(true)
  })

  it('is irrelevant for an already-hidden profile', () => {
    const profiles = [profile('fungi'), profile('spores', { hidden: true }), incognitoProfile()]
    expect(canHideProfile(profiles, 'spores')).toBe(true)
  })
})

describe('normalizeSettings', () => {
  it('no longer carries a saved-page folder', () => {
    expect(normalizeSettings({ savedPageFolder: 'Web clips' })).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS).not.toHaveProperty('savedPageFolder')
  })

  it('accepts both additional search engines and defaults website new tabs on', () => {
    expect(normalizeSettings({ searchEngine: 'baidu' }).searchEngine).toBe('baidu')
    expect(normalizeSettings({ searchEngine: 'yahoo' }).searchEngine).toBe('yahoo')
    expect(normalizeSettings({}).openWebsiteOnNewTab).toBe(true)
    expect(normalizeSettings({ openWebsiteOnNewTab: false }).openWebsiteOnNewTab).toBe(false)
  })
})
