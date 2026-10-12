import { describe, expect, test } from 'bun:test'
import { packMapFeatureSchema } from '../../core/packs/protocol.ts'
import type { IsoTimestamp } from '../../core/model/index.ts'
import { plannedPathFeatures, plannedPaths } from './chain-path.ts'
import type { Intent } from './engine/intents.ts'
import type { EngineState } from './engine/model.ts'
import { engineObjects } from './engine/objects.ts'
import { advance, at, emptyState, low, newTask, newUnit, pointOf, run, runAll, send, start, templates, top, types, unitOf } from './fixtures/engine-harness.ts'
import type { Step } from './steps.ts'
import type { StepTarget } from './steps.ts'
import { einsatzPackView } from './ui-pack.ts'

const queue = (unitId: string, to: StepTarget): Intent => ({ kind: 'queue', unitId, to })
const objectsOf = (state: EngineState) => engineObjects(state, () => ({ at: new Date(state.timeMs).toISOString() as IsoTimestamp, provenance: { source: 'simulator' } }))

describe('Einsatz job chain paths', () => {
  test('the planned path is the active route, then a straight segment to each queued target; while paused it starts where the unit stands', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('far', types.publicSite, at(-0.01)),
      newTask('a', templates.load, at(0.005), { [top]: 1 }),
      newTask('b', templates.load, at(-0.008), { [low]: 1 }),
      send(['c1'], { taskId: 'a' }),
      queue('c1', { siteId: 'far' }),
      queue('c1', { taskId: 'b' }),
      queue('c1', { point: at(0.02) }),
    ])
    state = await advance(state, start + 10_000)
    const [path] = plannedPaths(objectsOf(state))
    expect(path).toMatchObject({ unitId: 'c1', activeLeg: unitOf(state, 'c1').leg!.geometry })
    expect(path!.segments.map(segment => [segment.stepId, segment.from.coordinates, segment.to.coordinates, segment.targetLabel])).toEqual([
      ['step-2', at(0.005).coordinates, at(-0.01).coordinates, 'FAR'],
      ['step-3', at(-0.01).coordinates, at(-0.008).coordinates, 'B'],
      ['step-4', at(-0.008).coordinates, at(0.02).coordinates, undefined],
    ])
    const paused = await run(state, { kind: 'hold', unitId: 'c1' })
    const [held] = plannedPaths(objectsOf(paused))
    expect(held!.activeLeg).toBeUndefined()
    expect(held!.segments.map(segment => segment.stepId)).toEqual(['step-1', 'step-2', 'step-3', 'step-4'])
    expect(held!.segments[0]!.from).toEqual(pointOf(paused, 'c1'))
  })

  test('the Pack draws each queued segment as a map feature in the routes layer, keyed by unit and step; an engage step moves nothing and adds none', async () => {
    const state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('far', types.publicSite, at(-0.01)),
      newTask('a', templates.load, at(0.005), { [top]: 1 }),
      send(['c1'], { taskId: 'a' }),
      queue('c1', { siteId: 'far' }),
      queue('c1', { point: at(0.02) }),
    ])
    const engage: Step = { id: 'step-9', kind: 'engage', target: { trackId: 'track:north:1' }, state: 'queued', by: 'Controller' }
    const objects = objectsOf(state).map(object => {
      if (object.id !== 'c1') return object
      const data = object.packData as { readonly orders: ReadonlyArray<Step> }
      return { ...object, packData: { ...data, orders: [data.orders[0]!, data.orders[1]!, engage, data.orders[2]!] } }
    })
    const presentation = einsatzPackView.presentation
    expect(presentation.mapFeatureLayers).toEqual(['routes'])
    const features = presentation.mapFeatures!({ objects })
    expect(features.map(feature => [feature.id, feature.geometry])).toEqual([
      ['einsatz-plan:c1:step-2', { type: 'LineString', coordinates: [at(0.005).coordinates, at(-0.01).coordinates] }],
      ['einsatz-plan:c1:step-3', { type: 'LineString', coordinates: [at(-0.01).coordinates, at(0.02).coordinates] }],
    ])
    expect(features.map(feature => feature.summary)).toEqual(['C1 · next: FAR', 'C1 · next: a map point'])
    expect(plannedPathFeatures(objectsOf(state), 'units', () => true)).toHaveLength(2)
    // Queued segments are dashed and thinner than a route; the selected unit's are a little stronger, above every other path.
    const line = (selectedObjectId?: string) => presentation.mapFeatures!({ objects, ...(selectedObjectId === undefined ? {} : { selectedObjectId }) })
      .map(feature => [feature.lineWidth, feature.lineOpacity, feature.lineDashed, feature.sortKey])
    expect(line()).toEqual([[1.5, 0.45, true, 22], [1.5, 0.45, true, 22]])
    expect(line('c1')).toEqual([[2.5, 0.9, true, 23], [2.5, 0.9, true, 23]])
    expect(line('far')).toEqual(line())
    // Every planned segment parses as a Pack map feature, the dash included.
    for (const feature of presentation.mapFeatures!({ objects, selectedObjectId: 'c1' })) expect(packMapFeatureSchema.safeParse(feature).success).toBe(true)
  })
})
