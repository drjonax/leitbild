import { describe, expect, test } from 'bun:test'
import { alertStateSchema } from '../src/core/model/alerts.ts'
import type { ObjectId, OperationalObject, Provenance } from '../src/core/model/index.ts'
import { gridAlarmLifecycleCommandKind } from '../src/packs/electric-grid/commands/alarm.ts'
import { gridCloseBranchCommandKind, gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridElementName } from '../src/packs/electric-grid/observation/declarations.ts'
import { gridAlerts, gridProjectionEvents } from '../src/packs/electric-grid/sim/object-projection.ts'
import { corridorDefinition, isoAt, steppedGrid, type SteppedGrid } from './fixtures/grid-corridor.ts'

// N4 (plan v3.1 §2.2, architecture A2): every alarm record that is active, or returned and still
// unacknowledged, is an alert in the Grid object's core slot, with facets; the roll-up is gone.
const overloadedCorridor = (): SteppedGrid => {
  const run = steppedGrid(corridorDefinition())
  run.advanceTo(10_000)
  expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-l' }).ok).toBe(true)
  run.advanceTo(30_000)
  return run
}
const lifecycle = (run: SteppedGrid, alarmIds: ReadonlyArray<string>, action: string, extra: Readonly<Record<string, unknown>> = {}) =>
  expect(run.command(gridAlarmLifecycleCommandKind, { alarmIds, action, ...extra }).ok).toBe(true)

describe('grid alerts in the core slot (N4)', () => {
  test('one alert per active record, with subject, observable, threshold, priority agreeing with severity, and simulation time', () => {
    const run = overloadedCorridor()
    const active = [...run.grid.alarms.records.values()].filter(record => record.active)
    const alerts = gridAlerts(run.grid).map(alert => alertStateSchema.parse(alert))
    expect(alerts.map(alert => alert.id)).toEqual(active.map(record => record.id))
    const emergency = alerts.find(alert => alert.id === 'branch:branch:g-a:loading-above-emergency' || alert.threshold === 'loading-above-emergency')!
    expect(emergency).toMatchObject({
      severity: 'critical', priority: 'alarm', clock: 'simulation', acknowledged: false, subject: { element: 'branch:g-a' },
      observable: 'grid:test-corridor#branch:g-a.loading', threshold: 'loading-above-emergency', message: 'Branch loading (above-emergency): branch:g-a',
    })
    for (const record of active) {
      const alert = alerts.find(candidate => candidate.id === record.id)!
      expect([alert.priority as string, alert.severity as string]).toEqual([{ 1: 'alarm', 2: 'warning', 3: 'caution' }[record.priority], record.priority === 1 ? 'critical' : 'warning'])
      expect(alert.raisedAt).toBe(record.raisedAt)
      expect(alert.message).toBe(`${record.title}: ${gridElementName(run.grid, record.assetId)}`)
      expect(alert.acknowledgedBy).toBeUndefined()
    }
  })

  test('an island alarm is about the island as a group', () => {
    const run = steppedGrid(corridorDefinition())
    run.advanceTo(10_000)
    for (const assetId of ['branch:g-l', 'branch:g-a', 'branch:g-b']) expect(run.command(gridOpenBranchCommandKind, { assetId }).ok).toBe(true)
    run.advanceTo(40_000)
    const island = gridAlerts(run.grid).find(alert => alert.kind === 'electric_grid_island_alarm')!
    expect(island.subject).toEqual({ group: expect.stringMatching(/^island:/) })
    expect(island.message).toMatch(/: Island at /)
  })

  test('the alert JSON stays identical over 100 steady steps: no live value, a fixed raise time', () => {
    const run = overloadedCorridor()
    run.advanceTo(200_000)
    const steady = JSON.stringify(gridAlerts(run.grid))
    expect(gridAlerts(run.grid).filter(alert => alert.returned === undefined).length).toBeGreaterThan(0)
    for (let step = 1; step <= 100; step += 1) {
      run.advanceTo(200_000 + step * 2_000)
      expect(JSON.stringify(gridAlerts(run.grid))).toBe(steady)
    }
    expect(steady).not.toMatch(/MVA|MW|%/)
  })

  test('returned to normal and unacknowledged stays as `returned`; acknowledging removes it; shelved records leave the slot; each change emits an upsert', () => {
    const run = overloadedCorridor()
    const object = { id: 'grid:test-corridor', packId: 'electric-grid', revision: 1, operational: { status: 'normal', priority: 'normal' }, alerts: [], timestamps: { createdAt: isoAt(0), updatedAt: isoAt(0) },
      packData: { type: 'electric-grid', schemaVersion: 1, model: { ref: 'test' }, operatingPoint: { ref: 'test' }, automation: { ref: 'test' }, electricalPorts: [], projection: run.grid.projection } } as unknown as OperationalObject
    const objectsById = new Map<ObjectId, OperationalObject>([[object.id, object]])
    const previousKeys = new Map<string, string>()
    const upserts = () => gridProjectionEvents({ objectsById, grids: new Map([[run.grid.definition.gridId, run.grid]]), previousKeys, at: isoAt(run.nowMs()), provenance: { source: 'test' } as unknown as Provenance, history: 'snapshot-only' }).length
    upserts()
    expect(run.command(gridCloseBranchCommandKind, { assetId: 'branch:g-l' }).ok).toBe(true)
    run.advanceTo(120_000)
    const returned = gridAlerts(run.grid).filter(alert => alert.returned === true)
    expect(returned.length).toBeGreaterThan(0)
    expect(returned.every(alert => !alert.acknowledged)).toBe(true)
    expect(upserts()).toBe(1)
    expect(upserts()).toBe(0)
    lifecycle(run, returned.map(alert => alert.id), 'acknowledge')
    expect(gridAlerts(run.grid).some(alert => returned.some(gone => gone.id === alert.id))).toBe(false)
    expect(upserts()).toBe(1)

    const again = overloadedCorridor()
    const [first, ...rest] = gridAlerts(again.grid)
    lifecycle(again, [first!.id], 'shelve', { shelveSeconds: 600 })
    expect(gridAlerts(again.grid).map(alert => alert.id)).toEqual(rest.map(alert => alert.id))
  })
})
