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
import { composeEvidenceRows, type CompiledComposedDisplay } from '../src/packs/process-plant/displays/compose.ts'
import { COMPOSED_DISPLAY_MAX_HEIGHT_PX, COMPOSED_MIMIC_DISPLAY_MAX_HEIGHT_PX, composedDisplayStateSchema, type DisplayEvidence } from '../src/packs/process-plant/displays/composition.ts'
import type { PackRuntimeRecordedHistory } from '../src/simulation/protocol.ts'
import { guardPlantTests, PLANT_HANG_GUARD_MS } from './plant-hang-guard.ts'

guardPlantTests()

// Evaluation runs 22 and 23's situations on the four-loop reference Plant: the
// fault, then the minutes the probe played, with protection evaluated and the
// Run's operations profile recorded each second; then the display the agent
// composed in that run. World adds what the model says bears on the question.

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
      equipment: ReadonlyArray<{ readonly label: string; readonly state: string }>
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

/** The rows World added, each as its kind, what it names, the words its values are read by and its note. */
const rowsOf = (display: CompiledComposedDisplay) => {
  const panel = display.panels.find(candidate => candidate.kind === 'evidence')
  return panel?.kind !== 'evidence' ? [] : panel.rows.map(row => ({ kind: row.kind, name: row.name, items: row.items.map(item => item.label), ...(row.note === undefined ? {} : { note: row.note }) }))
}
type Row = ReturnType<typeof rowsOf>[number]
const trip: Row = { kind: 'trip', name: '', items: ['NIS-PR-AVG', 'NIS-IR-SUR', 'ROD-BOTTOM', 'TURB-STOP-POS'] }
const afwToEach: Row = { kind: 'delivers', name: '', items: ['AFW-A-FLOW', 'AFW-B-FLOW', 'AFW-C-FLOW', 'AFW-D-FLOW'] }

