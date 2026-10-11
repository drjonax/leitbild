import { describe, expect, test } from 'bun:test'
import { embeddedViewContentSchema } from '@leitbild/contracts'
import type { IsoTimestamp, SimulationRunId } from '../src/core/model/index.ts'
import { recordingSeriesIdFor } from '../src/core/model/index.ts'
import {
  answerProcessPlantQuery,
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance } from '../src/packs/process-plant/runtime-instance.ts'
import { recordedPlantVariables } from '../src/packs/process-plant/recording.ts'
import type { CompiledComposedDisplay } from '../src/packs/process-plant/displays/compose.ts'
import { COMPOSED_DISPLAY_MAX_HEIGHT_PX, COMPOSED_MIMIC_DISPLAY_MAX_HEIGHT_PX, composedDisplayStateSchema, type DisplayEvidence } from '../src/packs/process-plant/displays/composition.ts'
import type { PackRuntimeRecordedHistory } from '../src/simulation/protocol.ts'

// Evaluation run 22's situations on the four-loop reference Plant: the fault,
// then the minutes the probe played, with protection evaluated and the Run's
// operations profile recorded each second; then the display the agent composed
// in that run. World adds what the model says bears on the question.

const START = Date.parse('2026-10-11T10:00:00.000Z')

/** What a test may do to the Plant after the fault and the minutes it played: step it a second, write a signal, read one. */
interface Operator {
  readonly step: () => void
  readonly write: (tagId: string, value: number | boolean) => void
  readonly tag: (tagId: string) => unknown
}

const situation = (fault: { readonly actionId: string; readonly parameters?: Record<string, unknown> } | null, minutes: number, operate?: (operator: Operator) => void) => {
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:evidence', loopCount: 4 }))
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const system = { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), protection, performance: createProcessPlantRuntimePerformance() }
  const recorded = recordedPlantVariables(plant, 'operations')
  const recordedSeriesIds = new Set(recorded.map(variable => recordingSeriesIdFor(plant.id, variable.path)))
  const series = new Map<string, Array<{ readonly simulationTime: string; readonly value: unknown }>>()
  let now = START
  const step = () => {
    runtime.tick(1_000)
    now += 1_000
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-evidence' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    for (const variable of recorded) {
      const id = recordingSeriesIdFor(plant.id, variable.path)
      series.set(id, [...(series.get(id) ?? []), { simulationTime: new Date(now).toISOString(), value: runtime.readVariable(variable.path) }])
    }
  }
  step()
  for (const command of fault === null ? [] : commandsForProcessPlantAction({ actionId: fault.actionId, parameters: fault.parameters ?? {}, graph: plant.graph })) {
    runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  }
  for (let second = 0; second < minutes * 60; second += 1) step()
  const pathOf = (tagId: string) => plant.graph.signalBindingByTagId.get(tagId as never)!.path
  operate?.({ step, write: (tagId, value) => runtime.writeCommand({ type: 'setVariable', path: pathOf(tagId), value }), tag: tagId => runtime.readVariable(pathOf(tagId)) })
  // The newest samples first, as the historian reads a series window.
  const recordedHistory: PackRuntimeRecordedHistory = {
    read: query => (series.get(query.seriesId) ?? [])
      .filter(sample => sample.simulationTime >= query.from && sample.simulationTime <= query.to).slice().reverse().slice(0, query.limit)
      .map((sample, sequence) => ({ runtimeId: 'process-plant', sequence: sequence + 1, seriesId: query.seriesId, observedAt: sample.simulationTime as IsoTimestamp, simulationTime: sample.simulationTime as IsoTimestamp, value: sample.value as number, quality: 'good' as const })),
  }
  const ask = (capabilityId: string, input: unknown) => answerProcessPlantQuery({
    request: { capabilityId, input },
    plants: new Map([[plant.id, system]]),
    objects: new Map(),
    simulationTime: new Date(now).toISOString() as IsoTimestamp,
    recordedSeriesIds,
    recordedHistory,
  })
  const compose = (title: string, subjects: ReadonlyArray<string>, panels: ReadonlyArray<unknown>) => {
    const result = ask('world.process-plant.display.compose', { plantId: plant.id, title, question: `${title}: what is going on?`, need: 'Decide the response', subjects, panels }) as {
      view: { state: string; height: number }
      shows: ReadonlyArray<string>
      margins: ReadonlyArray<string>
      viewContent: unknown
    }
    const state = composedDisplayStateSchema.parse(JSON.parse(result.view.state))
    const reopened = ask('world.process-plant.display.view', { plantId: plant.id, state: result.view.state }) as { display: CompiledComposedDisplay }
    return { result, evidence: state.evidence ?? [], display: reopened.display }
  }
  return { system, compose, read: (path: string) => runtime.readVariable(path as never) }
}

