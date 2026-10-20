import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, OperationalObject } from '../src/core/model/index.ts'
import {
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  processPlantUnitPackDataSchema,
  projectedProcessPlantUnit,
  type CompiledProcessPlant,
  type ProcessPlantIcLifecycleState,
} from '../src/packs/process-plant/index.ts'
import { formatQuantity } from '../src/packs/process-plant/quantity-text.ts'
import { processPlantPresentation } from '../src/packs/process-plant/presentation.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { scenarios } from './fixtures/scenarios.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

const at = '2026-10-14T09:00:00.000Z' as IsoTimestamp
const builtIn = scenarios.find(scenario => scenario.id === 'test-plant')
const unit = builtIn?.initialObjects.find(object => object.packId === 'process-plant')
if (unit === undefined) throw new Error('the Plant persistence fixture has no Plant')

const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:projection', loopCount: 4 }))

/**
 * The reference Plant at full power, its alarms and trips as `adjust` makes
 * them (a test double of its protection's snapshot). `system` stands for a
 * variant of its model, such as one that declares other operating modes; its
 * protection stays the reference model's.
 */
const plantWith = (
  adjust: (lifecycle: ProcessPlantIcLifecycleState) => ProcessPlantIcLifecycleState,
  system: CompiledProcessPlant = compiled,
): ProcessPlantRuntimeInstance => {
  const runtime = createProcessPlantRuntime({ system })
  const protection = createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation })
  return {
    plant: system,
    runtime,
    ramps: createProcessPlantRampRunner({ runtime }),
    protection: {
      ...protection,
      snapshot: () => {
        const snapshot = protection.snapshot()
        return { ...snapshot, alarms: snapshot.alarms.map(adjust), trips: snapshot.trips.map(adjust) }
      },
    },
    performance: createProcessPlantRuntimePerformance(),
  }
}

const projectionOf = (object: OperationalObject) => {
  const projection = processPlantUnitPackDataSchema.parse(object.packData).projection
  if (projection === undefined) throw new Error('expected a projection')
  return projection
}

const presented = (object: OperationalObject) => processPlantPresentation.presentObject(object, { objects: [object] })

const lifecycles = createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation }).snapshot()
const warning = lifecycles.alarms.find(lifecycle => lifecycle.severity === 'warning')!
const notice = lifecycles.alarms.find(lifecycle => lifecycle.severity === 'notice' || lifecycle.severity === 'info')!
const trip = lifecycles.trips.find(lifecycle => lifecycle.severity === 'critical')!
const reactorTripGroups = new Set(compiled.automation.firstOutGroups.filter(group => group.reactorTrip).map(group => group.id))
const inGroup = (lifecycle: ProcessPlantIcLifecycleState, groups: ReadonlySet<string>): boolean =>
  lifecycle.annunciator?.firstOutGroup !== undefined && groups.has(lifecycle.annunciator.firstOutGroup)
const reactorTrip = lifecycles.trips.find(lifecycle => inGroup(lifecycle, reactorTripGroups))!
// A trip-kind actuation that is not the reactor's: the auxiliary feedwater start on a steam generator's low-low level.
const feedStart = lifecycles.trips.find(lifecycle => inGroup(lifecycle, new Set(['auxiliary-feedwater'])))!
const activating = (...ids: ReadonlyArray<string>) => (lifecycle: ProcessPlantIcLifecycleState): ProcessPlantIcLifecycleState =>
  ids.includes(lifecycle.id) ? { ...lifecycle, active: true } : lifecycle
const quiet = (lifecycle: ProcessPlantIcLifecycleState): ProcessPlantIcLifecycleState => lifecycle

