import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Observation } from '../src/core/observation/model.ts'
import type { ObservationPort } from '../src/features/displays/observation/port.ts'
import { guardPlantTests } from './plant-hang-guard.ts'
import { createSteadyPlantRun, plantOperator, plantScenario, type SteadyPlantRun } from './steady-plant-run.ts'

guardPlantTests()

// P3: the Plant's values as World reads them through the Run's observation
// port, as the caller (T05, T35; since, timeToAct, expected.after). One Run:
// steady at power, a grid frequency held under 49 Hz, then a loss of offsite
// power that trips the unit.

let plant: SteadyPlantRun
let port: ObservationPort
let refs: ReadonlyArray<string>
const readAll = async (): Promise<ReadonlyArray<Observation>> => {
  const read: Observation[] = []
  for (let at = 0; at < refs.length; at += 64) {
    const batch = await port.read({ refs: refs.slice(at, at + 64) })
    expect([batch.unknown, batch.refused]).toEqual([[], []])
    read.push(...batch.observations)
  }
  return read
}
const path = (observation: Observation): string => observation.ref.slice(observation.ref.indexOf('#') + 1)
const lead = async () => (await port.read({ lead: { objectId: plant.plantId, count: 8 } })).observations

const facts: Record<string, any> = {}

beforeAll(async () => {
  plant = await createSteadyPlantRun()
  port = plant.run.observations(plantOperator)
  const [declaration] = await port.declarations([plant.plantId])
  refs = 'observables' in declaration! ? declaration.observables.map(observable => observable.ref) : []
  await plant.runTo(10_000)
  facts.leadAtPower = await lead()
  facts.atPower = await readAll()
  facts.undeclared = await port.read({ refs: [`${plant.plantId}#core.noSuchSignal`] })
  // The grid's frequency held at 48.8 Hz: the 30-minute underfrequency turbine trip runs down.
  const frequency = `${plant.plantId}#offsiteGrid.frequencyHz`
  await plant.invoke(plantScenario, 'world.process-plant.control.write', { path: 'offsiteGrid.frequencyHz', value: 48.8 })
  await plant.runTo(20_000)
  facts.underfrequency = await readAll()
  await plant.invoke(plantScenario, 'world.process-plant.control.write', { path: 'offsiteGrid.frequencyHz', value: 50 })
  await plant.runTo(25_000)
  facts.frequencyBack = (await port.read({ refs: [frequency] })).observations[0]
  // A loss of offsite power at 10:00:25 trips the unit.
  await plant.invoke(plantOperator, 'world.process-plant.action.invoke', { actionId: 'loss-offsite-power', parameters: {} })
  await plant.runTo(90_000)
  facts.leadTripped = await lead()
  facts.tripped = await readAll()
})

afterAll(async () => { await plant.remove() })

describe('plant observation read (P3)', () => {
  test('at power every declared value reads, good and neutral; an undeclared one is unknown', () => {
    expect(facts.atPower).toHaveLength(refs.length)
    expect(facts.atPower.filter((observation: Observation) => observation.priority !== 'none' || observation.quality !== 'good').map(path)).toEqual([])
    expect(facts.atPower.every((observation: Observation) => observation.clock === 'simulation' && observation.at === '2026-01-01T10:00:10.000Z')).toBe(true)
    expect(facts.undeclared).toMatchObject({ observations: [], unknown: [`${plant.plantId}#core.noSuchSignal`] })
  })

  test('T35: the unit leads with what its mode needs, and a trip changes it', () => {
    expect(facts.leadAtPower.map(path)).toEqual(['core.powerRangePercent', 'pressurizer.pressureMPa', 'vessel.subcoolingMarginC', 'vessel.collapsedLiquidLevelPercent', 'core.coreExitTemperatureC', 'turbine.electricMw', 'containment.pressureMPa', 'offsiteGrid.frequencyHz'])
    expect(facts.leadAtPower.map((observation: Observation) => observation.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(facts.leadTripped.map(path).slice(0, 3)).toEqual(['vessel.subcoolingMarginC', 'core.coreExitTemperatureC', 'auxFeedwaterHeader.outletFlowKgPerS'])
    expect(facts.leadTripped.map(path)).not.toContain('turbine.electricMw')
  })

  test('timeToAct only where a named delay runs down to one of the value\'s limits', () => {
    expect(facts.underfrequency.filter((observation: Observation) => observation.timeToAct !== undefined).map((observation: Observation) => [path(observation), observation.timeToAct]))
      .toEqual([['offsiteGrid.frequencyHz', { threshold: 'turbine-trip-on-sustained-low-grid-frequency', seconds: 1791 }]])
    expect(facts.frequencyBack.timeToAct).toBeUndefined()
  })

  test('T05: after the trip the diesel running, rods on the bottom and the nuclear instruments below range stay neutral', () => {
    const read = (of: string) => facts.tripped.find((observation: Observation) => path(observation) === of)
    expect(read('dieselGeneratorA.running')).toMatchObject({ value: true, priority: 'none' })
    expect(read('core.rodsOnBottom')).toMatchObject({ value: true, priority: 'none' })
    expect(read('core.powerRangePercent').priority).toBe('none')
    expect(read('core.powerRangePercent').value).toBeLessThan(2)
    expect(read('core.sourceRangeCountRateCps').priority).toBe('none')
  })

  test('expected.after: an alarm the trip brings in leaves its value neutral and says so', () => {
    const level = facts.tripped.find((observation: Observation) => path(observation) === 'sgA.levelPercent')
    expect(level).toMatchObject({ priority: 'none', expected: { after: 'Reactor trip' }, why: 'Steam generator A low-low level, expected after Reactor trip' })
  })

  test('since: a discrete value holds from its last change in the Run\'s record; a number has none', () => {
    const rods = facts.tripped.find((observation: Observation) => path(observation) === 'core.rodsOnBottom')
    expect(Date.parse(rods.since.at)).toBeGreaterThan(Date.parse('2026-01-01T10:00:25.000Z'))
    expect(Date.parse(rods.since.at)).toBeLessThanOrEqual(Date.parse('2026-01-01T10:01:30.000Z'))
    expect(rods.since.clock).toBe('simulation')
    expect(facts.tripped.filter((observation: Observation) => observation.since !== undefined && typeof observation.value === 'number').map(path)).toEqual([])
  })
})