const once = <T>(make: () => T): (() => T) => {
  let made: T | undefined
  return () => (made ??= make())
}

const signal = (ref: string, role = 'context') => ({ ref, role })
const listed = (evidence: ReadonlyArray<DisplayEvidence>) => evidence.map(entry => [entry.path, entry.kind])

const runback = once(() => situation({ actionId: 'steam-generator-b-feedwater-runback', parameters: { positionPercent: 35 } }, 3))
const atPower = once(() => situation(null, 1))

describe('what World adds to a composed display', () => {
  test('SG B runback: the feed valve that does not follow its demand, its wide-range level, the auxiliary feed into SG B and a healthy steam generator', () => {
    // Run 22: SG B level at 0 % three minutes after FCV B ran back to 35 %, the unit tripped into Hot standby. The
    // agent trended SG B's level, feed and steam flow; both reviewers missed FCV B and a healthy reference SG, and the
    // operator asked for the wide-range level. Feedwater isolation now shuts every feed regulating valve: FCV B,
    // failed at 35 %, does not follow it; with the other valves shut, A, C and D reach low-low level too, and the
    // turbine-driven pump joins. Six values fill the slots: the isolated main feed is left out.
    const { compose, read } = runback()
    const { result, evidence, display } = compose('SG B low-low and feedwater response', ['SG-B-LVL-NR'], [
      { kind: 'trend', horizon: '10m', signals: [signal('SG-B-LVL-NR', 'primary'), signal('sgB.feedwaterFlowKgPerS'), signal('sgB.steamOutflowKgPerS')] },
      { kind: 'alarms', scope: 'related' },
    ])
    expect(listed(evidence)).toEqual([
      ['feedwaterControlValveB.effectivePositionFraction', 'cause'],
      ['feedwaterControlValveB.positionFraction', 'cause'],
      ['sgB.wideRangeLevelPercent', 'wider'],
      ['aux-feedwater-valve-b-to-sg-b.flowKgPerS', 'delivers'],
      ['auxFeedwaterHeader.outletFlowKgPerS', 'delivers'],
      ['sgA.levelPercent', 'reference'],
    ])
    expect([read('feedwaterControlValveB.effectivePositionFraction'), read('feedwaterControlValveB.positionFraction')]).toEqual([expect.closeTo(0.35, 2), 0])
    expect(read('sgB.levelPercent')).toBe(0)
    expect(read('sgB.wideRangeLevelPercent')).toBeGreaterThan(15)
    expect(read('aux-feedwater-valve-b-to-sg-b.flowKgPerS')).toBeGreaterThan(20)
    expect(evidence[0]!.reason).toBe('FCV B does not follow its demand (CMD SHUT)')
    expect(evidence[2]!.reason).toBe('SG-B-LVL-NR reads below its span: the same quantity on the instrument with the wider span')
    // Named by the action that judges the shown level, though every start lines the feed up to SG B.
    expect(evidence[3]!.reason).toBe('Steam generator B low-low level auxiliary feedwater actuation: its flow into SG B')
    expect(evidence[5]!.reason).toBe('the same reading on loop A, the healthiest other loop')
    // In one labelled panel over the alarms, within a chat view's height; the agent's panels keep their order.
    expect(display.panels.map(panel => panel.kind)).toEqual(['trend', 'readouts', 'alarms'])
    const added = display.panels[1]!
    if (added.kind !== 'readouts') throw new Error('expected the added readouts')
    expect(added.added).toBe(true)
    expect(added.pens.map(pen => pen.added?.kind)).toEqual(['cause', 'cause', 'wider', 'delivers', 'delivers', 'reference'])
    expect(result.view.height).toBeLessThanOrEqual(COMPOSED_DISPLAY_MAX_HEIGHT_PX)
    expect(display.height).toBe(result.view.height)
    // The agent is told, and may cite them: they are in what the view shows.
    expect(result.shows.join('\n')).toContain('World added these readouts, each labelled as added')
    const content = embeddedViewContentSchema.parse(result.viewContent)
    expect(content.items.some(item => item.names.includes('MFW-B-CV-POS'))).toBe(true)
  }, 60_000)

  const relief = once(() => situation({ actionId: 'pressurizer-relief-open', parameters: { positionPercent: 35 } }, 3))

  test('PORV open: the safety injection it set off and the subcooling margin fill the free places of the agent\'s readouts', () => {
    // Run 22: pressure 10.7 MPa falling with the PORV stuck at 35 %; the display showed no subcooling margin. After
    // the trip the overview leads with it (core cooling, the first critical safety function it checks), so it is
    // added; containment pressure, at normal, is no lead.
    const { compose, read } = relief()
    const { evidence, display, result } = compose('Pressurizer depressurization', ['PT-455', 'PORV-456A', 'PZR-LVL'], [
      { kind: 'trend', horizon: '2m', signals: [signal('PT-455', 'primary'), signal('PZR-LVL')] },
      { kind: 'readouts', signals: [signal('pressurizer.reliefFlowKgPerS'), signal('PORV-456A-POS'), signal('PORV-456A'), signal('MOV-8000A-POS')] },
      { kind: 'alarms', scope: 'related' },
    ])
    expect(listed(evidence)).toEqual([['safetyInjectionHeader.outletFlowKgPerS', 'delivers'], ['vessel.subcoolingMarginC', 'mode']])
    expect(read('safetyInjectionHeader.outletFlowKgPerS')).toBeGreaterThan(30)
    expect(evidence[1]!.reason).toBe('what the unit leads with in Hot standby')
    // The four readouts left two places in their second row: no panel and no height are added.
    expect(display.panels.map(panel => panel.kind)).toEqual(['trend', 'readouts', 'alarms'])
    const readouts = display.panels[1]!
    if (readouts.kind !== 'readouts') throw new Error('expected the readouts')
    expect(readouts.added).toBeUndefined()
    expect(readouts.pens.map(pen => pen.added?.kind ?? null)).toEqual([null, null, null, null, 'delivers', 'mode'])
    expect(result.view.height).toBe(COMPOSED_DISPLAY_MAX_HEIGHT_PX)
  }, 60_000)

  test('PORV open as run 22 composed it: with no room for a panel of their own, the values join the agent\'s readouts in a row of their own', () => {
    // Run 22 QA: the display added nothing three minutes in. Its trend has two strips and a live row, and its three
    // readouts fill their row: a labelled panel of the safety injection and the subcooling margin needed 662 px of
    // the 660 a chat view allows, so both were dropped.
    const { compose, read } = relief()
    const { evidence, display, result } = compose('Unit 2 pressurizer depressurization', ['PT-455', 'PORV-456A', 'PZR-LVL'], [
      { kind: 'trend', horizon: '2m', signals: [signal('PT-455', 'primary'), signal('pressurizer.reliefFlowKgPerS'), signal('PZR-LVL', 'counter-evidence')] },
      { kind: 'readouts', signals: [signal('PORV-456A-POS', 'primary'), signal('PORV-456A'), signal('MOV-8000A-POS')] },
      { kind: 'alarms', scope: 'related' },
    ])
    expect(listed(evidence)).toEqual([['safetyInjectionHeader.outletFlowKgPerS', 'delivers'], ['vessel.subcoolingMarginC', 'mode']])
    expect(display.panels.map(panel => panel.kind)).toEqual(['trend', 'readouts', 'alarms'])
    const readouts = display.panels[1]!
    if (readouts.kind !== 'readouts') throw new Error('expected the readouts')
    expect(readouts.added).toBeUndefined()
    expect(readouts.pens.map(pen => pen.added?.kind ?? null)).toEqual([null, null, null, 'delivers', 'mode'])
    expect(result.view.height).toBeLessThanOrEqual(COMPOSED_DISPLAY_MAX_HEIGHT_PX)
    expect(read('vessel.subcoolingMarginC')).toBeGreaterThan(16.7)
  }, 60_000)

  test('loss of main feedwater and turbine trip: the auxiliary feedwater the actuation delivers, and the loops the display left out', () => {
    // Run 22: both displays showed no AFW flow, and the turbine-trip one only SG A and B. With every narrow-range
    // level at 0 %, the wide-range levels say where the inventory is, as a heat-sink judgement wants (FR-H.1).
    const lossOfFeed = situation({ actionId: 'loss-main-feedwater' }, 2)
    const feed = lossOfFeed.compose('SG inventory after feedwater loss', ['SG-A-LVL-NR'], [
      { kind: 'trend', horizon: '2m', signals: ['A', 'B', 'C', 'D'].map(loop => signal(`SG-${loop}-LVL-NR`, 'primary')) },
      { kind: 'alarms', scope: 'related' },
    ])
    expect(listed(feed.evidence)).toEqual([
      ...['A', 'B', 'C', 'D'].map(loop => [`sg${loop}.wideRangeLevelPercent`, 'wider']),
      ['auxFeedwaterHeader.outletFlowKgPerS', 'delivers'],
      ['feedwaterHeader.outletFlowKgPerS', 'isolates'],
    ])
    expect(lossOfFeed.read('sgA.levelPercent')).toBe(0)
    expect(lossOfFeed.read('sgA.wideRangeLevelPercent')).toBeGreaterThan(15)
    expect(lossOfFeed.read('auxFeedwaterHeader.outletFlowKgPerS')).toBeGreaterThan(100)
    expect(feed.result.view.height).toBeLessThanOrEqual(COMPOSED_DISPLAY_MAX_HEIGHT_PX)

    const turbineTrip = situation({ actionId: 'turbine-trip' }, 1)
    const trip = turbineTrip.compose('Post turbine trip watch', ['SG-A-LVL-NR', 'PT-455', 'PZR-LVL'], [
      { kind: 'trend', horizon: '10m', signals: [signal('SG-A-LVL-NR', 'primary'), signal('SG-B-LVL-NR'), signal('PT-455'), signal('PZR-LVL')] },
      { kind: 'alarms', scope: 'related' },
    ])
    // With feedwater isolated on the trip, SG A has fallen to the low-low level that starts auxiliary feedwater within
    // the minute: what it delivers, then C and D.
    expect(listed(trip.evidence)).toEqual([
      ['auxFeedwaterHeader.outletFlowKgPerS', 'delivers'],
      ['sgC.levelPercent', 'reference'],
      ['sgD.levelPercent', 'reference'],
    ])
    expect(trip.evidence[0]!.reason).toBe('Steam generator A low-low level auxiliary feedwater actuation: what it delivers')
    // One row was all the chat view had room for: the isolated main feed is left out.
    expect(trip.result.view.height).toBeLessThanOrEqual(COMPOSED_DISPLAY_MAX_HEIGHT_PX)
  }, 60_000)

  test('a line-up drawing: the flow its header carries and the flow the pumps drawn feed', () => {
    // Run 22: the SI line-up to loop C, the feedwater line-up and the diesel-to-AFW drawing showed no flows.
    const power = atPower()
    const si = power.compose('Safety injection to loop C', ['safetyInjection', 'C'], [{ kind: 'mimic', services: ['safetyInjection'], loops: ['C'] }, { kind: 'alarms', scope: 'related' }])
    expect(listed(si.evidence)).toEqual([['safetyInjectionHeader.outletFlowKgPerS', 'flow']])
    const feed = power.compose('Main feedwater to steam generators', ['feedwaterHeader'], [{ kind: 'mimic', services: ['feedwater'], to: ['sgA', 'sgB', 'sgC', 'sgD'], reach: 3 }, { kind: 'alarms', scope: 'related' }])
    expect(listed(feed.evidence)).toEqual([['feedwaterHeader.outletFlowKgPerS', 'flow']])
    expect(feed.result.view.height).toBeLessThanOrEqual(COMPOSED_MIMIC_DISPLAY_MAX_HEIGHT_PX)
    const offsite = situation({ actionId: 'loss-offsite-power' }, 1)
    const diesel = offsite.compose('Diesel supply to motor-driven AFW', ['dieselGeneratorA', 'auxFeedwaterPumpMotor'], [
      { kind: 'mimic', to: ['auxFeedwaterPumpMotor', 'auxFeedwaterPumpMotorB'], services: ['electricalPower'], reach: 2 },
      { kind: 'alarms', scope: 'related' },
    ])
    // Powered is not pumping: the pumps' header flow says whether they deliver water. With the pumps coasting down
    // and the loops on natural circulation, the steam generators have shrunk to low-low level within the minute, so
    // it is what that actuation, which starts the drawn pumps, delivers.
    expect(listed(diesel.evidence)).toEqual([['auxFeedwaterHeader.outletFlowKgPerS', 'delivers']])
    expect(diesel.evidence[0]!.reason).toMatch(/^Steam generator [A-D] low-low level auxiliary feedwater actuation: what it delivers$/)
    expect(offsite.read('auxFeedwaterHeader.outletFlowKgPerS')).toBeGreaterThan(50)
  }, 60_000)

  test('a normal plant gets nothing added: a steady level, power and temperature at power', () => {
    const power = atPower()
    for (const panels of [
      [{ kind: 'comparison', signals: ['A', 'B', 'C', 'D'].map(loop => signal(`SG-${loop}-LVL-NR`, 'primary')) }, { kind: 'alarms', scope: 'related' }],
      [{ kind: 'trend', horizon: '10m', signals: [signal('SG-B-LVL-NR', 'primary')] }],
      [{ kind: 'trend', horizon: '10m', signals: [signal('core.powerMw', 'primary')] }],
      [{ kind: 'trend', horizon: '10m', signals: [signal('TAVG', 'primary')] }],
    ]) {
      const { evidence, display } = power.compose('Normal plant values', [(panels[0] as { signals: ReadonlyArray<{ ref: string }> }).signals[0]!.ref], panels)
      expect(evidence).toEqual([])
      expect(display.panels).toHaveLength(panels.length)
    }
  }, 60_000)
})

