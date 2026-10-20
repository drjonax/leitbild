import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { alertStateSchema, type AlertState } from '../src/core/model/alerts.ts'
import type { ObjectId } from '../src/core/model/ids.ts'
import type { IsoTimestamp } from '../src/core/model/time.ts'
import { annunciatorTiles } from '../src/features/displays/alerts/annunciator.ts'
import { alertRows, type AlertObject } from '../src/features/displays/alerts/rows.ts'
import { alertStrip } from '../src/features/displays/alerts/strip.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { displayAnnunciation } from '../src/packs/process-plant/displays/annunciators.ts'
import type { ProcessPlantIcLifecycleState } from '../src/packs/process-plant/runtime/ic/control-protection-model.ts'
import { processPlantRuntimeStateSchema } from '../src/packs/process-plant/sim/runtime-state.ts'
import { firstOutFlag } from '../src/ui/embed/composed-display/panel-presenters.ts'
import { FIXTURE_ROOT } from './run-restore/fixture-runs.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// The first-out projection from the alert facets (architecture A6) against
// today's plant annunciation (displays/annunciators.ts, firstOutFlag) on the
// saved four-unit Halden loss of offsite power (T03's halden-loop fixture),
// as its plant runtime state holds the alarms and trips.
//
// Until p1-plant's P4 projects the plant's alarms into the core slot, the
// records come from `asCoreAlerts`, a stand-in on the rules P4 follows (lead
// ruling R21): the alarms and trips a unit annunciates, `returned` once
// cleared and still unacknowledged, `subject` its equipment, and `firstOut`
// {group id, rank} only where the first-out group has more than one member.
// When P4 lands the records come from the restored Run's own objects.

const fixture = async () => {
  const stored = await Bun.file(join(FIXTURE_ROOT, 'halden-loop/run/runtimes/process-plant.local.json.gz')).arrayBuffer()
  return processPlantRuntimeStateSchema.parse(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(stored)))).state)
}

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:halden-1', loopCount: 4 }))
const annunciation = displayAnnunciation(plant)
const shortLabel = new Map(plant.automation.firstOutGroups.map(group => [group.id, group.shortLabel]))
const members = new Map<string, number>()
for (const rule of plant.automation.rules) for (const effect of rule.effects) {
  if ((effect.type === 'alarm.enter' || effect.type === 'trip.enter') && effect.annunciator?.firstOutGroup !== undefined) {
    members.set(effect.annunciator.firstOutGroup, (members.get(effect.annunciator.firstOutGroup) ?? 0) + 1)
  }
}

/** What today's displays annunciate (composed-display-query.ts `annunciated`): not shelved, suppressed or out of service, active or cleared unacknowledged. */
const annunciated = (lifecycles: ReadonlyArray<ProcessPlantIcLifecycleState>) =>
  lifecycles.filter(lifecycle => !lifecycle.shelved && !lifecycle.suppressed && !lifecycle.outOfService && (lifecycle.active || lifecycle.phase === 'clearedUnacknowledged'))

const asCoreAlerts = (lifecycles: ReadonlyArray<ProcessPlantIcLifecycleState>): ReadonlyArray<AlertState> => annunciated(lifecycles).map(lifecycle => {
  const group = lifecycle.annunciator?.firstOutGroup
  return alertStateSchema.parse({
    id: lifecycle.id,
    kind: lifecycle.kind,
    severity: lifecycle.severity === 'notice' ? 'info' : lifecycle.severity,
    message: lifecycle.title,
    // On the Plant's elapsed-time axis: only the order of onsets matters here.
    raisedAt: new Date(lifecycle.firstActiveElapsedMs ?? 0).toISOString() as IsoTimestamp,
    clock: 'simulation',
    acknowledged: lifecycle.acknowledged,
    ...(lifecycle.active ? {} : { returned: true }),
    ...(lifecycle.annunciator?.equipmentId === undefined ? {} : { subject: { element: lifecycle.annunciator.equipmentId } }),
    ...(group !== undefined && (members.get(group) ?? 0) > 1 && lifecycle.firstOutRank !== undefined ? { firstOut: { group, rank: lifecycle.firstOutRank } } : {}),
  })
})

describe('first-out projection on the saved Halden loss of offsite power', () => {
  test('the four units\' first-out marks are the ones today\'s annunciation sets, and every first-out group lit today has its tile', async () => {
    const state = await fixture()
    expect(state.plants.map(entry => entry.plantId)).toEqual(['plant:halden-1', 'plant:halden-2', 'plant:halden-3', 'plant:halden-4'])
    const objects: ReadonlyArray<AlertObject> = state.plants.map(entry => ({
      id: entry.plantId as ObjectId, packId: 'process-plant' as AlertObject['packId'], lifecycle: 'active',
      alerts: asCoreAlerts([...entry.protection!.alarms, ...entry.protection!.trips]),
    }))
    const rows = alertRows(objects, object => ({ label: object.id, categoryId: 'unit' }))
    let marks = 0
    for (const entry of state.plants) {
      const lifecycles = annunciated([...entry.protection!.alarms, ...entry.protection!.trips])
      // The same I&C: every alarm and trip the fixture holds is one today's annunciation names.
      expect(lifecycles.filter(lifecycle => annunciation.tags[lifecycle.id] === undefined).map(lifecycle => lifecycle.id)).toEqual([])
      const today = lifecycles.flatMap(lifecycle => {
        const flag = firstOutFlag(lifecycle, annunciation)
        return flag === null ? [] : [`${lifecycle.id} ${flag}`]
      }).sort()
      const tiles = annunciatorTiles(rows, entry.plantId)
      const projected = tiles.filter(tile => tile.rank === 1).map(tile => `${tile.rowKey.split('|')[1]} 1st ${shortLabel.get(tile.firstOutGroup)}`).sort()
      expect(projected).toEqual(today)
      marks += today.length
      const lit = new Set(lifecycles.filter(lifecycle => lifecycle.active).flatMap(lifecycle => annunciation.firstOutGroups[lifecycle.id] ?? []))
      expect(tiles.map(tile => shortLabel.get(tile.firstOutGroup)).sort()).toEqual([...lit].sort())
      // A tile shows its alarm's own words, never the group id (R21).
      for (const tile of tiles) expect(tile.label).toBe(lifecycles.find(lifecycle => lifecycle.id === tile.rowKey.split('|')[1])!.title)
    }
    expect(marks).toBeGreaterThanOrEqual(12)
  })

  test('the per-unit strip pins one of each unit\'s first-outs and keeps every unit\'s row at six rows', async () => {
    const state = await fixture()
    const objects: ReadonlyArray<AlertObject> = state.plants.map(entry => ({
      id: entry.plantId as ObjectId, packId: 'process-plant' as AlertObject['packId'], lifecycle: 'active',
      alerts: asCoreAlerts([...entry.protection!.alarms, ...entry.protection!.trips]),
    }))
    const strip = alertStrip(alertRows(objects, object => ({ label: object.id, categoryId: 'unit' })), { maxRows: 6 })
    expect(strip.groups.map(group => [group.key, group.collapsed])).toEqual(state.plants.map(entry => [entry.plantId, false]))
    for (const group of strip.groups) {
      expect(group.firstOut?.alert.firstOut?.rank).toBe(1)
      expect(group.rows[0]).toBe(group.firstOut!)
    }
  })
})
