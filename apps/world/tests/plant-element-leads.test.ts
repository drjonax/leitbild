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
// mode's lead lists, never a trip. D-E (amending D-86): an energy end a trip
// commands also declares what verifies its stop, and the commands that say
// the trip has acted, which World reads each sample.

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

  test('the core and the turbine declare what verifies their stop, led with once a trip\'s commands read as it wrote them (D-E)', () => {
    const ref = (path: string) => `${PLANT_ID}#${path}`
    expect(declaration.elements.filter(entry => entry.stopped !== undefined).map(entry => entry.id)).toEqual(['core', 'turbine'])
    // Every reactor trip opens both trip breakers and inserts the rods; a safety injection writes those and more, so it adds no set.
    expect(element('core').stopped).toEqual({
      when: [[{ ref: ref('reactorTripBreakerA.closed'), value: false }, { ref: ref('reactorTripBreakerB.closed'), value: false }, { ref: ref('core.rodInsertionFraction'), value: 1 }]],
      lead: ['core.rodsOnBottom', 'reactorTripBreakerA.closedState', 'reactorTripBreakerB.closedState', 'core.rodStepsWithdrawn', 'core.powerRangePercent',
        'core.intermediateRangeCurrentAmps', 'core.intermediateRangeStartupRateDpm'].map(ref),
    })
    expect(element('turbine').stopped).toEqual({
      when: [[{ ref: ref('turbineStopValve.positionFraction'), value: 0 }, { ref: ref('turbine.loadFraction'), value: 0 }]],
      lead: ['turbine.outputBreakerClosed', 'turbineStopValve.effectivePositionFraction', 'turbine.electricMw'].map(ref),
    })
    // Each command is declared, so World reads it; each lead value is a reading, never a command.
    const declared = new Map(declaration.observables.map(observable => [observable.ref, observable]))
    for (const id of ['core', 'turbine']) {
      expect(element(id).stopped!.when.flat().every(reading => declared.get(reading.ref)?.basis === 'command')).toBe(true)
      expect(element(id).stopped!.lead.every(entry => declared.has(entry) && declared.get(entry)!.basis !== 'command')).toBe(true)
    }
    // As the live detail leads after a trip: the old detail display's E-0 order (equipmentKeyValues with the trip acted).
    const plant = plantModel()
    const tripped = plantIn(STATES.find(state => state.id === 'loss-offsite-power+60s')!)
    const live = equipmentKeyValues(plant, [plant.graph.componentIndexById.get('core' as never)!], plantNowOf(tripped)).map(path => `${PLANT_ID}#${path}`)
    expect(live.slice(0, element('core').stopped!.lead.length)).toEqual(element('core').stopped!.lead)
    // The stop is static: a tripped Plant declares the same.
    expect(observationDeclarationSchema.parse(declare(tripped)).elements.find(entry => entry.id === 'core')!.stopped).toEqual(element('core').stopped)
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
