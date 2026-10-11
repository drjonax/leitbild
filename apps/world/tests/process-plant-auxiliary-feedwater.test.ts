import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { headerPressureBalance } from '../src/packs/process-plant/runtime/behaviors/junction/header-pressure-balance.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Auxiliary feedwater of the four-loop reference PWR: two motor-driven pumps
// of 440 gpm (27.6 kg/s) and a turbine-driven one of 880 gpm (55.2 kg/s)
// discharge into one header, which feeds each steam generator through its
// own valve and line. The header's pressure settles where the pumps' curves
// deliver what the open lines pass to their generators.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:afw', loopCount: 4 }))
const graph = plant.graph
const loops = ['A', 'B', 'C', 'D'] as const
const ratedFlowKgPerS = { auxFeedwaterPumpMotor: 27.6, auxFeedwaterPumpMotorB: 27.6, auxFeedwaterPumpTurbine: 55.2 } as const
const pumps = Object.keys(ratedFlowKgPerS) as ReadonlyArray<keyof typeof ratedFlowKgPerS>

const started = (withIc = true, system = plant) => {
  const runtime = createProcessPlantRuntime({ system })
  const protection = createProcessPlantProtectionRunner({ system, protection: system.automation })
  const read = (path: string): number => Number(runtime.readVariable(path as VariablePath))
  const tag = (tagId: string): number => Number(runtime.readVariable(resolveProcessPlantSignalBinding(graph, { tagId: tagId as never }).path))
  const set = (path: string, value: boolean | number): void => runtime.writeCommand({ type: 'setVariable', path: path as VariablePath, value })
  const run = (seconds: number, each?: () => void): void => {
    for (let second = 0; second < seconds; second += 1) {
      runtime.tick(1_000)
      if (withIc) protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-afw' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
      each?.()
    }
  }
  const act = (actionId: string, parameters: Readonly<Record<string, unknown>> = {}): void => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters, graph })) set(command.path, command.value as boolean | number)
  }
  const active = (): ReadonlyArray<string> => {
    const snapshot = protection.snapshot()
    return [...snapshot.alarms, ...snapshot.trips].filter(lifecycle => lifecycle.active).map(lifecycle => lifecycle.id)
  }
  return { runtime, read, tag, set, run, act, active }
}

