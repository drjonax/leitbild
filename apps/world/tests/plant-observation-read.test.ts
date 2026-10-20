import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { priorityOrder } from '../src/packs/process-plant/ic/alarm-philosophy.ts'
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
let turbineTripped: SteadyPlantRun
const limitsOf = new Map<string, ReadonlyArray<string>>()
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
  if ('observables' in declaration!) for (const observable of declaration.observables) limitsOf.set(path({ ref: observable.ref } as Observation), observable.thresholds.map(threshold => threshold.id))
  await plant.runTo(10_000)
  facts.leadAtPower = await lead()
  facts.atPower = await readAll()
  facts.atPowerPlant = { mode: (await plant.invoke(plantOperator, 'world.process-plant.display.sample', { paths: ['core.powerRangePercent'] })).mode, alarms: (await plant.invoke(plantOperator, 'world.process-plant.alarms.status', {})).summary }
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
  facts.alerts = plant.unit().alerts
  // A second unit: the turbine tripped at 10:00:10, read a minute on (the eval lane's spot check on Unit 2).
  turbineTripped = await createSteadyPlantRun()
  await turbineTripped.runTo(10_000)
  await turbineTripped.invoke(plantOperator, 'world.process-plant.action.invoke', { actionId: 'turbine-trip', parameters: {} })
  await turbineTripped.runTo(70_000)
  const trippedPort = turbineTripped.run.observations(plantOperator)
  facts.afterTurbineTrip = []
  for (let at = 0; at < refs.length; at += 64) facts.afterTurbineTrip.push(...(await trippedPort.read({ refs: refs.slice(at, at + 64).map(ref => `${turbineTripped.plantId}${ref.slice(ref.indexOf('#'))}`) })).observations)
  facts.afterTurbineTripAlerts = turbineTripped.unit().alerts
})

afterAll(async () => {
  await plant.remove()
  await turbineTripped.remove()
})

/** The alert a value's colour comes from: active, of its priority, under its title, naming one of the value's limits and the value where it names one. */
const alertFor = (alerts: ReadonlyArray<any>, observation: Observation) => alerts.find(alert => alert.returned !== true && alert.priority === observation.priority
  && alert.message === observation.why && (limitsOf.get(path(observation)) ?? []).includes(alert.threshold) && (alert.observable === undefined || alert.observable === observation.ref))

describe('plant observation read (P3)', () => {
  test('at power every declared value reads, good and neutral; an undeclared one is unknown', () => {
    // On a failure the evidence prints: each value off neutral or off good with what set it, the plant's mode and alarms, and the plant time.
    const evidence = `plant at 10:00:10: ${JSON.stringify(facts.atPowerPlant)}`
    expect(facts.atPower, evidence).toHaveLength(refs.length)
    expect(facts.atPower.filter((observation: Observation) => observation.priority !== 'none' || observation.quality !== 'good')
      .map((observation: Observation) => ({ ref: path(observation), value: observation.value, priority: observation.priority, quality: observation.quality, why: observation.why, at: observation.at })), evidence).toEqual([])
    expect(facts.atPower.filter((observation: Observation) => observation.clock !== 'simulation' || observation.at !== '2026-01-01T10:00:10.000Z')
      .map((observation: Observation) => ({ ref: path(observation), at: observation.at, clock: observation.clock })), evidence).toEqual([])
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

  test('T05: a value in caution or worse has its active alert in the unit\'s slot, which names its limit and the value', () => {
    for (const [read, alerts] of [[facts.tripped, facts.alerts], [facts.afterTurbineTrip, facts.afterTurbineTripAlerts]] as const) {
      const coloured = read.filter((observation: Observation) => priorityOrder[observation.priority] >= priorityOrder.caution)
      expect(coloured.length).toBeGreaterThan(0)
      expect(coloured.filter((observation: Observation) => alertFor(alerts, observation) === undefined).map(path)).toEqual([])
    }
  })

  test('T05 a minute after a turbine trip: low Tavg is coloured by the feedwater isolation, named in the slot; the shut stop valve is neutral', () => {
    const read = (of: string) => facts.afterTurbineTrip.find((observation: Observation) => path(observation) === of)
    const tavg = read('vessel.meanPrimaryCoolantTemperatureC')
    expect(tavg).toMatchObject({ priority: 'alarm', why: 'Feedwater isolation on reactor trip, low Tavg' })
    expect(alertFor(facts.afterTurbineTripAlerts, tavg)).toMatchObject({ kind: 'trip', threshold: 'reactor-trip-low-tavg-feedwater-isolation', observable: tavg.ref })
    // Its trip stands latched, but its condition (power operation, power above 50 %) no longer holds: the valve shut after it is no news.
    expect(read('turbineStopValve.effectivePositionFraction')).toMatchObject({ value: 0, priority: 'none' })
    expect(facts.afterTurbineTripAlerts.find((alert: any) => alert.threshold === 'reactor-turbine-trip')).toMatchObject({ latched: true })
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
