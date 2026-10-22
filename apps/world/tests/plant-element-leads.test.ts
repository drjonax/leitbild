import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { observationDeclarationSchema } from '../src/core/observation/capabilities.ts'
import { equipmentKeyValues, plantNowOf } from '../src/packs/process-plant/ic/key-values.ts'
import { declarationRevision } from '../src/packs/process-plant/observation/declarations.ts'
import { answerProcessPlantObservationQuery } from '../src/packs/process-plant/observation/query.ts'
import type { ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { PLANT_ID, plantIn, plantModel, SIMULATION_TIME, STATES } from './display-parity/states.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Ruling Q22: each element's detail leads with today's detail key values
// (equipmentKeyValues), other elements' values among them, ranked for the
// operating mode at the Plant's nominal state. A device names the equipment
// that bundles it as its parent. The declaration's revision follows the
// mode's lead lists, never a trip.

const declare = (instance: ProcessPlantRuntimeInstance) => (answerProcessPlantObservationQuery({
  request: { capabilityId: 'world.process-plant.observation.declarations', input: { objectIds: [PLANT_ID] } },
  plants: new Map([[PLANT_ID, instance]]), simulationTime: SIMULATION_TIME as IsoTimestamp, recording: null,
}) as { readonly declarations: ReadonlyArray<any> }).declarations[0]!

const atPower = plantIn(STATES.find(state => state.id === 'steady')!)
const declaration = observationDeclarationSchema.parse(declare(atPower))
const element = (id: string) => declaration.elements.find(entry => entry.id === id)!

describe('element leads and parents (Q22)', () => {
  test('SG A, the pressurizer and RCP A lead with today\'s detail key values at power, in order, other elements\' among them', () => {
    const plant = plantModel()
    expect(plantNowOf(atPower).mode).toBe('powerOperation')
    const declared = new Set(declaration.observables.map(observable => observable.ref))
    for (const id of ['sgA', 'pressurizer', 'rcpA']) {
      const today = equipmentKeyValues(plant, [plant.graph.componentIndexById.get(id as never)!], plantNowOf(atPower))
        .map(path => `${PLANT_ID}#${path}`).filter(ref => declared.has(ref))
      expect([id, element(id).lead]).toEqual([id, today])
      expect(element(id).lead!.length).toBeGreaterThan(1)
    }
    // A steam generator leads with flows into it on its feed lines, which are other elements' values.
    expect(element('sgA').lead!.some(ref => declaration.observables.find(observable => observable.ref === ref)?.element !== 'sgA')).toBe(true)
  })

  test('each device names the equipment that bundles it as its parent', () => {
    expect(['pressurizer.reliefValve', 'pressurizer.blockValve', 'pressurizer.safetyValves', 'safetyAccumulatorA.dischargeIsolationValve', 'safetyAccumulatorA.checkValve']
      .map(id => [id, element(id).parent])).toEqual([
      ['pressurizer.reliefValve', 'pressurizer'], ['pressurizer.blockValve', 'pressurizer'], ['pressurizer.safetyValves', 'pressurizer'],
      ['safetyAccumulatorA.dischargeIsolationValve', 'safetyAccumulatorA'], ['safetyAccumulatorA.checkValve', 'safetyAccumulatorA'],
    ])
    expect(element('pressurizer').parent).toBeUndefined()
  })

  test('the revision changes with the mode, and not with a trip that leaves the mode as it was', () => {
    const plant = plantModel()
    expect(declaration.revision).toBe(declarationRevision(plant, null, 'powerOperation'))
    expect(declarationRevision(plant, null, 'hotStandby')).not.toBe(declaration.revision)
    // A loss of offsite power trips the reactor: the unit leaves power operation, and the revision follows the mode.
    const tripped = plantIn(STATES.find(state => state.id === 'loss-offsite-power+60s')!)
    const mode = plantNowOf(tripped).mode
    expect(mode).not.toBe('powerOperation')
    expect(declare(tripped).revision).toBe(declarationRevision(plant, null, mode))
    // A stuck-open PORV acts its alarms at power: the mode, and so the revision, stay.
    const porv = plantIn(STATES.find(state => state.id === 'porv-open-35+120s')!)
    if (plantNowOf(porv).mode === 'powerOperation') expect(declare(porv).revision).toBe(declaration.revision)
  })
})
