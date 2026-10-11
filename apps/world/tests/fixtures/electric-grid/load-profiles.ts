import { municipalityLoadGroups, priceAreas } from '../../../src/packs/electric-grid/schemas/grid-ids.ts'
import { validateGridLoadProfiles, type GridLoadProfiles } from '../../../src/packs/electric-grid/schemas/grid-load-profile.ts'

// A Grid Load Profiles set for test models, with declared (not measured) shapes: private demand
// rising through the day, business peaking at noon, industry flat; weekends at 0.8, summer at 0.5,
// and each price area 1 % above the one before, so every series differs.

const shapes: Readonly<Record<typeof municipalityLoadGroups[number], (hour: number) => number>> = {
  private: hour => 0.8 + 0.2 * hour / 23,
  business: hour => 1 - 0.3 * Math.abs(hour - 12) / 12,
  industry: () => 1,
}

const record = <K extends string, V>(keys: ReadonlyArray<K>, value: (key: K, index: number) => V): Record<K, V> =>
  Object.fromEntries(keys.map((key, index) => [key, value(key, index)])) as Record<K, V>

const dayType = (scale: number) => record(priceAreas, (_, areaIndex) => record(municipalityLoadGroups, group =>
  Array.from({ length: 24 }, (_, hour) => Math.round(scale * (1 + 0.01 * areaIndex) * shapes[group](hour) * 10_000) / 10_000)))

export const fixtureLoadProfiles = (config: { readonly id: string; readonly modelId: string; readonly referenceHour: string }): GridLoadProfiles => validateGridLoadProfiles({
  schemaVersion: 1,
  id: config.id,
  modelId: config.modelId,
  timeZone: 'Europe/Oslo',
  referenceHour: config.referenceHour,
  normalisation: 'test fixture: declared shapes, not measured',
  groupComposition: { private: ['household', 'cabin'], business: ['tertiary'], industry: ['primary', 'secondary'] },
  siteLoads: 'test fixture: major-site loads follow the industry profile of their price area',
  sources: [{ sourceId: 'test:declared-load-profiles', url: 'https://example.test/load-profiles', retrievedAt: '2026-10-11T00:00:00Z', sha256: '0'.repeat(64), licence: 'test fixture' }],
  seasons: {
    winter: { week: { startDate: '2026-01-12', endDate: '2026-01-19' }, weekday: dayType(1), weekend: dayType(0.8) },
    summer: { week: { startDate: '2026-07-06', endDate: '2026-07-13' }, weekday: dayType(0.5), weekend: dayType(0.4) },
  },
}, `fixture ${config.id}`)

/** The v2 test fixture model's (tests/fixtures/grid-model-v2.fixture.json) reference hour, a winter Thursday 17:00. */
export const v2FixtureReferenceHour = '2026-01-15T17:00:00+01:00'
/** The Load Profiles of the v2 test fixture model. */
export const v2FixtureLoadProfiles: GridLoadProfiles = fixtureLoadProfiles({ id: 'electric-grid.test.v2-fixture.load-profiles', modelId: 'electric-grid.test.v2-fixture', referenceHour: v2FixtureReferenceHour })
/** The demand of an Operating Point of the v2 test fixture model at its reference hour. */
export const v2FixtureDemand = { season: 'winter', referenceHour: v2FixtureReferenceHour } as const