describe('what World adds to a composed display', () => {
  test('SG B runback: the feed valve that does not follow its demand, as it stood across the onset; the wide range in the legend; the auxiliary feed into SG B, the trip check and a healthy steam generator', () => {
    // Run 22: SG B level at 0 % three minutes after FCV B ran back to 35 %, the unit tripped into Hot standby. Run 23:
    // the CAUSE pair read only as it stands now, 35 % against a demand of 0 %, an over-feed (HMI review); across the
    // onset it is a valve stuck at 35 % while demanded full open, until feedwater isolation shut its demand.
    const { compose, read } = runback()
    const { result, evidence, display } = compose('SG B low-low and feedwater response', ['SG-B-LVL-NR'], [
      { kind: 'trend', horizon: '10m', signals: [signal('SG-B-LVL-NR', 'primary'), signal('sgB.feedwaterFlowKgPerS'), signal('sgB.steamOutflowKgPerS')] },
      { kind: 'alarms', scope: 'related' },
    ])
    expect(listed(evidence).slice(0, 3)).toEqual([
      ['feedwaterControlValveB.effectivePositionFraction', 'cause'],
      ['feedwaterControlValveB.positionFraction', 'cause'],
      ['aux-feedwater-valve-b-to-sg-b.flowKgPerS', 'delivers'],
    ])
    expect([read('feedwaterControlValveB.effectivePositionFraction'), read('feedwaterControlValveB.positionFraction')]).toEqual([expect.closeTo(0.35, 2), 0])
    expect(evidence[0]!.reason).toBe('FCV B does not follow its demand (CMD SHUT)')
    expect(evidence[0]!.note).toMatch(/^35\.0 % since 10:00:0\d; demand 100 % then, 0 % since 10:01:[0-5]\d$/)
    // Named by the action that judges the shown level, though every start lines the feed up to SG B.
    expect(evidence[2]!.reason).toBe('Steam generator B low-low level auxiliary feedwater actuation: its flow into SG B')
    const rows = rowsOf(display)
    expect(rows[0]).toEqual({ kind: 'cause', name: '', items: ['MFW-B-CV-POS', 'MFW-B-CV'], note: evidence[0]!.note! })
    expect(rows).toContainEqual(trip)
    expect(rows).toContainEqual({ kind: 'reference', name: '', items: ['SG-A-LVL-NR'] })
    // The narrow range is off its span: its legend row reads the wide range in its rate's place, so World adds none.
    expect(read('sgB.levelPercent')).toBe(0)
    expect(listed(evidence).map(([, kind]) => kind)).not.toContain('wider')
    expect(result.margins[0]).toMatch(/^SG-B-LVL-NR: <0 % \(WR SG-B-LVL-WR: 2\d\.\d %\)/)
    const content = embeddedViewContentSchema.parse(result.viewContent)
    expect(content.items.find(item => item.names.includes('SG-B-LVL-WR'))?.values[0]?.value).toBeGreaterThan(15)
    expect(content.items.some(item => item.names.includes('MFW-B-CV-POS'))).toBe(true)
    // One panel over the alarms, a line per row, within a chat view's height; the agent's panels keep their order.
    expect(display.panels.map(panel => panel.kind)).toEqual(['trend', 'evidence', 'alarms'])
    expect(result.view.height).toBeLessThanOrEqual(COMPOSED_DISPLAY_MAX_HEIGHT_PX)
    expect(display.height).toBe(result.view.height)
    expect(result.shows.join('\n')).toContain('World added these values from the Plant model')
  }, PLANT_HANG_GUARD_MS)

  const relief = once(() => situation({ actionId: 'pressurizer-relief-open', parameters: { positionPercent: 35 } }, 2))

  test('PORV open: its demand as it stood across the onset, and the block valve that isolates its line, with its position', () => {
    // Run 23: both PORV answers told the operator to close the block valve; neither display showed where it stood.
    // The run-23 composition, at its two minutes: the PORV stuck at 35 % with no demand to open, the reactor not yet tripped.
    const { compose, read } = relief()
    const { evidence, display, result } = compose('Unit 2 pressurizer pressure and relief', ['PT-455', 'PORV-456A-POS', 'pressurizer.reliefFlowKgPerS'], [
      { kind: 'trend', horizon: '2m', signals: [signal('PT-455', 'primary'), signal('pressurizer.reliefFlowKgPerS'), signal('PORV-456A-POS'), signal('SUB-MARGIN')] },
      { kind: 'alarms', scope: 'related' },
    ])
    // The display trends the subcooling margin itself; the relief tank taking the PORV's discharge, its pressure
    // and level heading for their alarms, is watched and added after the line's isolation.
    expect(listed(evidence)).toEqual([
      ['pressurizer.reliefValvePositionFraction', 'cause'],
      ['pressurizer.blockValveEffectivePositionFraction', 'isolation'],
      ['pressurizer.blockValvePositionFraction', 'isolation'],
      ['pressurizerReliefTank.pressureMPa', 'mode'],
      ['pressurizerReliefTank.levelPercent', 'mode'],
    ])
    expect(evidence[0]!.note).toMatch(/^35\.0 % since 10:00:0\d; demand 0 % throughout$/)
    expect(evidence[1]!.reason).toBe('PORV block isolates the PORV\'s line')
    expect(read('pressurizer.blockValveEffectivePositionFraction')).toBe(1)
    expect(rowsOf(display)[1]).toEqual({ kind: 'isolation', name: '', items: ['MOV-8000A-POS', 'MOV-8000A'] })
    expect(rowsOf(display)[2]).toEqual({ kind: 'mode', name: '', items: ['PRT-PRESS', 'PRT-LVL'] })
    expect(result.view.height).toBeLessThanOrEqual(COMPOSED_DISPLAY_MAX_HEIGHT_PX)
  }, PLANT_HANG_GUARD_MS)

  test('PORV open after the trip, as run 22 composed it: the subcooling margin a critical safety function judges keeps the last row, before the relief tank only alarms judge', () => {
    // Run 22's composition three minutes in: its readouts leave the added rows room for four. The relief tank's
    // level and pressure head for their alarms sooner than the subcooling margin, but core cooling is judged by the
    // margin, the decisive value of a pressurizer steam-space leak, so it takes the last row.
    const { compose, read } = situation({ actionId: 'pressurizer-relief-open', parameters: { positionPercent: 35 } }, 3)
    const { evidence, display, result } = compose('Unit 2 pressurizer depressurization', ['PT-455', 'PORV-456A', 'PZR-LVL'], [
      { kind: 'trend', horizon: '2m', signals: [signal('PT-455', 'primary'), signal('pressurizer.reliefFlowKgPerS'), signal('PZR-LVL', 'counter-evidence')] },
      { kind: 'readouts', signals: [signal('PORV-456A-POS', 'primary'), signal('PORV-456A'), signal('MOV-8000A-POS')] },
      { kind: 'alarms', scope: 'related' },
    ])
    expect(rowsOf(display).map(row => row.kind)).toEqual(['delivers', 'trip', 'program', 'mode'])
    expect(rowsOf(display).at(-1)).toEqual({ kind: 'mode', name: '', items: ['SUB-MARGIN'] })
    expect(listed(evidence).map(([path]) => path)).not.toContain('pressurizerReliefTank.levelPercent')
    expect(Number(read('pressurizerReliefTank.levelPercent'))).toBeGreaterThan(75)
    expect(result.view.height).toBeLessThanOrEqual(COMPOSED_DISPLAY_MAX_HEIGHT_PX)
  }, PLANT_HANG_GUARD_MS)

  test('a relief valve shown open, its demand followed, still has the device that isolates its line added; one the display shows is not', () => {
    const { compose } = situation(null, 0, operator => {
      operator.write('PORV-456A', 0.35)
      for (let second = 0; second < 20; second += 1) operator.step()
    })
    const open = compose('Relief valve opened', ['PORV-456A-POS'], [{ kind: 'trend', horizon: '2m', signals: [signal('PT-455', 'primary'), signal('PORV-456A-POS')] }])
    expect(listed(open.evidence)).toContainEqual(['pressurizer.blockValveEffectivePositionFraction', 'isolation'])
    expect(listed(open.evidence).map(([, kind]) => kind)).not.toContain('cause')
    const both = compose('Relief valve and its block valve', ['PORV-456A-POS'], [{ kind: 'trend', horizon: '2m', signals: [signal('PT-455', 'primary'), signal('PORV-456A-POS'), signal('MOV-8000A-POS')] }])
    expect(listed(both.evidence).map(([, kind]) => kind)).not.toContain('isolation')
  }, PLANT_HANG_GUARD_MS)

  test('loss of main feedwater as run 23 composed it: the wide ranges in the legend, the auxiliary feed to each steam generator and the trip check, within the chat height', () => {
    // Run 23: every narrow range below its span, a header flow of 114 kg/s that cannot say whether any steam
    // generator is unfed, and nothing added: one readout row did not fit beside the trend.
    const lossOfFeed = situation({ actionId: 'loss-main-feedwater' }, 2)
    const { result, evidence, display } = lossOfFeed.compose('Unit 2 feedwater loss: SG inventory and AFW', ['SG-A-LVL-NR', 'SG-B-LVL-NR', 'SG-C-LVL-NR', 'SG-D-LVL-NR'], [
      { kind: 'trend', horizon: '10m', signals: [...['A', 'B', 'C', 'D'].map(loop => signal(`SG-${loop}-LVL-NR`, 'primary')), signal('AFW-FLOW'), signal('CST-LVL')] },
      { kind: 'alarms', scope: 'plant' },
    ])
    for (const loop of ['A', 'B', 'C', 'D']) expect(result.margins.join('\n')).toMatch(new RegExp(`SG-${loop}-LVL-NR: <0 % \\(WR SG-${loop}-LVL-WR: \\d+\\.\\d %\\)`))
    expect(lossOfFeed.read('sgA.wideRangeLevelPercent')).toBeGreaterThan(15)
    // The header flow is shown: its flow to each steam generator is added, then the trip check; what feedwater
    // isolation shut off, ranked last, finds no room.
    expect(rowsOf(display)).toEqual([afwToEach, trip])
    expect(listed(evidence)).not.toContainEqual(['feedwaterHeader.outletFlowKgPerS', 'isolates'])
    for (const loop of ['a', 'b', 'c', 'd']) expect(lossOfFeed.read(`aux-feedwater-valve-${loop}-to-sg-${loop}.flowKgPerS`)).toBeGreaterThan(20)
    expect(Number(lossOfFeed.read('core.powerRangePercent'))).toBeLessThan(5)
    expect(lossOfFeed.read('turbineStopValve.effectivePositionFraction')).toBe(0)
    expect(evidence.find(entry => entry.kind === 'trip')!.reason).toMatch(/^Reactor trip at 10:01:\d\d: what says Core and Turbine stopped$/)
    expect(result.view.height).toBeLessThanOrEqual(COMPOSED_DISPLAY_MAX_HEIGHT_PX)

    // A drawing that writes a narrow range at the end of its span: the wide ranges are added, in one row.
    const drawing = lossOfFeed.compose('Main feedwater to steam generators', ['feedwaterHeader'], [
      { kind: 'mimic', services: ['feedwater'], to: ['sgA', 'sgB', 'sgC', 'sgD'], reach: 3 },
      { kind: 'alarms', scope: 'related' },
    ])
    expect(rowsOf(drawing.display)[0]).toEqual({ kind: 'wider', name: '', items: ['SG-A-LVL-WR', 'SG-B-LVL-WR', 'SG-C-LVL-WR', 'SG-D-LVL-WR'] })
    expect(drawing.evidence[0]!.reason).toBe('SG-A-LVL-NR, SG-B-LVL-NR, SG-C-LVL-NR and SG-D-LVL-NR read below their span: the same quantity on the instruments with the wider span')

    // Readouts alone draw no history across the trip: no trip check.
    const now = lossOfFeed.compose('Feed now', ['AFW-FLOW'], [{ kind: 'readouts', signals: [signal('AFW-FLOW', 'primary')] }])
    expect(listed(now.evidence).map(([, kind]) => kind)).not.toContain('trip')
  }, PLANT_HANG_GUARD_MS)

  test('turbine trip: narrow ranges falling toward the end of their span bring the wide ranges, beside the auxiliary feed in all and to each, and the trip check', () => {
    // Run 23: a minute after the turbine trip the narrow ranges read 17.9 %, falling 18 %/min, on scale; nothing
    // showed where the inventory would be once they left it.
    const turbineTrip = situation({ actionId: 'turbine-trip' }, 1)
    const { evidence, display, result } = turbineTrip.compose('Post-trip steam-generator inventory', ['SG-A-LVL-NR', 'SG-B-LVL-NR', 'SG-C-LVL-NR', 'SG-D-LVL-NR'], [
      { kind: 'trend', horizon: '10m', signals: [signal('SG-A-LVL-NR', 'primary'), ...['B', 'C', 'D'].map(loop => signal(`SG-${loop}-LVL-NR`))] },
      { kind: 'alarms', scope: 'plant' },
    ])
    expect(Number(turbineTrip.read('sgA.levelPercent'))).toBeGreaterThan(0)
    expect(rowsOf(display)).toEqual([
      { kind: 'wider', name: '', items: ['SG-A-LVL-WR', 'SG-B-LVL-WR', 'SG-C-LVL-WR', 'SG-D-LVL-WR'] },
      { kind: 'delivers', name: '', items: ['AFW-FLOW'] },
      afwToEach,
      trip,
      { kind: 'isolates', name: '', items: ['Process header outlet flow · Main Feedwater Header'] },
    ])
    expect(evidence[0]!.reason).toBe('SG-A-LVL-NR, SG-B-LVL-NR, SG-C-LVL-NR and SG-D-LVL-NR head for the bottom of their span: the same quantity on the instruments with the wider span')
    expect(evidence[4]!.reason).toBe('Steam generator A low-low level auxiliary feedwater actuation: what it delivers')
    expect(evidence[5]!.reason).toBe('Steam generator A low-low level auxiliary feedwater actuation: what it delivers to SG A, SG B, SG C and SG D')
    expect(result.view.height).toBeLessThanOrEqual(COMPOSED_DISPLAY_MAX_HEIGHT_PX)
  }, PLANT_HANG_GUARD_MS)

  test('a line-up drawing: the parallel supply into what it ends at, the flow its header carries in all and to each destination', () => {
    // Run 23: the SI line-up to loop C drew no accumulator; the feed line-up had no flow per steam generator.
    const power = atPower()
    const si = power.compose('Safety injection to loop C', ['safetyInjection', 'C'], [{ kind: 'mimic', services: ['safetyInjection'], loops: ['C'] }, { kind: 'alarms', scope: 'related' }])
    const drawn = si.display.panels.find(panel => panel.kind === 'mimic')!
    if (drawn.kind !== 'mimic') throw new Error('expected the mimic')
    expect(drawn.mimic.summary.equipment.map(item => item.label)).toEqual(expect.arrayContaining(['RWST', 'HHSI A', 'HHSI B', 'SI header', 'ACC C']))
    expect(drawn.mimic.summary.carriers).toEqual(['primaryInjection', 'safetyInjection'])
    // Its discharge isolation valve, open behind a check valve the coolant's pressure holds shut, reads no flow, never a demand it ignores.
    expect(si.result.equipment.find(item => item.label === 'ACC C discharge isolation valve')?.state).toBe('position not measured; no flow')
    // The safety injection header's lines to the cold legs publish no flow: its flow is added in all only.
    expect(listed(si.evidence)).toEqual([['safetyInjectionHeader.outletFlowKgPerS', 'flow']])
    expect(si.result.view.height).toBeLessThanOrEqual(COMPOSED_MIMIC_DISPLAY_MAX_HEIGHT_PX)
    const feed = power.compose('Main feedwater to steam generators', ['feedwater'], [{ kind: 'mimic', services: ['feedwater'] }, { kind: 'alarms', scope: 'related' }])
    expect(rowsOf(feed.display)).toEqual([
      { kind: 'flow', name: '', items: ['Process header outlet flow · Main Feedwater Header'] },
      { kind: 'flow', name: 'Feedwater to', items: ['SG A', 'SG B', 'SG C', 'SG D'] },
    ])
    expect(power.read('feedwater-control-valve-b-to-sg-b.flowKgPerS')).toBeGreaterThan(300)
    // The auxiliary feed beside the main feed into all four steam generators draws legibly neither drawn nor stopped at their inlets.
    const feedDrawing = feed.display.panels.find(panel => panel.kind === 'mimic')!
    if (feedDrawing.kind !== 'mimic') throw new Error('expected the mimic')
    expect(feedDrawing.mimic.summary.carriers).toEqual(['feedwater'])
    expect(feed.result.view.height).toBeLessThanOrEqual(COMPOSED_MIMIC_DISPLAY_MAX_HEIGHT_PX)
    const offsite = situation({ actionId: 'loss-offsite-power' }, 1)
    const diesel = offsite.compose('Diesel supply to motor-driven AFW', ['dieselGeneratorA', 'auxFeedwaterPumpMotor'], [
      { kind: 'mimic', to: ['auxFeedwaterPumpMotor', 'auxFeedwaterPumpMotorB'], services: ['electricalPower'], reach: 2 },
      { kind: 'alarms', scope: 'related' },
    ])
    // Powered is not pumping: the pumps' header flow says whether they deliver water, and its flow to each steam
    // generator whether every one is fed.
    expect(rowsOf(diesel.display)).toEqual([{ kind: 'delivers', name: '', items: ['AFW-FLOW'] }, afwToEach])
    expect(diesel.evidence[0]!.reason).toMatch(/^Steam generator [A-D] low-low level auxiliary feedwater actuation: what it delivers$/)
    expect(offsite.read('auxFeedwaterHeader.outletFlowKgPerS')).toBeGreaterThan(50)
  }, PLANT_HANG_GUARD_MS)

  test('a reading held to a program: Tref and the deviation beside Tavg, the level program beside the pressurizer level', () => {
    // Run 23: show-tavg read Tavg alone, though rod control holds it to Tref (SME review).
    const power = atPower()
    const tavg = power.compose('Tavg over ten minutes', ['TAVG'], [{ kind: 'trend', horizon: '10m', signals: [signal('TAVG', 'primary')] }])
    expect(rowsOf(tavg.display)).toEqual([{ kind: 'program', name: '', items: ['TREF', 'TAVG-TREF'] }])
    expect(tavg.evidence[0]!.reason).toBe('the program TAVG is held to, and how far it stands from it')
    expect(Number(power.read('core.referenceAverageTemperatureC'))).toBeCloseTo(Number(power.read('vessel.meanPrimaryCoolantTemperatureC')), 0)
    const level = power.compose('Pressurizer level', ['PZR-LVL'], [{ kind: 'trend', horizon: '10m', signals: [signal('PZR-LVL', 'primary')] }])
    expect(rowsOf(level.display)[0]).toEqual({ kind: 'program', name: '', items: ['PZR-LVL-PGM', 'PZR-LVL-DEV'] })
  }, PLANT_HANG_GUARD_MS)

  test('a normal plant gets nothing added: a steady level and power at power', () => {
    const power = atPower()
    for (const panels of [
      [{ kind: 'comparison', signals: ['A', 'B', 'C', 'D'].map(loop => signal(`SG-${loop}-LVL-NR`, 'primary')) }, { kind: 'alarms', scope: 'related' }],
      [{ kind: 'trend', horizon: '10m', signals: [signal('SG-B-LVL-NR', 'primary')] }],
      [{ kind: 'trend', horizon: '10m', signals: [signal('core.powerMw', 'primary')] }],
    ]) {
      const { evidence, display } = power.compose('Normal plant values', [(panels[0] as { signals: ReadonlyArray<{ ref: string }> }).signals[0]!.ref], panels)
      expect(evidence).toEqual([])
      expect(display.panels).toHaveLength(panels.length)
    }
  }, PLANT_HANG_GUARD_MS)
})