describe('a Plant\'s projection, which colours it on the map', () => {
  test('counts and colours only the alarms and trips its displays annunciate: never shelved, suppressed or out-of-service ones', () => {
    const silenced = projectedProcessPlantUnit({
      object: unit,
      plant: plantWith(lifecycle => lifecycle.id === warning.id ? { ...lifecycle, active: true, shelved: true }
        : lifecycle.id === trip.id ? { ...lifecycle, active: true, suppressed: true }
          : lifecycle.id === notice.id ? { ...lifecycle, active: true, outOfService: true }
            : lifecycle),
      at,
      simulationTime: at,
    })
    expect(projectionOf(silenced)).toMatchObject({ statusTone: 'ready', statusLabel: 'Normal', activeAlarmCount: 0, activeTripCount: 0 })
    expect(projectionOf(silenced).highestSeverity).toBeUndefined()
    expect(silenced.operational.status).toBe('normal')
    expect(presented(silenced).color).toBe('#0f915f')

    const annunciated = projectedProcessPlantUnit({
      object: unit,
      plant: plantWith(lifecycle => lifecycle.id === warning.id ? { ...lifecycle, active: true }
        : lifecycle.id === trip.id ? { ...lifecycle, active: true, shelved: true }
          : lifecycle),
      at,
      simulationTime: at,
    })
    expect(projectionOf(annunciated)).toMatchObject({ statusTone: 'working', highestSeverity: 'warning', activeAlarmCount: 1, activeTripCount: 0 })
    expect(presented(annunciated).color).toBe('#0f915f')
  })

  test('draws a Plant whose runtime is pending grey, not green', () => {
    const pending = projectedProcessPlantUnit({ object: unit, plant: undefined, at, simulationTime: at })
    expect(projectionOf(pending).statusTone).toBe('idle')
    const presentation = presented(pending)
    expect(presentation.color).toBe('#6e788c')
    expect(presentation.status?.tone).toBe('idle')
  })

  test('names the operating mode the Plant is in, and none where its model declares none or none holds', () => {
    expect(projectionOf(projectedProcessPlantUnit({ object: unit, plant: plantWith(quiet), at, simulationTime: at })).modeLabel).toBe('Power operation')
    const withModes = (operatingModes: CompiledProcessPlant['automation']['operatingModes']): CompiledProcessPlant =>
      ({ ...compiled, automation: { ...compiled.automation, operatingModes } })
    const undeclared = projectionOf(projectedProcessPlantUnit({ object: unit, plant: plantWith(quiet, withModes([])), at, simulationTime: at }))
    expect('modeLabel' in undeclared).toBe(false)
    // At full power the unit is in none of its shutdown modes.
    const shutdownOnly = withModes(compiled.automation.operatingModes.filter(mode => mode.id === 'coldShutdown'))
    expect(shutdownOnly.automation.operatingModes).toHaveLength(1)
    expect('modeLabel' in projectionOf(projectedProcessPlantUnit({ object: unit, plant: plantWith(quiet, shutdownOnly), at, simulationTime: at }))).toBe(false)
  })

  test('marks the reactor tripped only while a trip of a first-out group the model declares as its reactor trip is active, whether or not its alarm is shelved or suppressed', () => {
    const fed = projectionOf(projectedProcessPlantUnit({ object: unit, plant: plantWith(activating(feedStart.id)), at, simulationTime: at }))
    expect(fed).toMatchObject({ statusTone: 'error', activeTripCount: 1 })
    expect('reactorTripped' in fed).toBe(false)
    const tripped = projectionOf(projectedProcessPlantUnit({ object: unit, plant: plantWith(activating(feedStart.id, reactorTrip.id)), at, simulationTime: at }))
    expect(tripped).toMatchObject({ reactorTripped: true, activeTripCount: 2 })
    const shelved = projectionOf(projectedProcessPlantUnit({
      object: unit,
      plant: plantWith(lifecycle => lifecycle.id === reactorTrip.id ? { ...lifecycle, active: true, shelved: true } : lifecycle),
      at,
      simulationTime: at,
    }))
    // Shelving the trip's alarm takes it off the count and the colour, not off the Plant's state.
    expect(shelved).toMatchObject({ reactorTripped: true, activeTripCount: 0 })
    const outOfService = projectionOf(projectedProcessPlantUnit({
      object: unit,
      plant: plantWith(lifecycle => lifecycle.id === reactorTrip.id ? { ...lifecycle, active: true, outOfService: true } : lifecycle),
      at,
      simulationTime: at,
    }))
    expect('reactorTripped' in outOfService).toBe(false)
  })

  test('a projection stored before the mode and the reactor trip were projected still restores', () => {
    const projected = projectedProcessPlantUnit({ object: unit, plant: plantWith(activating(reactorTrip.id)), at, simulationTime: at })
    const data = processPlantUnitPackDataSchema.parse(projected.packData)
    const { modeLabel, reactorTripped, ...stored } = projectionOf(projected)
    expect(modeLabel).toBe('Power operation')
    expect(reactorTripped).toBe(true)
    expect(processPlantUnitPackDataSchema.safeParse({ ...data, projection: stored }).success).toBe(true)
  })

  test('reads the energy its model declares on sources and sinks by variable, at the Run time, as its summary words them', () => {
    const simulationTime = '2026-10-14T06:30:00.000Z' as IsoTimestamp
    const projection = projectionOf(projectedProcessPlantUnit({ object: unit, plant: plantWith(quiet), at, simulationTime }))
    expect(projection.energy.map(reading => [reading.path, reading.role, reading.unit, reading.simulationTime])).toEqual([
      ['core.totalThermalPowerMw', 'source', 'MW', simulationTime],
      ['turbine.electricMw', 'sink', 'MW', simulationTime],
    ])
    expect(projection.summary).toBe(projection.energy.map(reading => `${reading.label} ${formatQuantity(reading.value!, reading.unit)}`).join(' · '))
    expect(projectionOf(projectedProcessPlantUnit({ object: unit, plant: undefined, at, simulationTime })).energy).toEqual([])
  })

  test('a projection stored before the energy readings were projected no longer restores: the owner chose to restart such Runs (14 Oct 2026)', () => {
    const projected = projectedProcessPlantUnit({ object: unit, plant: plantWith(quiet), at, simulationTime: at })
    const data = processPlantUnitPackDataSchema.parse(projected.packData)
    const { energy, ...stored } = projectionOf(projected)
    expect(energy).toHaveLength(2)
    expect(processPlantUnitPackDataSchema.safeParse({ ...data, projection: stored }).success).toBe(false)
  })

  test('names its most challenged critical safety function, and none where its model declares none', () => {
    // At full power every judged function is green: the first declared green one stands for them.
    const normal = projectionOf(projectedProcessPlantUnit({ object: unit, plant: plantWith(quiet), at, simulationTime: at }))
    expect(normal.worstSafetyFunction).toMatchObject({ id: 'core-cooling', shortLabel: 'CORE COOL', status: 'green' })
    const undeclared = { ...compiled, automation: { ...compiled.automation, safetyFunctions: [] } }
    expect('worstSafetyFunction' in projectionOf(projectedProcessPlantUnit({ object: unit, plant: plantWith(quiet, undeclared), at, simulationTime: at }))).toBe(false)
  })
})