describe('a limit that on/off states gate, as World reads it', () => {
  test('acts only while its gates hold: below 12.7 MPa with SI blocked, the pressure is past no SI limit', () => {
    // A planned depressurization in hot standby: the reactor tripped, the PORV open, SI blocked as P-11 comes in.
    const blocked = situation(null, 0, operator => {
      operator.write('TRIP-BKR-A', false)
      operator.write('TRIP-BKR-B', false)
      for (let second = 0; second < 30; second += 1) operator.step()
      operator.write('PORV-456A', 1)
      for (let second = 0; second < 600 && Number(operator.tag('PT-455')) > 12.4; second += 1) {
        operator.step()
        if (operator.tag('P-11') === true && operator.tag('SI-BLOCKED') === false) operator.write('SI-BLOCK', true)
      }
    })
    expect(blocked.read('safetyInjectionBlockLogic.blocked')).toBe(true)
    expect(Number(blocked.read('pressurizer.pressureMPa'))).toBeLessThan(12.7)
    const { result } = blocked.compose('Planned depressurization', ['PT-455'], [{ kind: 'trend', horizon: '10m', signals: [signal('PT-455', 'primary')] }])
    // The SI limit is drawn and said to act only while SI-BLOCKED is off; no margin is read against it while blocked.
    expect(result.shows.join('\n')).toContain('"LO-LO 12.7 MPa · SI" automatic action line')
    expect(result.shows.join('\n')).toContain('(only while SI-BLOCKED off)')
    expect(result.margins.join('\n')).not.toContain('· SI')
    expect(result.margins[0]).toMatch(/^PT-455: .*LO 14\.8 MPa · ALM/)
  }, 120_000)

  test('a generator at power is past no limit', () => {
    const { result } = atPower().compose('Generator output', ['GEN-MW'], [{ kind: 'trend', horizon: '10m', signals: [signal('GEN-MW', 'primary')] }])
    expect(result.margins.join('\n')).not.toContain('past')
  }, 60_000)
})