describe('the rows World adds', () => {
  test('read parallel values by their tags, or by the equipment that tells them apart under what they share', () => {
    const graph = atPower().system.plant.graph
    const pen = (path: string) => {
      const binding = graph.signalBindingByPath.get(path as never)!
      return { path: binding.path, name: binding.tagId ?? binding.label, quantity: binding.quantity, ...(binding.tagId === undefined ? {} : { tagId: binding.tagId }) } as never
    }
    const entry = (path: string, kind: DisplayEvidence['kind'], reason: string): DisplayEvidence => ({ path, kind, reason })
    const evidence = [
      entry('sgA.wideRangeLevelPercent', 'wider', 'off span'),
      entry('sgB.wideRangeLevelPercent', 'wider', 'off span'),
      entry('feedwater-control-valve-a-to-sg-a.flowKgPerS', 'flow', 'to each'),
      entry('feedwater-control-valve-b-to-sg-b.flowKgPerS', 'flow', 'to each'),
      entry('sgC.wideRangeLevelPercent', 'wider', 'off span'),
    ]
    expect(composeEvidenceRows(graph, evidence, evidence.map(value => pen(value.path))).map(row => [row.kind, row.name, row.items.map(item => item.label), row.count])).toEqual([
      ['wider', '', ['SG-A-LVL-WR', 'SG-B-LVL-WR'], 2],
      ['flow', 'Feedwater to', ['SG A', 'SG B'], 2],
      ['wider', '', ['SG-C-LVL-WR'], 1],
    ])
  })
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
    expect(result.shows.join('\n')).toContain('"LO-3 12.7 MPa · SI" automatic action line')
    expect(result.shows.join('\n')).toContain('(only while SI-BLOCKED off)')
    expect(result.margins.join('\n')).not.toContain('· SI')
    expect(result.margins[0]).toMatch(/^PT-455: .*LO 14\.8 MPa · ALM/)
  }, PLANT_HANG_GUARD_MS)

  test('a generator at power is past no limit', () => {
    const { result } = atPower().compose('Generator output', ['GEN-MW'], [{ kind: 'trend', horizon: '10m', signals: [signal('GEN-MW', 'primary')] }])
    expect(result.margins.join('\n')).not.toContain('past')
  }, PLANT_HANG_GUARD_MS)
})