describe('auxiliary feedwater', () => {
  test('after a loss of main feedwater feeds each generator a quarter of the three pumps\' rated 110 kg/s', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    plantRun.run(300)
    const { tag, read } = plantRun
    const flows = loops.map(loop => tag(`AFW-${loop}-FLOW`))
    // The generators stand at about their 7.6 MPa no-load pressure, where the lines are sized to pass the
    // pumps' rated flow at their 9 MPa rated head.
    for (const loop of loops) expect(read(`sg${loop}.pressureMPa`)).toBeGreaterThan(7.4)
    for (const flow of flows) {
      expect(flow).toBeGreaterThan(25)
      expect(flow).toBeLessThan(30)
      expect(Math.abs(flow - flows[0]!)).toBeLessThan(0.01 * flows[0]!)
    }
    expect(tag('AFW-FLOW')).toBeCloseTo(flows.reduce((total, flow) => total + flow, 0), 6)
    expect(tag('AFW-FLOW')).toBeGreaterThan(100)
    expect(tag('AFW-FLOW')).toBeLessThan(115)
    expect(read('auxFeedwaterHeader.pressureNodeMPa')).toBeGreaterThan(8.8)
    expect(read('auxFeedwaterHeader.pressureNodeMPa')).toBeLessThan(9.6)
    // Each generator's feedwater inflow is its auxiliary feedwater, main feedwater being lost.
    for (const loop of loops) expect(read(`sg${loop}.feedwaterFlowKgPerS`)).toBeCloseTo(tag(`AFW-${loop}-FLOW`), 6)
  })

  test('with one line open, that generator takes what the line passes, and the pumps run back along their curves', () => {
    const plantRun = started(false)
    plantRun.run(5)
    for (const pump of pumps) plantRun.set(`${pump}.running`, true)
    for (const loop of loops) plantRun.set(`auxFeedwaterValve${loop}.positionFraction`, loop === 'B' ? 1 : 0)
    // The turbine-driven pump takes its 30 s run-up to come to speed.
    plantRun.run(60)
    const { read, tag } = plantRun
    // About 44 kg/s into a generator at 6.9 MPa, not the pumps' 110 kg/s.
    expect(tag('AFW-B-FLOW')).toBeGreaterThan(35)
    expect(tag('AFW-B-FLOW')).toBeLessThan(50)
    for (const loop of ['A', 'C', 'D']) expect(tag(`AFW-${loop}-FLOW`)).toBe(0)
    for (const pump of pumps) expect(read(`${pump}.flowKgPerS`)).toBeLessThan(0.5 * ratedFlowKgPerS[pump])
    // What the tank gives is what the pumps deliver, and what the generator takes (the lines read a solver step apart).
    const suction = read('aux-feedwater-tank-to-motor-pump.flowKgPerS') + read('aux-feedwater-tank-to-motor-pump-b.flowKgPerS') + read('aux-feedwater-tank-to-turbine-pump.flowKgPerS')
    expect(suction).toBeCloseTo(tag('AFW-B-FLOW'), 2)
    expect(read('auxFeedwaterHeader.flowBalanceResidualKgPerS')).toBeCloseTo(0, 2)
    // The header stands near the pumps' shutoff head, above their 9 MPa rated head.
    expect(read('auxFeedwaterHeader.pressureNodeMPa')).toBeGreaterThan(10)
    expect(read('auxFeedwaterValveB.availablePressureDropMPa')).toBeCloseTo(read('auxFeedwaterHeader.pressureNodeMPa') - read('sgB.pressureMPa'), 1)
  })

  test('a generator at lower pressure takes more than its share', () => {
    const plantRun = started(false)
    plantRun.run(5)
    for (const pump of pumps) plantRun.set(`${pump}.running`, true)
    for (const loop of loops) plantRun.set(`auxFeedwaterValve${loop}.positionFraction`, 1)
    plantRun.run(5)
    const header = graph.components[graph.componentIndexById.get('auxFeedwaterHeader' as never)!]!
    const known = new Set(graph.variables.map(variable => variable.path))
    const balanceWith = (overrides: ReadonlyMap<string, number>) => headerPressureBalance(plant, header, {
      has: path => known.has(path),
      readNumber: path => overrides.get(path) ?? plantRun.read(path),
      readBoolean: path => plantRun.runtime.readVariable(path) === true,
    })
    const branchOf = (loop: string): number => graph.links.find(link => link.id === `aux-feedwater-header-to-valve-${loop.toLowerCase()}`)!.index
    const even = balanceWith(new Map(loops.map(loop => [`sg${loop}.pressureMPa`, 7.6])))
    const faulted = balanceWith(new Map(loops.map(loop => [`sg${loop}.pressureMPa`, loop === 'A' ? 5.6 : 7.6])))
    expect(even.branchFlowKgPerS.get(branchOf('A'))!).toBeCloseTo(even.branchFlowKgPerS.get(branchOf('B'))!, 6)
    expect(faulted.branchFlowKgPerS.get(branchOf('A'))!).toBeGreaterThan(1.5 * faulted.branchFlowKgPerS.get(branchOf('B'))!)
    expect(faulted.branchFlowKgPerS.get(branchOf('B'))!).toBeLessThan(even.branchFlowKgPerS.get(branchOf('B'))!)
    // The pumps deliver what the lines pass, at a lower header pressure.
    const total = (flows: ReadonlyMap<number, number>): number => [...flows.values()].reduce((sum, flow) => sum + flow, 0)
    expect(total(faulted.pumpFlowKgPerS)).toBeCloseTo(total(faulted.branchFlowKgPerS), 3)
    expect(faulted.pressureMPa).toBeLessThan(even.pressureMPa)
  })

  test('started by one generator\'s low-low level, the motor-driven pumps feed every generator, not that one alone', () => {
    // Feedwater control valve B fails to 35 % at full power; generator B boils down to its low-low level.
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('steam-generator-b-feedwater-runback', { positionPercent: 35 })
    let afwStartedAt: number | null = null
    for (let second = 1; second <= 200 && afwStartedAt === null; second += 1) {
      plantRun.run(1)
      if (plantRun.read('auxFeedwaterPumpMotor.runningState') === 1) afwStartedAt = second
    }
    expect(afwStartedAt).not.toBeNull()
    // As they start, only generator B is at low-low level, so the turbine-driven pump, which wants two, stays off.
    const { tag, read } = plantRun
    expect(tag('SG-B-LVL-NR')).toBeLessThan(20)
    for (const loop of ['A', 'C', 'D']) expect(tag(`SG-${loop}-LVL-NR`)).toBeGreaterThan(20)
    // Ten seconds on, the two motor-driven pumps, running out along their curves, feed all four lines; the
    // turbine-driven pump, started as the trip shrinks a second generator below its low-low level, is still running up.
    plantRun.run(10)
    expect(read('auxFeedwaterPumpMotorB.runningState')).toBe(1)
    expect(read('auxFeedwaterPumpTurbine.flowKgPerS')).toBe(0)
    expect(tag('AFW-FLOW')).toBeGreaterThan(60)
    expect(tag('AFW-FLOW')).toBeLessThan(75)
    // About a quarter each; generator B, at slightly lower pressure, a little more.
    const others = ['A', 'C', 'D'].map(loop => tag(`AFW-${loop}-FLOW`))
    for (const flow of [...others, tag('AFW-B-FLOW')]) {
      expect(flow).toBeGreaterThan(14)
      expect(flow).toBeLessThan(20)
    }
    expect(tag('AFW-B-FLOW') / (others.reduce((sum, flow) => sum + flow, 0) / others.length)).toBeLessThan(1.15)
    // Feedwater isolation on the trip has shut every feed regulating valve, so the other generators shrink to their
    // low-low level too, and with two of them there the turbine-driven pump joins: some 28 kg/s into each.
    let turbinePumpAt: number | null = null
    for (let second = 1; second <= 120 && turbinePumpAt === null; second += 1) {
      plantRun.run(1)
      if (read('auxFeedwaterPumpTurbine.runningState') === 1) turbinePumpAt = second
    }
    expect(turbinePumpAt).not.toBeNull()
    expect(['A', 'C', 'D'].filter(loop => tag(`SG-${loop}-LVL-NR`) < 20).length).toBeGreaterThanOrEqual(2)
    // A minute on, past its run-up, it delivers its rated flow.
    plantRun.run(60)
    for (const loop of ['A', 'B', 'C', 'D']) {
      expect(tag(`AFW-${loop}-FLOW`)).toBeGreaterThan(25)
      expect(tag(`AFW-${loop}-FLOW`)).toBeLessThan(31)
    }
  })

  test('starts the turbine-driven pump once two generators reach low-low level', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    let bothLowAt: number | null = null
    let turbinePumpAt: number | null = null
    for (let second = 1; second <= 200 && turbinePumpAt === null; second += 1) {
      plantRun.run(1)
      if (bothLowAt === null && loops.filter(loop => plantRun.tag(`SG-${loop}-LVL-NR`) < 20).length >= 2) bothLowAt = second
      if (plantRun.read('auxFeedwaterPumpTurbine.runningState') === 1) turbinePumpAt = second
    }
    // The motor-driven pumps started with the main feedwater pumps' trip; the turbine-driven one waits for the
    // second generator's low-low level, and its one-second delay.
    expect(bothLowAt).not.toBeNull()
    expect(turbinePumpAt).not.toBeNull()
    expect(turbinePumpAt! - bothLowAt!).toBeGreaterThanOrEqual(1)
    expect(turbinePumpAt! - bothLowAt!).toBeLessThanOrEqual(3)
    expect(plantRun.read('auxFeedwaterPumpMotor.runningState')).toBe(1)
  })

  test('the turbine-driven pump runs up over 30 s and delivers its rated flow within a minute of its start signal', () => {
    // A Terry turbine comes from cold standby to full load within 30 s (NRC RCIC training, ML11258A312); every
    // pump delivers rated flow within a minute of its automatic start (Westinghouse Technology Systems Manual 5.7).
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    let startedAt: number | null = null
    const trace: Array<{ readonly second: number; readonly rpm: number; readonly flow: number }> = []
    for (let second = 1; second <= 200; second += 1) {
      plantRun.run(1)
      if (startedAt === null && plantRun.read('auxFeedwaterPumpTurbine.runningState') === 1) startedAt = second
      if (startedAt !== null) trace.push({ second: second - startedAt, rpm: plantRun.tag('TDAFW-SPEED'), flow: plantRun.read('auxFeedwaterPumpTurbine.flowKgPerS') })
      if (startedAt !== null && second - startedAt >= 60) break
    }
    expect(startedAt).not.toBeNull()
    const at = (second: number) => trace.find(point => point.second === second)!
    // Its speed rises evenly to its rated 3,600 rpm; until its head passes the generators' pressure it delivers nothing.
    expect(at(15).rpm).toBeCloseTo(1_920, -1)
    expect(at(15).flow).toBe(0)
    expect(at(20).flow).toBe(0)
    expect(at(30).rpm).toBeCloseTo(3_600, 0)
    expect(at(60).flow).toBeGreaterThan(0.95 * ratedFlowKgPerS.auxFeedwaterPumpTurbine)
    const fullFlowAt = trace.find(point => point.flow > 0.9 * ratedFlowKgPerS.auxFeedwaterPumpTurbine)!.second
    expect(fullFlowAt).toBeGreaterThan(30)
    expect(fullFlowAt).toBeLessThan(60)
  })

  test('puts every kilogram it feeds into the generator\'s inventory', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    plantRun.run(120)
    const { read } = plantRun
    const before = read('sgA.secondaryInventoryKg')
    let fed = 0
    let boiled = 0
    plantRun.run(180, () => {
      fed += read('aux-feedwater-valve-a-to-sg-a.flowKgPerS')
      boiled += read('sgA.boilingRateKgPerS')
    })
    // After the trip decay heat boils off less than auxiliary feedwater brings in, and the generator fills.
    expect(fed).toBeGreaterThan(4_000)
    expect(read('sgA.secondaryInventoryKg') - before).toBeGreaterThan(1_000)
    expect(Math.abs(read('sgA.secondaryInventoryKg') - before - (fed - boiled))).toBeLessThan(0.01 * fed)
  })
})

