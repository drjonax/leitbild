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
import { composeEvidenceRows, evidenceCriterionText, type CompiledComposedDisplay, type ComposedEvidenceRow } from '../src/packs/process-plant/displays/compose.ts'
import { chipName, positionWord, unitLabel, valueText } from '../src/packs/process-plant/displays/display-text.ts'
import { evidenceChips, evidenceItemWidth, evidenceLines, evidenceNameWidth, evidenceNoteWidth, evidenceUnitOnce, evidenceWhyWidth } from '../src/packs/process-plant/displays/evidence-width.ts'
import type { ComposedDisplayAlarm } from '../src/ui/embed/composed-display/composed-display-client.ts'
import { firstOutFlag, visibleAlarms } from '../src/ui/embed/composed-display/panel-presenters.ts'
import { activeThreshold } from '../src/packs/process-plant/displays/trend-reading.ts'
import { displayAnnunciation } from '../src/packs/process-plant/displays/annunciators.ts'
import { COMPOSED_DISPLAY_MAX_HEIGHT_PX, COMPOSED_MIMIC_DISPLAY_MAX_HEIGHT_PX, composedDisplayLayout, composedDisplayStateSchema, type DisplayEvidence } from '../src/packs/process-plant/displays/composition.ts'
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
  // The newest samples first, as the historian reads a series window, and the window's oldest after them where asked.
  const recordedHistory: PackRuntimeRecordedHistory = {
    read: query => {
      const inWindow = (series.get(query.seriesId) ?? []).filter(sample => sample.simulationTime >= query.from && sample.simulationTime <= query.to)
      const newest = inWindow.slice().reverse().slice(0, query.limit)
      return (query.withOldest === true && inWindow.length > query.limit ? [...newest, inWindow[0]!] : newest)
        .map((sample, sequence) => ({ runtimeId: 'process-plant', sequence: sequence + 1, seriesId: query.seriesId, observedAt: sample.simulationTime as IsoTimestamp, simulationTime: sample.simulationTime as IsoTimestamp, value: sample.value as number, quality: 'good' as const }))
    },
  }
  // A series the Run's historian holds only the last `keptMs` of (recorded since, or kept no longer).
  const forget = (path: string, keptMs: number) => {
    const id = recordingSeriesIdFor(plant.id, path as never)
    series.set(id, (series.get(id) ?? []).filter(sample => Date.parse(sample.simulationTime) >= now - keptMs))
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
  return { system, ask, compose, forget, read: (path: string) => runtime.readVariable(path as never) }
}

const once = <T>(make: () => T): (() => T) => {
  let made: T | undefined
  return () => (made ??= make())
}

const signal = (ref: string, role = 'context') => ({ ref, role })
const listed = (evidence: ReadonlyArray<DisplayEvidence>) => evidence.map(entry => [entry.path, entry.kind])

const runback = once(() => situation({ actionId: 'steam-generator-b-feedwater-runback', parameters: { positionPercent: 35 } }, 3))
const atPower = once(() => situation(null, 1))

/**
 * The rows World added, each as its kind, what it names, the words its values are read by (a state, read by its
 * words alone, by its tag in brackets), its note, and whether it continues a row too wide for one line.
 */
