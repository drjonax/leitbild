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
  type ProcessPlantIcLifecycleState,
} from '../src/packs/process-plant/index.ts'
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

/** The reference Plant at full power, its alarms and trips as `adjust` makes them (a test double of its protection's snapshot). */
const plantWith = (
  adjust: (lifecycle: ProcessPlantIcLifecycleState) => ProcessPlantIcLifecycleState,
): ProcessPlantRuntimeInstance => {
  const runtime = createProcessPlantRuntime({ system: compiled })
  const protection = createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation })
  return {
    plant: compiled,
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

describe('a Plant\'s projection, which colours it on the map', () => {
  test('counts and colours only the alarms and trips its displays annunciate: never shelved, suppressed or out-of-service ones', () => {
    const silenced = projectedProcessPlantUnit({
      object: unit,
      plant: plantWith(lifecycle => lifecycle.id === warning.id ? { ...lifecycle, active: true, shelved: true }
        : lifecycle.id === trip.id ? { ...lifecycle, active: true, suppressed: true }
          : lifecycle.id === notice.id ? { ...lifecycle, active: true, outOfService: true }
            : lifecycle),
      at,
    })
    expect(projectionOf(silenced)).toMatchObject({ statusTone: 'ready', statusLabel: 'Normal', activeAlarmCount: 0, activeTripCount: 0 })
    expect(projectionOf(silenced).highestSeverity).toBeUndefined()
    expect(silenced.operational.status).toBe('normal')
    expect(presented(silenced).color).toBe('#22845d')

    const annunciated = projectedProcessPlantUnit({
      object: unit,
      plant: plantWith(lifecycle => lifecycle.id === warning.id ? { ...lifecycle, active: true }
        : lifecycle.id === trip.id ? { ...lifecycle, active: true, shelved: true }
          : lifecycle),
      at,
    })
    expect(projectionOf(annunciated)).toMatchObject({ statusTone: 'working', highestSeverity: 'warning', activeAlarmCount: 1, activeTripCount: 0 })
    expect(presented(annunciated).color).toBe('#c77d13')
  })

  test('draws a Plant whose runtime is pending grey, not green', () => {
    const pending = projectedProcessPlantUnit({ object: unit, plant: undefined, at })
    expect(projectionOf(pending).statusTone).toBe('idle')
    const presentation = presented(pending)
    expect(presentation.color).toBe('#667085')
    expect(presentation.status?.tone).toBe('idle')
  })
})
