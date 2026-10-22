import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, ObjectId, OperationalObject } from '../src/core/model/index.ts'
import type { Observation } from '../src/core/observation/model.ts'
import { valueItem } from '../src/features/displays/compose/card.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { answerProcessPlantObservationQuery } from '../src/packs/process-plant/observation/query.ts'
import type { ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { PLANT_ID, plantIn, plantModel, SIMULATION_TIME, STATES } from './display-parity/states.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A reading outside its validity reads "—" (bbd7ecab7 on the old faceplate
// and quick look): the model's validity rules (component semantics
// meaningfulWhile) are declared as each reading's meaningfulWhile, and while
// the flag is off the reading is not applicable: no value, never a colour.

const declaration = plantDeclaration(PLANT_ID as ObjectId, plantModel(), null)
const observable = (path: string) => declaration.observables.find(entry => entry.ref === `${PLANT_ID}#${path}`)!
const read = (instance: ProcessPlantRuntimeInstance, paths: ReadonlyArray<string>): ReadonlyArray<Observation> => (answerProcessPlantObservationQuery({
  request: { capabilityId: 'world.process-plant.observation.read', input: { refs: paths.map(path => `${PLANT_ID}#${path}`) } },
  plants: new Map([[PLANT_ID, instance]]), simulationTime: SIMULATION_TIME as IsoTimestamp, recording: null,
}) as { readonly observations: ReadonlyArray<Observation> }).observations
const SPEED = 'turbine.speedRpm'
const SOURCE_RANGE = 'core.sourceRangeCountRateCps'

describe('readings outside their validity', () => {
  test('declare the condition they measure something under, as the model\'s validity rules say', () => {
    expect([observable(SPEED).meaningfulWhile, observable(SOURCE_RANGE).meaningfulWhile, observable('core.powerRangePercent').meaningfulWhile])
      .toEqual(['while ON LINE', 'while Source-range HV on', undefined])
  })

  test('at power the source range, its high voltage off, is not applicable; the turbine on line reads its speed', () => {
    const [speed, sourceRange] = read(plantIn(STATES.find(state => state.id === 'steady')!), [SPEED, SOURCE_RANGE])
    expect(speed).toMatchObject({ quality: 'good' })
    expect(typeof speed!.value).toBe('number')
    expect(sourceRange).toMatchObject({ value: null, quality: 'not-applicable', priority: 'none', why: 'measures nothing unless Source-range HV on' })
  })

  test('off line, the turbine\'s speed is not applicable, and the card writes "—"', () => {
    const [speed] = read(plantIn(STATES.find(state => state.id === 'loss-offsite-power+60s')!), [SPEED])
    expect(speed).toMatchObject({ value: null, quality: 'not-applicable', priority: 'none' })
    const object = { id: PLANT_ID, label: 'Unit' } as unknown as OperationalObject
    expect(valueItem({ observable: observable(SPEED), object } as never, speed).reading).toBe('—')
  })
})