const rowsOf = (display: CompiledComposedDisplay) => {
  const panel = display.panels.find(candidate => candidate.kind === 'evidence')
  return panel?.kind !== 'evidence' ? [] : panel.rows.map(row => ({
    kind: row.kind,
    name: row.name,
    items: row.items.map(item => item.label === '' ? `[${item.pen.tagId ?? item.pen.name}]` : item.label),
    ...(row.note === undefined ? {} : { note: row.note }),
    ...(row.continued === true ? { continued: true } : {}),
  }))
}
type Row = ReturnType<typeof rowsOf>[number]
// The trip check, a row for each energy end (HMI review of run 26: one row for both was cut at chat width): what
// its protection moved, its states, then the values a critical safety function judges the stop by; the reactor's
// row goes on in a line holding its other values, which is left out first where room is short.
const reactorCheck: Row = { kind: 'trip', name: '', items: ['[TRIP-BKR-A-POS]', '[TRIP-BKR-B-POS]', '[ROD-BOTTOM]', 'NIS-PR-AVG', 'NIS-IR-SUR'] }
const reactorCheckRest: Row = { kind: 'trip', name: '', items: ['ROD-STEPS', 'NIS-IR'], continued: true }
const turbineCheck: Row = { kind: 'trip', name: '', items: ['TURB-STOP-POS', '[GEN-BKR]', 'GEN-MW'] }
const afwToEach: Row = { kind: 'delivers', name: '', items: ['AFW-A-FLOW', 'AFW-B-FLOW', 'AFW-C-FLOW', 'AFW-D-FLOW'] }
// After a trip, on a display about taking the core's heat: the feed into each steam generator, read against the heat
// sink's minimum total (it says what an actuation's flow to each did, so that row is not added twice); Tavg against its
// program, which with no load holds its no-load value; the steam generators' pressures with which way they go.
const feedCriterion: Row = { kind: 'criterion', name: 'Feedwater inflow', items: ['SG A', 'SG B', 'SG C', 'SG D'] }
const tavgAgainstNoLoad: Row = { kind: 'stabilize', name: '', items: ['TAVG', 'TREF', 'TAVG-TREF'] }

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
    expect(evidence[0]!.note).toMatch(/^35\.0 % since 10:00:0\d; demand 100 % then, 0 % since 10:00:[0-5]\d$/)
    // Named by the action that judges the shown level, though every start lines the feed up to SG B.
    expect(evidence[2]!.reason).toBe('Steam generator B low-low level auxiliary feedwater actuation: its flow into SG B')
    const rows = rowsOf(display)
    expect(rows[0]).toEqual({ kind: 'cause', name: '', items: ['MFW-B-CV-POS', 'MFW-B-CV'], note: evidence[0]!.note! })
    expect(rows.filter(row => row.kind === 'trip')).toEqual([reactorCheck, reactorCheckRest, turbineCheck])
    // After the trip the feed into every steam generator, healthy ones too, is read against the heat sink's minimum; with
    // Tavg against its no-load program it takes the room the healthy loop's narrow range had (below its span here too).
    expect(rows.map(row => row.kind)).toEqual(['cause', 'delivers', 'delivers', 'criterion', 'trip', 'trip', 'trip', 'stabilize'])
    expect(rows).toContainEqual(feedCriterion)
    expect(rows.at(-1)).toEqual(tavgAgainstNoLoad)
    // The narrow range is off its span: its legend row reads the wide range in its rate's place, so World adds none.
    expect(read('sgB.levelPercent')).toBe(0)
    expect(listed(evidence).map(([, kind]) => kind)).not.toContain('wider')
    expect(result.margins[0]).toMatch(/^SG-B-LVL-NR: <0 % \(WR SG-B-LVL-WR: \d+\.\d %\)/)
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

  test('a display draws what it leads with first: the answer\'s lead is the top strip, in every later view', () => {
    // HMI review of run 25 (porv-open): the answer led with the subcooling margin, the display's lead, while the
    // pressurizer pressure strip, the agent's primary, was on top.
    const { compose } = relief()
    const { result, display } = compose('Unit 2 pressurizer pressure and relief', ['PT-455'], [
      { kind: 'trend', horizon: '2m', signals: [signal('PT-455', 'primary'), signal('pressurizer.reliefFlowKgPerS'), signal('PORV-456A-POS'), signal('SUB-MARGIN')] },
      { kind: 'alarms', scope: 'related' },
    ])
    const content = embeddedViewContentSchema.parse(result.viewContent)
    expect(content.lead === null ? null : content.items[content.lead.item]!.names[0]).toBe('SUB-MARGIN')
    // The view stores it, and the view opened again from the stored state draws its strip on top; the agent's
    // primary follows in its own order.
    expect(composedDisplayStateSchema.parse(JSON.parse(result.view.state)).lead).toBe('vessel.subcoolingMarginC' as never)
    const trend = display.panels[0]!
    if (trend.kind !== 'trend') throw new Error('expected the trend on top')
    expect(trend.strips.map(strip => strip.pens.map(pen => pen.tagId ?? String(pen.path)))).toEqual([['SUB-MARGIN'], ['PT-455'], ['PORV-456A-POS']])
  }, PLANT_HANG_GUARD_MS)

  test('PORV open after the trip, as run 22 composed it: the subcooling margin a critical safety function judges keeps the last row, before the relief tank only alarms judge', () => {
    // Run 22's composition three minutes in: its readouts leave the added rows room for four. The relief tank's
    // level and pressure head for their alarms sooner than the subcooling margin, and the safety injection signal
    // has isolated main feedwater, but core cooling is judged by the margin, the decisive value of a pressurizer
    // steam-space leak, so it takes the last row.
    const { compose, read } = situation({ actionId: 'pressurizer-relief-open', parameters: { positionPercent: 35 } }, 3)
    const { evidence, display, result } = compose('Unit 2 pressurizer depressurization', ['PT-455', 'PORV-456A', 'PZR-LVL'], [
      { kind: 'trend', horizon: '2m', signals: [signal('PT-455', 'primary'), signal('pressurizer.reliefFlowKgPerS'), signal('PZR-LVL', 'counter-evidence')] },
      { kind: 'readouts', signals: [signal('PORV-456A-POS', 'primary'), signal('PORV-456A'), signal('MOV-8000A-POS')] },
      { kind: 'alarms', scope: 'related' },
    ])
    // The trip check takes a row for each end, the reactor's other values left out: the margin, heading for its
    // alarm, comes after it and before the pressurizer level's program, which finds no room.
    expect(rowsOf(display)).toEqual([expect.objectContaining({ kind: 'delivers' }), reactorCheck, turbineCheck, { kind: 'mode', name: '', items: ['SUB-MARGIN'] }])
    expect(listed(evidence).map(([path]) => path)).not.toContain('pressurizerReliefTank.levelPercent')
    expect(listed(evidence).map(([, kind]) => kind)).not.toContain('isolates')
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
    // The header flow is shown: the feed into each steam generator is added, against the heat sink's minimum total,
    // then the reactor's trip check, its first line whole; the turbine's, the post-trip values and what feedwater
    // isolation shut off, ranked last, find no room.
    expect(rowsOf(display)).toEqual([feedCriterion, reactorCheck])
    expect(listed(evidence)).not.toContainEqual(['feedwaterHeader.outletFlowKgPerS', 'isolates'])
    for (const loop of ['a', 'b', 'c', 'd']) expect(lossOfFeed.read(`aux-feedwater-valve-${loop}-to-sg-${loop}.flowKgPerS`)).toBeGreaterThan(20)
    expect(Number(lossOfFeed.read('core.powerRangePercent'))).toBeLessThan(5)
    expect(lossOfFeed.read('turbineStopValve.effectivePositionFraction')).toBe(0)
    expect(evidence.find(entry => entry.kind === 'trip')!.reason).toMatch(/^Reactor trip at 10:00:\d\d: what says Core stopped$/)
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

  test('SG B runback: the feed inflow chip on the SG B detail names the alarm that is active, as its alarm row does', () => {
    // HMI review of run 25: three minutes after FCV B ran back, the SG B detail's feedwater inflow read "LO · ALM"
    // beside "feedwater flow low" listed as cleared. Two alarms set LO 150 kg/s on that flow: the flow alarm of power
    // operation, cleared with its mode at the trip, and the low level with low feed, still active. The chip named the
    // limit both share, in the cleared row's words; it now names the active alarm as its row does.
    const { system, ask, read } = runback()
    const snapshot = system.protection!.snapshot()
    const lifecycle = (ruleId: string) => [...snapshot.alarms, ...snapshot.trips].find(entry => entry.ruleId === ruleId)!
    expect([lifecycle('sg-b-feedwater-flow-low').active, lifecycle('sg-b-feedwater-low').active]).toEqual([false, true])
    // The main feedwater pumps run on after the trip (C2b) and feed SG B through its stuck valve with the auxiliary
    // feed: some 160 kg/s, above the 150 kg/s limit and short of the 180 kg/s its low-feed alarm clears at.
    expect(Number(read('sgB.feedwaterFlowKgPerS'))).toBeLessThan(180)
    const detail = ask('world.process-plant.display.view', { plantId: system.plant.id, state: JSON.stringify({ detail: { plantId: system.plant.id, components: ['sgB'] } }), size: { width: 1600, height: 900 } }) as { display: CompiledComposedDisplay }
    const readouts = detail.display.panels.find(panel => panel.kind === 'readouts')!
    if (readouts.kind !== 'readouts') throw new Error('expected the lead values')
    const inflow = readouts.pens.find(pen => String(pen.path) === 'sgB.feedwaterFlowKgPerS')!
    const active = new Set([...snapshot.alarms, ...snapshot.trips].filter(entry => entry.active).map(entry => entry.ruleId))
    const chip = activeThreshold(inflow.thresholds, active, { id: 'hotStandby', label: 'Hot standby' }, path => read(String(path)) as never)!
    const tags = detail.display.annunciation.tags
    const tagOf = (ruleId: string) => Object.entries(tags).find(([id]) => id.split(':')[1] === ruleId)![1]
    expect(chipName(chip)).toBe('L LO & F LO · ALM')
    expect(chipName(chip)).toBe(tagOf('sg-b-feedwater-low'))
    expect(tagOf('sg-b-feedwater-flow-low')).toBe('LO · ALM')
    expect(chipName(chip, true)).toBe('L LO & F LO')
  }, PLANT_HANG_GUARD_MS)

  test('turbine trip: narrow ranges below their span read the wide ranges in the legend, beside the auxiliary feed in all and to each, and the trip check', () => {
    // Run 23: a minute after the turbine trip the narrow ranges read 17.9 %, on scale; nothing showed where the
    // inventory would be once they left it. Since the narrow range spans the wide range's upper quarter (R4a), the
    // shrink takes every generator below it within seconds: each legend row reads its wide range.
    const turbineTrip = situation({ actionId: 'turbine-trip' }, 1)
    const { evidence, display, result } = turbineTrip.compose('Post-trip steam-generator inventory', ['SG-A-LVL-NR', 'SG-B-LVL-NR', 'SG-C-LVL-NR', 'SG-D-LVL-NR'], [
      { kind: 'trend', horizon: '10m', signals: [signal('SG-A-LVL-NR', 'primary'), ...['B', 'C', 'D'].map(loop => signal(`SG-${loop}-LVL-NR`))] },
      { kind: 'alarms', scope: 'plant' },
    ])
    expect(Number(turbineTrip.read('sgA.levelPercent'))).toBe(0)
    for (const loop of ['A', 'B', 'C', 'D']) expect(result.margins.join('\n')).toMatch(new RegExp(`SG-${loop}-LVL-NR: <0 % \\(WR SG-${loop}-LVL-WR: \\d+\\.\\d %\\)`))
    expect(rowsOf(display)).toEqual([
      { kind: 'delivers', name: '', items: ['AFW-FLOW'] },
      feedCriterion,
      reactorCheck,
      reactorCheckRest,
      turbineCheck,
      tavgAgainstNoLoad,
      { kind: 'stabilize', name: '', items: ['SG-A-PRESS', 'SG-B-PRESS', 'SG-C-PRESS', 'SG-D-PRESS'] },
      { kind: 'stabilize', name: '', items: [], note: expect.stringMatching(/^each (rising|falling) \d+\.\d+ MPa\/min over 30 s$/), continued: true },
      // The feedwater isolation on low Tavg shuts the feed regulating valves only and stops no pump (C2b): the
      // evidence names what an actuation starts or stops, so it adds no "isolates" row here.
    ])
    expect(evidence.filter(entry => entry.kind === 'trip').map(entry => entry.reason.replace(/\d\d:\d\d:\d\d/, 'hh:mm:ss'))).toEqual([
      ...Array(7).fill('Reactor trip at hh:mm:ss: what says Core stopped'),
      ...Array(3).fill('Reactor trip at hh:mm:ss: what says Turbine stopped'),
    ])
    expect(evidence[0]!.reason).toBe('Steam generator A low-low level auxiliary feedwater actuation: what it delivers')
    expect(evidence.find(entry => entry.kind === 'criterion')!.reason).toBe('HEAT SINK: Total feed flow to the steam generators at least 27.8 kg/s (440 gpm)')
    expect(result.view.height).toBeLessThanOrEqual(COMPOSED_DISPLAY_MAX_HEIGHT_PX)
    // The trip check reads as the drawing does (HMI review of run 23: "ON" and "0 %"): the rods by the words the core
    // declares for them, the stop valve SHUT at the end of its travel.
    const panel = display.panels.find(candidate => candidate.kind === 'evidence')!
    if (panel.kind !== 'evidence') throw new Error('expected the evidence panel')
    const items = panel.rows.filter(row => row.kind === 'trip').flatMap(row => row.items)
    // A state reads by its words alone, which name its equipment, as on the faceplate.
    const rods = items.find(item => item.pen.tagId === 'ROD-BOTTOM')!.pen
    expect(items.filter(item => item.pen.valueKind === 'boolean').map(item => item.label)).toEqual(['', '', '', ''])
    expect(turbineTrip.read('core.rodsOnBottom')).toBe(true)
    expect(rods.states?.on).toStartWith('Rods on bottom')
    const stopValve = items.find(item => item.label === 'TURB-STOP-POS')!.pen
    expect(stopValve.position).toBe(true)
    expect(positionWord(Number(turbineTrip.read('turbineStopValve.effectivePositionFraction')))).toBe('SHUT')
    expect(items.find(item => item.label === 'NIS-PR-AVG')!.pen.position).toBeUndefined()
    expect([positionWord(0.049), positionWord(0.05), positionWord(0.95), positionWord(0.951)]).toEqual(['SHUT', null, null, 'OPEN'])
  }, PLANT_HANG_GUARD_MS)

  test('each critical safety function chip opens the equipment on its tree\'s deciding branch, and each banner group the energy end it commands', () => {
    // C1 plan E5 (HF review HF-21): from status to evidence in one click. After a turbine trip heat sink is yellow on
    // every steam generator's narrow range below 10 %: the chip opens the four. Subcriticality was decided on the
    // startup rate, read on the core.
    const { system, ask } = situation({ actionId: 'turbine-trip' }, 1)
    const sample = ask('world.process-plant.display.sample', { plantId: system.plant.id, paths: ['pressurizer.pressureMPa'], alarms: false }) as { safetyFunctions: ReadonlyArray<{ shortLabel: string; status: string; opens?: ReadonlyArray<string> }> }
    expect(Object.fromEntries(sample.safetyFunctions.map(chip => [chip.shortLabel, chip.opens ?? null]))).toEqual({
      SUBCRIT: ['core'],
      'CORE COOL': ['vessel'],
      'HEAT SINK': ['sgA', 'sgB', 'sgC', 'sgD'],
      INTEGRITY: ['rcpA', 'rcpB', 'rcpC', 'rcpD'],
      CTMT: ['containment'],
      INVENTORY: ['vessel'],
    })
    expect(sample.safetyFunctions.find(chip => chip.shortLabel === 'HEAT SINK')!.status).toBe('yellow')
    // A banner label opens the energy end its group's own actuations command; AFW START commands none.
    const annunciation = displayAnnunciation(system.plant)
    expect(annunciation.ends).toEqual({ 'RX TRIP': ['core'], SI: ['core'], FWI: ['turbine'], 'TURB TRIP': ['turbine'] })
  }, PLANT_HANG_GUARD_MS)

  test('a narrow range on its span whose fall reaches its end within the trend brings its wide range', () => {
    // Feed regulating valve B failed at 70 %: forty seconds in, SG B's narrow range is still on its span, falling
    // toward its bottom within the ten-minute trend.
    const { compose, read } = situation({ actionId: 'steam-generator-b-feedwater-runback', parameters: { positionPercent: 70 } }, 40 / 60)
    const { evidence, display } = compose('SG B inventory after its feed valve failed', ['SG-B-LVL-NR'], [
      { kind: 'trend', horizon: '10m', signals: [signal('SG-B-LVL-NR', 'primary'), ...['A', 'C', 'D'].map(loop => signal(`SG-${loop}-LVL-NR`))] },
      { kind: 'alarms', scope: 'plant' },
    ])
    expect(Number(read('sgB.levelPercent'))).toBeGreaterThan(20)
    expect(rowsOf(display)).toContainEqual({ kind: 'wider', name: '', items: ['SG-B-LVL-WR'] })
    expect(evidence.find(entry => entry.kind === 'wider')!.reason).toBe('SG-B-LVL-NR heads for the bottom of its span: the same quantity on the instrument with the wider span')
  }, PLANT_HANG_GUARD_MS)

  test('a drawing that needs the room takes alarm rows, down to two alarms and their count, before it is refused', () => {
    // Run 23's feed path to SG B, with its trend and related alarms, three minutes into the runback: since the
    // condensate storage tank has its low-level alarm, its badge's room makes the drawing 20 px too tall beside four
    // alarm rows. The alarms list counts what it cannot show, so it gives a row and the display composes first try.
    const { compose } = runback()
    const drawing = { kind: 'mimic', to: ['sgB'], services: ['feedwater', 'auxFeedwater'], loops: ['B'], reach: 3 }
    const levels = [signal('SG-B-LVL-NR', 'primary'), signal('sgA.levelPercent', 'counter-evidence')]
    const related = { kind: 'alarms', scope: 'related' }
    const feedPath = [drawing, { kind: 'trend', horizon: '10m', signals: levels }, related]
    const { display, result } = compose('SG B feed path', ['sgB'], feedPath)
    expect(display.panels.map(panel => panel.kind)).toEqual(['mimic', 'trend', 'alarms'])
    const alarms = display.panels.find(panel => panel.kind === 'alarms')!
    if (alarms.kind !== 'alarms') throw new Error('expected the alarms')
    expect(alarms.rows).toBe(3)
    expect(result.view.height).toBeLessThanOrEqual(COMPOSED_MIMIC_DISPLAY_MAX_HEIGHT_PX)
    // A drawing that fits keeps all four rows.
    const lineUp = compose('Main feedwater to steam generators', ['feedwater'], [{ kind: 'mimic', services: ['feedwater'] }, { kind: 'alarms', scope: 'related' }])
    const kept = lineUp.display.panels.find(panel => panel.kind === 'alarms')!
    expect(kept.kind === 'alarms' && kept.rows).toBe(4)
    // One that does not fit beside the fewest rows is still refused, with the ways it fits.
    const taller = [drawing, { kind: 'trend', horizon: '10m', signals: [...levels, signal('SG-B-PRESS')] }, related]
    expect(() => compose('SG B feed path and pressure', ['sgB'], taller)).toThrow(/the drawing needs \d+ × \d+ px, and this display leaves 800 × \d+/)
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
    // Powered is not pumping: the pumps' header flow says whether they deliver water, and the feed into each steam
    // generator, against the heat sink's minimum, whether every one is fed. The pump the question names is held
    // running by the actuation that started it.
    expect(rowsOf(diesel.display).slice(0, 3)).toEqual([
      { kind: 'hold', name: '', items: ['[AFW-PUMP-A-RUNNING]', '[AFW-PUMP-A]'], note: expect.stringMatching(/^since 10:00:\d\d$/) },
      { kind: 'delivers', name: '', items: ['AFW-FLOW'] },
      feedCriterion,
    ])
    expect(diesel.evidence[0]!.reason).toMatch(/^Steam generator [A-D] low-low level auxiliary feedwater actuation holds MD AFW A at RUN: STOP refused while it stands$/)
    expect(diesel.evidence.find(entry => entry.kind === 'delivers')!.reason).toMatch(/^Steam generator [A-D] low-low level auxiliary feedwater actuation: what it delivers$/)
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
    const plant = atPower().system.plant
    const graph = plant.graph
    const pen = (path: string) => {
      const binding = graph.signalBindingByPath.get(path as never)!
      return { path: binding.path, name: binding.tagId ?? binding.label, quantity: binding.quantity, unit: binding.unit, valueKind: 'number', resolution: null, thresholds: [], command: false, ...(binding.tagId === undefined ? {} : { tagId: binding.tagId }) } as never
    }
    const entry = (path: string, kind: DisplayEvidence['kind'], reason: string): DisplayEvidence => ({ path, kind, reason })
    const evidence = [
      entry('sgA.wideRangeLevelPercent', 'wider', 'off span'),
      entry('sgB.wideRangeLevelPercent', 'wider', 'off span'),
      entry('feedwater-control-valve-a-to-sg-a.flowKgPerS', 'flow', 'to each'),
      entry('feedwater-control-valve-b-to-sg-b.flowKgPerS', 'flow', 'to each'),
      entry('sgC.wideRangeLevelPercent', 'wider', 'off span'),
    ]
    expect(composeEvidenceRows(plant, evidence, evidence.map(value => pen(value.path))).map(row => [row.kind, row.name, row.items.map(item => item.label), row.count])).toEqual([
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

describe('what a display shows of a trip (HMI review of run 26)', () => {
  const tripped = once(() => situation({ actionId: 'turbine-trip' }, 1))

  test('a display that draws the turbine a trip commanded lists that trip, its first-out marked', () => {
    // The BLOCKER: "Why did the turbine trip?" drew the turbine, its stop valves and the condenser, and said "No
    // active alarm or trip on the displayed signals": the manual trip acts on no drawn signal, but it commands the
    // drawn turbine and its stop valve.
    const { system, ask, compose } = tripped()
    const annunciation = displayAnnunciation(system.plant)
    const sample = ask('world.process-plant.display.sample', { plantId: system.plant.id, paths: ['turbine.electricMw'], alarms: true }) as { alarms: ReadonlyArray<ComposedDisplayAlarm> }
    const shownBy = (display: CompiledComposedDisplay) => {
      const alarms = display.panels.find(panel => panel.kind === 'alarms')!
      if (alarms.kind !== 'alarms') throw new Error('expected the alarms')
      return { ruleIds: alarms.ruleIds, rows: visibleAlarms(sample.alarms, 'related', alarms.ruleIds, annunciation) }
    }
    const drawing = shownBy(compose('Unit 2 turbine trip sequence', ['turbine'], [{ kind: 'mimic', to: ['turbine'], loops: ['A'] }, { kind: 'alarms', scope: 'related' }]).display)
    // Every turbine trip commands the turbine: the manual one, on loss of load, on a reactor trip (P-4), on the grid's frequency.
    expect(drawing.ruleIds).toEqual(expect.arrayContaining(['turbine-manual-trip', 'turbine-trip-on-loss-of-load', 'reactor-trip-turbine-trip', 'turbine-trip-on-grid-underfrequency']))
    expect(drawing.rows[0]).toMatchObject({ ruleId: 'turbine-manual-trip', title: 'Manual turbine trip', active: true, firstOut: true })
    expect(firstOutFlag(drawing.rows[0]!, annunciation)).toBe('1st TURB TRIP')
    expect(drawing.rows.map(row => row.ruleId)).toContain('reactor-trip-turbine-trip')
    // So does a display that only trends the generator's output: the trips that command the equipment it measures.
    const trend = shownBy(compose('Generator output after the trip', ['GEN-MW'], [{ kind: 'trend', horizon: '2m', signals: [signal('GEN-MW', 'primary')] }, { kind: 'alarms', scope: 'related' }]).display)
    expect(trend.rows[0]).toMatchObject({ ruleId: 'turbine-manual-trip', firstOut: true })
  }, PLANT_HANG_GUARD_MS)

  test('every line of the rows World adds fits a chat view, whole values each; a row too wide goes on under it', () => {
    // The trip check was cut on seven displays at chat width, losing the turbine's stop valves, breaker and output.
    const width = (row: ComposedEvidenceRow): number => {
      const once = evidenceUnitOnce(row.items.map(item => item.pen))
      const chips = evidenceChips(row.kind, row.items.length > 1 || row.continued === true || row.continues === true ? 2 : 1)
      return evidenceWhyWidth(row.kind) + 8
        + (row.name === '' ? 0 : evidenceNameWidth(row.name) + 8)
        + row.items.reduce((sum, item) => sum + evidenceItemWidth(item, chips, !once) + 8, 0)
        + (once ? 4 + evidenceNameWidth(unitLabel(row.items[0]!.pen.unit)) : 0)
        + (row.note === undefined ? 0 : evidenceNoteWidth(row.note))
        + (row.criterion === undefined ? 0 : evidenceNoteWidth(evidenceCriterionText(row.criterion, `000000 ${row.criterion.unit}`)))
    }
    for (const { compose } of [tripped(), runback()]) {
      const { display } = compose('Post-trip steam-generator inventory', ['SG-A-LVL-NR'], [
        { kind: 'trend', horizon: '10m', signals: [signal('SG-A-LVL-NR', 'primary'), signal('SG-B-LVL-NR')] },
        { kind: 'alarms', scope: 'plant' },
      ])
      const panel = display.panels.find(candidate => candidate.kind === 'evidence')!
      if (panel.kind !== 'evidence') throw new Error('expected the evidence panel')
      expect(panel.rows.some(row => row.kind === 'trip')).toBe(true)
      for (const row of panel.rows) expect(width(row), row.items.map(item => item.pen.tagId).join(' ')).toBeLessThanOrEqual(composedDisplayLayout.evidenceRowRoom)
    }
    // A row splits where its next value would not fit, in order; a value wider than any line has one to itself; a
    // note that does not fit after the last value takes a line of its own.
    const { display } = tripped().compose('Generator output after the trip', ['GEN-MW'], [{ kind: 'readouts', signals: [signal('GEN-MW', 'primary'), signal('TURB-STOP-POS'), signal('NIS-PR-AVG')] }])
    const pens = display.panels.flatMap(panel => panel.kind === 'readouts' ? panel.pens : [])
    const items = pens.map(pen => ({ pen, label: pen.tagId! }))
    const one = evidenceItemWidth(items[0]!, true)
    expect(evidenceLines('trip', '', items, undefined, evidenceWhyWidth('trip') + 8 + one + 8).map(line => line.items.map(item => item.label))).toEqual([['GEN-MW'], ['TURB-STOP-POS'], ['NIS-PR-AVG']])
    expect(evidenceLines('trip', '', items, undefined, 40).map(line => line.items.length)).toEqual([1, 1, 1])
    const all = evidenceLines('trip', '', items, 'x'.repeat(200))
    expect(all.map(line => [line.items.length, line.note])).toEqual([[3, false], [0, true]])
  }, PLANT_HANG_GUARD_MS)

  test('a display leads with what it draws, and with its subject over a value only nearest its limit', () => {
    // rcp-trip led with the pressurizer level of its MODE WATCH row, show-tavg with the deviation of its PROGRAM row:
    // values World adds under the agent's panels never lead.
    const power = atPower()
    const tavg = power.compose('Tavg over ten minutes', ['TAVG'], [{ kind: 'trend', horizon: '10m', signals: [signal('TAVG', 'primary')] }])
    const leadOf = (result: { readonly viewContent: unknown }) => {
      const content = embeddedViewContentSchema.parse(result.viewContent)
      return content.lead === null ? null : content.items[content.lead.item]!.names[0]
    }
    expect(rowsOf(tavg.display)).toEqual([{ kind: 'program', name: '', items: ['TREF', 'TAVG-TREF'] }])
    expect(leadOf(tavg.result)).not.toBe('TAVG-TREF')
    // A steam generator's pressure nearest its alarm does not lead a level question whose level the display draws.
    const level = power.compose('SG A level at power', ['SG-A-LVL-NR'], [{ kind: 'trend', horizon: '10m', signals: [signal('SG-A-LVL-NR', 'primary'), signal('SG-A-PRESS')] }])
    expect(leadOf(level.result)).toBe('SG-A-LVL-NR')
    const trend = level.display.panels[0]!
    if (trend.kind !== 'trend') throw new Error('expected the trend')
    expect(trend.strips[0]!.pens[0]!.tagId).toBe('SG-A-LVL-NR')
  }, PLANT_HANG_GUARD_MS)

  test('a trended signal says how far back its recorded samples reach within its trend\'s axis', () => {
    // Run 25 (sg-b-runback): an answer said "35.0 % throughout the last 10 min" of a 3-min record. The display
    // content says each trended signal's record (recordedMs), so the answer check holds a claimed window to it.
    const { compose, forget } = situation({ actionId: 'steam-generator-b-feedwater-runback', parameters: { positionPercent: 35 } }, 4)
    forget('feedwaterControlValveB.effectivePositionFraction', 90_000)
    const { result } = compose('SG B level and its feed valve', ['SG-B-LVL-NR'], [
      { kind: 'trend', horizon: '10m', signals: [signal('SG-B-LVL-NR', 'primary'), signal('MFW-B-CV-POS')] },
    ])
    const content = embeddedViewContentSchema.parse(result.viewContent)
    const item = (name: string) => content.items.find(entry => entry.names.includes(name))!
    // The axis spans the Run's four minutes; the level was recorded all of them, the valve only the last 90 s.
    expect(content.span?.shownMs).toBe(270_000)
    expect(item('SG-B-LVL-NR').recordedMs).toBeGreaterThanOrEqual(240_000)
    expect(item('SG-B-LVL-NR').recordedMs).toBeLessThanOrEqual(content.span!.shownMs)
    expect(item('MFW-B-CV-POS').recordedMs).toBeGreaterThanOrEqual(89_000)
    expect(item('MFW-B-CV-POS').recordedMs).toBeLessThanOrEqual(90_000)
    // Only what its history the view shows says so.
    expect(content.items.filter(entry => !entry.history).every(entry => entry.recordedMs === undefined)).toBe(true)
  }, PLANT_HANG_GUARD_MS)

  test('a valve\'s position reads SHUT or OPEN at the ends of its travel wherever a value is written', () => {
    // MOV-8000A read "100 %" in a readout and OPEN on its drawing.
    expect([valueText(1, 'fraction', 0.001, { min: 0, max: 1 }, true), valueText(0, 'fraction', 0.001, { min: 0, max: 1 }, true), valueText(0.35, 'fraction', 0.001, { min: 0, max: 1 }, true)]).toEqual(['OPEN', 'SHUT', '35.0 %'])
    expect(valueText(1, 'fraction', 0.001, { min: 0, max: 1 }, false)).toBe('>100 %')
    const { display } = atPower().compose('PORV block valve', ['MOV-8000A-POS'], [{ kind: 'readouts', signals: [signal('MOV-8000A-POS', 'primary'), signal('PORV-456A-POS')] }])
    const readouts = display.panels[0]!
    if (readouts.kind !== 'readouts') throw new Error('expected the readouts')
    expect(readouts.pens.map(pen => pen.position)).toEqual([true, true])
  }, PLANT_HANG_GUARD_MS)
})


describe('what an operation display and a post-trip display carry (reviews of run 26c)', () => {
  const lossOfFeed = once(() => situation({ actionId: 'loss-main-feedwater' }, 3))

  test('a display composed around an operated item reads what holds it, and the criterion the holding actuation serves', () => {
    // HMI review of run 26c (op-stop-afw-pump): the Plant refused to stop MD AFW A, held by the AFW actuation, and the
    // display drew no hold. Its state and demand are read together with the actuation and since when; then the total
    // feed into the steam generators the pump feeds, against the heat sink's minimum, which that actuation serves.
    const { compose, read } = lossOfFeed()
    const pump = compose('Unit 2 motor-driven AFW A', ['auxFeedwaterPumpMotor'], [{ kind: 'mimic', from: ['auxFeedwaterPumpMotor'], services: ['auxFeedwater'] }, { kind: 'alarms', scope: 'related' }])
    const rows = rowsOf(pump.display)
    expect(rows[0]).toEqual({ kind: 'hold', name: '', items: ['[AFW-PUMP-A-RUNNING]', '[AFW-PUMP-A]'], note: expect.stringMatching(/^since 10:00:\d\d$/) })
    expect(pump.evidence[0]!.reason).toBe('Steam generator A low-low level auxiliary feedwater actuation holds MD AFW A at RUN: STOP refused while it stands')
    expect(read('auxFeedwaterPumpMotor.runningState')).toBe(true)
    expect(rows).toContainEqual(feedCriterion)
    const panel = pump.display.panels.find(candidate => candidate.kind === 'evidence')!
    if (panel.kind !== 'evidence') throw new Error('expected the evidence panel')
    // The row reads its values against what the function asks: their total, at least 27.8 kg/s, live (EvidencePanel).
    const criterion = panel.rows.find(row => row.criterion !== undefined)!.criterion!
    expect(criterion).toMatchObject({ safetyFunction: 'HEAT SINK', operator: '>=', value: 27.8, total: true, unit: 'kg/s' })
    expect(criterion.paths).toEqual(['sgA.feedwaterFlowKgPerS', 'sgB.feedwaterFlowKgPerS', 'sgC.feedwaterFlowKgPerS', 'sgD.feedwaterFlowKgPerS'])
    expect(evidenceCriterionText(criterion, '112')).toBe('total 112 ≥ 27.8 kg/s · HEAT SINK')
    // The same drawing composed about nothing it operates reads no hold.
    const lineUp = compose('Auxiliary feedwater line-up', ['auxFeedwater'], [{ kind: 'mimic', from: ['auxFeedwaterPumpMotor'], services: ['auxFeedwater'] }, { kind: 'alarms', scope: 'related' }])
    expect(rowsOf(lineUp.display).map(row => row.kind)).not.toContain('hold')
  }, PLANT_HANG_GUARD_MS)

  test('after a trip the post-trip values join a display about taking the core\'s heat, never one about the trip of the turbine', () => {
    // SME review of run 26c: lead post-trip displays with Tavg against its no-load value, the steam generator pressure
    // trend and total feed against the heat sink's minimum.
    const { compose } = situation({ actionId: 'turbine-trip' }, 1)
    const levels = compose('Post-trip heat sink', ['SG-A-LVL-NR'], [{ kind: 'trend', horizon: '10m', signals: [signal('SG-A-LVL-NR', 'primary'), signal('SUB-MARGIN')] }, { kind: 'alarms', scope: 'plant' }])
    const kinds = rowsOf(levels.display).map(row => row.kind)
    expect(kinds).toContain('criterion')
    expect(rowsOf(levels.display)).toContainEqual(tavgAgainstNoLoad)
    expect(levels.evidence.find(entry => entry.kind === 'stabilize')!.reason).toBe('after the trip, TAVG against its program, which with no load holds its no-load value')
    // A display about the turbine's trip draws nothing that takes the core's heat: no post-trip values.
    const why = compose('Unit 2 turbine trip sequence', ['turbine'], [{ kind: 'mimic', to: ['turbine'], loops: ['A'] }, { kind: 'alarms', scope: 'related' }])
    expect(why.evidence.map(entry => entry.kind)).not.toContain('stabilize')
    // At power, nothing of the post-trip check.
    const power = atPower().compose('SG A level at power', ['SG-A-LVL-NR'], [{ kind: 'trend', horizon: '10m', signals: [signal('SG-A-LVL-NR', 'primary')] }])
    expect(power.evidence.map(entry => entry.kind).filter(kind => kind === 'stabilize' || kind === 'criterion')).toEqual([])
  }, PLANT_HANG_GUARD_MS)
})