describe('a Plant\'s glance, which stands for it on the map\'s hover and the rail\'s tooltip', () => {
  test('is its status and operating mode, then the energy its sources put in and its sinks take out', () => {
    const normal = projectedProcessPlantUnit({ object: unit, plant: plantWith(quiet), at, simulationTime: at })
    const summary = projectionOf(normal).summary
    expect(summary).toMatch(/^Core thermal power [0-9]+ MW · Electrical output [0-9]+ MW$/)
    expect(presented(normal).glance).toEqual(['Normal · Power operation', summary])
    const tripped = projectedProcessPlantUnit({ object: unit, plant: plantWith(activating(reactorTrip.id)), at, simulationTime: at })
    expect(presented(tripped).glance).toEqual(['Critical alarm or trip active · Power operation', projectionOf(tripped).summary])
  })

  test('is the status alone where no mode holds, and only "Runtime pending" before the runtime runs', () => {
    const modeless = { ...compiled, automation: { ...compiled.automation, operatingModes: [] } }
    const unmoded = projectedProcessPlantUnit({ object: unit, plant: plantWith(quiet, modeless), at, simulationTime: at })
    expect(presented(unmoded).glance).toEqual(['Normal', projectionOf(unmoded).summary])
    expect(presented(projectedProcessPlantUnit({ object: unit, plant: undefined, at, simulationTime: at })).glance).toEqual(['Runtime pending'])
  })

  test('leaves the fields the rail lets people show or hide as they were', () => {
    const fields = presented(projectedProcessPlantUnit({ object: unit, plant: plantWith(quiet), at, simulationTime: at })).fields.map(field => field.key)
    expect(fields.slice(0, 2)).toEqual(['model', 'operating-point'])
    expect(fields).toEqual(expect.arrayContaining(['active-alarms', 'active-trips', 'runtime-performance']))
  })
})
