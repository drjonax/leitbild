import { afterAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import type { WorkspaceId } from '@leitbild/contracts'
import type { ActorId, IsoTimestamp, SimulationRunId } from '../src/core/model/index.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { annunciatorTiles } from '../src/features/displays/alerts/annunciator.ts'
import { alertRows } from '../src/features/displays/alerts/rows.ts'
import { alertStrip } from '../src/features/displays/alerts/strip.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { displayAnnunciation } from '../src/packs/process-plant/displays/annunciators.ts'
import type { ComposedDisplayAlarm } from '../src/ui/embed/composed-display/composed-display-client.ts'
import { firstOutFlag } from '../src/ui/embed/composed-display/panel-presenters.ts'
import { unpackFixtureRun } from './run-restore/fixture-runs.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// The first-out projection from the alert facets (architecture A6) against
// today's plant annunciation (displays/annunciators.ts, firstOutFlag) on the
// saved four-unit Halden loss of offsite power (T03's halden-loop fixture),
// restored and run on for two seconds: both read the same Run, the new path
// through the core alert slot the plant projects (P4), the old one through
// the plant's display sample.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const viewer: Actor = { id: 'actor:human:strip-viewer' as ActorId, label: 'Strip viewer', role: 'operator' }
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const restoredRun = async () => {
  const { dataDir, meta } = await unpackFixtureRun('halden-loop')
  const registry = createSimulationRunRegistry({
    dataDir,
    workspaceId: meta.workspaceId as WorkspaceId,
    scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
    runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
  })
  cleanups.push(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  const run = await registry.load(meta.runId as SimulationRunId)
  const at = Date.parse(run.snapshot().clock!.currentTime)
  await run.runMaximumPace(new Date(at + 2_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  return run
}

const plantIds = ['plant:halden-1', 'plant:halden-2', 'plant:halden-3', 'plant:halden-4']
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:halden-1', loopCount: 4 }))
const annunciation = displayAnnunciation(plant)
const shortLabel = new Map(plant.automation.firstOutGroups.map(group => [group.id, group.shortLabel]))

describe('first-out projection on the restored Halden loss of offsite power', () => {
  test('each unit\'s first-out marks from the core alert slot are the ones today\'s annunciation sets; the per-unit strip pins one and keeps every unit\'s row', async () => {
    const run = await restoredRun()
    const objects = run.snapshot().objects
    const rows = alertRows(objects, object => ({ label: object.label, categoryId: object.packId }))
    let marks = 0
    for (const plantId of plantIds) {
      const outcome = await run.invokeCapability(viewer, { capabilityId: 'world.process-plant.display.sample', input: { plantId, paths: ['pressurizer.pressureMPa'], alarms: true } })
      if (outcome.kind !== 'query') throw new Error('the display sample is a query')
      const alarms = (outcome.result as { alarms: ReadonlyArray<ComposedDisplayAlarm> }).alarms
      // The same I&C: every alarm and trip the unit annunciates is one today's annunciation names.
      expect(alarms.filter(alarm => annunciation.tags[alarm.id] === undefined).map(alarm => alarm.id)).toEqual([])
      const today = alarms.flatMap(alarm => {
        const flag = firstOutFlag(alarm, annunciation)
        return flag === null ? [] : [`${alarm.id} ${flag}`]
      }).sort()
      const tiles = annunciatorTiles(rows, plantId)
      expect(tiles.map(tile => `${tile.rowKey.split('|')[1]} 1st ${shortLabel.get(tile.firstOutGroup)}`).sort()).toEqual(today)
      // A tile shows its alarm's own words, never the group id (R21).
      for (const tile of tiles) expect(tile.label).toBe(alarms.find(alarm => alarm.id === tile.rowKey.split('|')[1])!.title)
      marks += today.length
    }
    expect(marks).toBeGreaterThanOrEqual(12)
    const strip = alertStrip(rows, { maxRows: 6 })
    for (const plantId of plantIds) {
      const unit = strip.groups.find(group => group.key === plantId)!
      expect(unit).toMatchObject({ collapsed: false })
      expect(unit.rows[0]).toBe(unit.firstOut!)
      expect(unit.firstOut!.alert.firstOut!.rank).toBe(1)
    }
  })
})