describe('condensate storage tank', () => {
  // 450,000 gal (1,700 m3), whose lowest 280,000 gal (62 %) are the Technical Specification reserve for auxiliary
  // feedwater (USNRC Westinghouse Technology Systems Manual 5.7; Sequoyah keeps 240,000 of its 385,000 gal).
  test('at the pumps\' full flow falls about 0.4 % a minute, so its reserve lasts hours, and alarms as the level enters it', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    plantRun.run(180)
    const { read, tag } = plantRun
    expect(read('auxFeedwaterTank.inventoryKg') / read('auxFeedwaterTank.levelPercent') * 100).toBeCloseTo(1_690_000, -3)
    const before = tag('CST-LVL')
    plantRun.run(120)
    const fallPerMinute = (before - tag('CST-LVL')) / 2
    expect(tag('AFW-FLOW')).toBeGreaterThan(100)
    expect(fallPerMinute).toBeGreaterThan(0.35)
    expect(fallPerMinute).toBeLessThan(0.45)
    // The reserve alone feeds the pumps' full flow for over two hours.
    expect(0.62 * 1_690_000 / tag('AFW-FLOW') / 3_600).toBeGreaterThan(2.4)
    expect(plantRun.active()).not.toContain('alarm:condensate-storage-tank-level-low:level-low')
  })

  test('alarms as auxiliary feedwater draws the level into the reserve', () => {
    const drawnDown = compileProcessPlant(createPwrReferencePlantDefinition({
      id: 'plant:afw-cst',
      loopCount: 4,
      valueOverrides: { 'auxFeedwaterTank.inventoryKg': 0.63 * 1_690_000, 'auxFeedwaterTank.levelPercent': 63 },
    }))
    const plantRun = started(true, drawnDown)
    plantRun.run(5)
    expect(plantRun.active()).not.toContain('alarm:condensate-storage-tank-level-low:level-low')
    plantRun.act('loss-main-feedwater')
    let alarmedAt: number | null = null
    for (let second = 1; second <= 400 && alarmedAt === null; second += 1) {
      plantRun.run(1)
      if (plantRun.active().includes('alarm:condensate-storage-tank-level-low:level-low')) alarmedAt = second
    }
    expect(alarmedAt).not.toBeNull()
    expect(plantRun.tag('CST-LVL')).toBeLessThan(62)
    expect(plantRun.tag('CST-LVL')).toBeGreaterThan(61.5)
  })
})
