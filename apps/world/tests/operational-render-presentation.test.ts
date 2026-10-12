import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat, type IsoTimestamp, type ObjectId, type OperationalObject, type PackId } from '../src/core/model/index.ts'
import type { PackObjectPresentation } from '../src/core/packs/protocol.ts'
import { createMapFeatureStore } from '../src/ui/map-runtime/map-feature-store.ts'
import { createRenderPresentationFor } from '../src/ui/map-runtime/operational-render-controller.ts'

const at = '2026-10-12T08:00:00.000Z' as IsoTimestamp

const unitOf = (id: string, group: string): OperationalObject => ({
  id: id as ObjectId,
  kind: 'mobile_entity',
  packId: 'fixture' as PackId,
  label: id,
  lifecycle: 'active',
  revision: 3,
  spatial: { frame: { kind: 'wgs84' }, position: { point: geoPointFromLonLat(11.3, 59.12), observedAt: at } },
  operational: { status: 'normal', mode: 'simulated' },
  alerts: [],
  provenance: { source: 'simulator' },
  timestamps: { createdAt: at, updatedAt: at },
  packData: { group },
})

describe('the map\'s per-render presentation cache', () => {
  test('a new presentation key (the roles a screen sees) presents an unchanged object again, so See reaches the map icons both ways', () => {
    let seen: ReadonlyArray<string> = ['police', 'fire']
    // As a Pack hides the icons of a group whose role the screen does not see.
    const presentationFor = (object: OperationalObject): PackObjectPresentation => {
      const group = (object.packData as { readonly group: string }).group
      return { categoryId: 'fixture', icon: 'square', color: '#334155', summary: object.label, fields: [], ...(seen.includes(group) ? {} : { mapIconVisible: false }) }
    }
    let key = JSON.stringify(seen)
    const present = createRenderPresentationFor(presentationFor, () => key)
    const objects = [unitOf('engine-1', 'fire'), unitOf('patrol-1', 'police')]
    const store = createMapFeatureStore()
    const drawn = () => store.update({ objects, selectedControllerId: null, highlightedObjectIds: [], hiddenObjectCategoryIds: [], placementPoints: [], packFeatures: [], hasNewInfo: () => false, presentationFor: present }).points.map(point => point.id)
    expect(drawn()).toEqual(['engine-1', 'patrol-1'])
    seen = ['police']
    key = JSON.stringify(seen)
    expect(drawn()).toEqual(['patrol-1'])
    seen = ['police', 'fire']
    key = JSON.stringify(seen)
    expect(drawn()).toEqual(['engine-1', 'patrol-1'])
  })

  test('while the key stands, an object is presented once per revision, as for a screen in open mode', () => {
    let calls = 0
    const present = createRenderPresentationFor(object => {
      calls += 1
      return { categoryId: 'fixture', icon: 'square', color: '#334155', summary: object.label, fields: [] }
    }, () => 'null')
    const unit = unitOf('a1', 'ems')
    expect(present(unit)).toBe(present(unit))
    expect(calls).toBe(1)
    present({ ...unit, revision: 4 })
    expect(calls).toBe(2)
  })
})
