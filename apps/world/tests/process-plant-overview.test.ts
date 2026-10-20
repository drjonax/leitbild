import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
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
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { recordedPlantVariables } from '../src/packs/process-plant/recording.ts'
import { annunciatorHeight, compileDetailDisplay, compileOverviewDisplay, composedDisplayShows, overviewDrawingRoom, type CompiledComposedDisplay, type OverviewView } from '../src/packs/process-plant/displays/compose.ts'
import { composedDisplayLayout } from '../src/packs/process-plant/displays/composition.ts'
import { indexSample } from '../src/packs/process-plant/displays/mimic/evaluate.ts'
import { drawnLook, itemTreatment } from '../src/packs/process-plant/displays/mimic/rows.ts'
import { guardPlantTests, PLANT_HANG_GUARD_MS } from './plant-hang-guard.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'

guardPlantTests()

// Process display windows as measured on production in Full HD and QHD browsers.
const fullHd: OverviewView = { width: 1896, height: 972 }
const qhd: OverviewView = { width: 2536, height: 1332 }

const plant = (loopCount = 4): ProcessPlantRuntimeInstance => {
  const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:overview', loopCount }))
  const runtime = createProcessPlantRuntime({ system: compiled })
  return {
    plant: compiled,
    runtime,
    ramps: createProcessPlantRampRunner({ runtime }),
    protection: createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation }),
    performance: createProcessPlantRuntimePerformance(),
  }
}

describe('the unit overview World generates for a Plant', () => {
  const system = plant()
  const plants = new Map([[system.plant.id, system]])
  const ask = (capabilityId: string, input: unknown) => answerProcessPlantQuery({
    request: { capabilityId, input },
    plants,
    objects: new Map([[system.plant.id as ObjectId, { id: system.plant.id as ObjectId, label: 'Halden Unit 1' }]]),
    simulationTime: '2026-10-09T10:00:00.000Z' as IsoTimestamp,
    recordedSeriesIds: new Set(recordedPlantVariables(system.plant, 'operations').map(variable => recordingSeriesIdFor(system.plant.id, variable.path))),
    // The Plant has not run, so its Run has recorded nothing yet.
    recordedHistory: { read: () => [] },
  })

  test('opens as a view of its own, saying what it shows and the state of every drawn item', () => {
    const result = ask('world.process-plant.display.overview', { plantId: system.plant.id }) as {
      view: { title: string; height: number; state: string }
      shows: ReadonlyArray<string>
      equipment: ReadonlyArray<{ label: string; state: string }>
    }
    expect(result.view.title).toBe('Halden Unit 1 overview')
    expect(JSON.parse(result.view.state)).toEqual({ overview: { plantId: system.plant.id } })
    expect(result.view.height).toBeLessThanOrEqual(960)
    expect(result.shows.join(' ')).toContain('PZR')
    expect(result.equipment.map(item => item.label)).toEqual(expect.arrayContaining(['PZR', 'SG A', 'RCP D', 'Turbine', 'Condenser']))
  })

  test('re-opens from its state as lead values, the principal circuits and the Plant\'s alarms, with no advice', () => {
    const opened = ask('world.process-plant.display.overview', { plantId: system.plant.id }) as { view: { state: string } }
    // A view without its size is refused: an overview is drawn for the window it is shown in.
    expect(() => ask('world.process-plant.display.view', { plantId: system.plant.id, state: opened.view.state })).toThrow('send its size')
    const result = ask('world.process-plant.display.view', { plantId: system.plant.id, state: opened.view.state, size: fullHd }) as {
      kind: string
      plantLabel: string
      display: CompiledComposedDisplay
    }
    expect(result.kind).toBe('overview')
    expect(result.plantLabel).toBe('Halden Unit 1')
    expect(result.display.advice).toBeNull()
    expect(result.display.panels.map(panel => panel.kind)).toEqual(['readouts', 'mimic', 'alarms'])
    const mimic = result.display.panels.find(panel => panel.kind === 'mimic')!
    if (mimic.kind !== 'mimic') throw new Error('expected the mimic')
    expect(mimic.mimic.profile).toBe('overview')
    expect(mimic.mimic.intent).toBeNull()
    // One sample reads everything the overview draws.
    const sample = ask('world.process-plant.display.sample', { plantId: system.plant.id, paths: mimic.mimic.paths, alarms: true }) as { values: ReadonlyArray<unknown> }
    expect(sample.values).toHaveLength(mimic.mimic.paths.length)
  })

  test('a composed display re-opens as advice', () => {
    const composed = ask('world.process-plant.display.compose', {
      plantId: system.plant.id,
      title: 'Pressurizer pressure',
      question: 'Is pressurizer pressure holding?',
      need: 'Decide on spray',
      subjects: ['pressurizer'],
      panels: [{ kind: 'trend', horizon: '10m', signals: [{ ref: 'pressurizer.pressureMPa', role: 'primary' }] }],
    }) as { view: { state: string } }
    const result = ask('world.process-plant.display.view', { plantId: system.plant.id, state: composed.view.state }) as { kind: string; display: CompiledComposedDisplay }
    expect(result.kind).toBe('advice')
    expect(result.display.advice).toEqual({ question: 'Is pressurizer pressure holding?', need: 'Decide on spray' })
  })

  test('is drawn whole for the window it is shown in when it fits: four loops in Full HD, six in QHD', () => {
    const drawn = (system: ProcessPlantRuntimeInstance, view: OverviewView | null) => {
      const result = compileOverviewDisplay(system, new Set(), view)
      if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
      const panel = result.display.panels.find(candidate => candidate.kind === 'mimic')!
      if (panel.kind !== 'mimic') throw new Error('expected the mimic')
      return { height: result.display.height, mimic: panel.mimic }
    }
    // Lead values, drawing and alarms all show without scrolling.
    expect(drawn(system, fullHd).height).toBeLessThanOrEqual(fullHd.height)
    const sixLoops = plant(6)
    expect(drawn(sixLoops, qhd).height).toBeLessThanOrEqual(qhd.height)
    // Too small a window draws it as wide as the window, or at its own size, and the view scrolls.
    const cramped = drawn(sixLoops, fullHd)
    expect(cramped.mimic.width > fullHd.width || cramped.height > fullHd.height).toBe(true)
    // With no window (a listing of what it draws) it is drawn at its own size.
    expect(drawn(system, null).mimic.items.length).toBe(drawn(system, fullHd).mimic.items.length)
  })

  test('in a Full HD window four loops draw beside the column of lead values and alarms, the window\'s whole height theirs', () => {
    const column = overviewDrawingRoom(fullHd, 'column', { readouts: 6, annunciators: 9, tileWidth: 134 })!
    const stacked = overviewDrawingRoom(fullHd, 'stacked', { readouts: 6, annunciators: 9, tileWidth: 134 })!
    expect(column.maxHeight).toBeGreaterThan(stacked.maxHeight + 200)
    const result = compileOverviewDisplay(system, new Set(), fullHd)
    if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
    const panel = result.display.panels.find(candidate => candidate.kind === 'mimic')!
    if (panel.kind !== 'mimic') throw new Error('expected the mimic')
    expect(panel.mimic.width).toBeLessThanOrEqual(column.maxWidth)
    expect(panel.mimic.height).toBeLessThanOrEqual(column.maxHeight)
    expect(panel.mimic.readoutSize).toBe('regular')
  })

  test('each lead value the Run records has a ten-minute sparkline, and the column that labels its window still fits Full HD', () => {
    const recorded = new Set(recordedPlantVariables(system.plant, 'operations').map(variable => recordingSeriesIdFor(system.plant.id, variable.path)))
    const result = compileOverviewDisplay(system, recorded, fullHd)
    if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
    const readouts = result.display.panels.find(candidate => candidate.kind === 'readouts')!
    if (readouts.kind !== 'readouts') throw new Error('expected the lead values')
    expect(readouts.sparklineMs).toBe(600_000)
    // Every lead value at power is recorded (the unrecorded net inventory flow, computed by the simulator only, no
    // longer leads: C1 E2), and the agent is told each has a sparkline.
    expect(readouts.pens.filter(pen => !pen.recorded).map(pen => String(pen.path))).toEqual([])
    const shows = composedDisplayShows(result.display, system.runtime.elapsedMs()).join(' ')
    expect(shows).toContain('each recorded one has a sparkline of its last 10 min, for direction and rate only (no value scale)')
    expect(shows).not.toContain('not recorded by this Run, so without one: ')
    // The column as drawn: the title over six lead values, nine tiles two to a row, the alarms and the footer, under the window's header row.
    const layout = composedDisplayLayout
    const column = layout.overviewReadoutsTitle + readouts.pens.length * layout.overviewReadoutRow + layout.panelGap
      + annunciatorHeight(9, 134, layout.overviewColumn) + layout.alarms + layout.overviewFooter
    expect(readouts.pens).toHaveLength(6)
    expect(layout.overviewFrame + column).toBe(904)
    // The drawing beside it, with the tags of the valves outside the loops, is the taller of the two.
    expect(result.display.height).toBeGreaterThanOrEqual(904)
    expect(result.display.height).toBeLessThanOrEqual(fullHd.height)
    // Advice readouts show current values only.
    const advice = ask('world.process-plant.display.compose', {
      plantId: system.plant.id,
      title: 'Pressurizer pressure',
      question: 'Is pressurizer pressure holding?',
      need: 'Decide on spray',
      subjects: ['pressurizer'],
      panels: [{ kind: 'readouts', signals: [{ ref: 'pressurizer.pressureMPa', role: 'primary' }] }],
    }) as { view: { state: string } }
    const opened = ask('world.process-plant.display.view', { plantId: system.plant.id, state: advice.view.state }) as { display: CompiledComposedDisplay }
    expect(opened.display.panels[0]).not.toHaveProperty('sparklineMs')
  })

  test('a window a little too short keeps the drawing beside the column and scrolls by only what it lacks', () => {
    const drawn = (view: OverviewView) => {
      const result = compileOverviewDisplay(system, new Set(), view)
      if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
      const panel = result.display.panels.find(candidate => candidate.kind === 'mimic')!
      if (panel.kind !== 'mimic') throw new Error('expected the mimic')
      return { height: result.display.height, width: panel.mimic.width, drawing: panel.mimic.height }
    }
    const roomy = drawn(fullHd)
    // A browser with a bookmarks bar shows less of the screen: the same drawing, a few pixels of scrolling.
    expect(drawn({ width: fullHd.width, height: 885 })).toEqual(roomy)
  })

  test('a window too small for any arrangement scrolls the drawing, never refusing it', () => {
    // A zoomed-in display window or a narrow pane leaves less room than the frame itself (display-modal session, 654 × 470).
    for (const view of [{ width: 654, height: 470 }, { width: 320, height: 200 }, { width: 200, height: 60 }]) {
      const result = compileOverviewDisplay(system, new Set(), view)
      expect(result.ok, `${view.width} × ${view.height}`).toBe(true)
      if (!result.ok) continue
      expect(result.display.height).toBeGreaterThan(view.height)
    }
  })

  test('every loop count the reference PWR is built with draws its overview', () => {
    const mimicOf = (display: CompiledComposedDisplay) => {
      const panel = display.panels.find(candidate => candidate.kind === 'mimic')!
      if (panel.kind !== 'mimic') throw new Error('expected the mimic')
      return panel.mimic
    }
    for (const loops of [2, 3, 4, 5, 6]) {
      const result = compileOverviewDisplay(plant(loops), new Set(), fullHd)
      if (!result.ok) throw new Error(`${loops} loops: ${result.issues.map(issue => issue.message).join('; ')}`)
      const { count, forced } = mimicOf(result.display).crossings
      expect(count).toBeLessThanOrEqual(forced + 2)
    }
    // Five and six loops overflow Full HD, so each searches the least height that draws: seconds under load.
  }, PLANT_HANG_GUARD_MS)

  test('on a feedwater runback the failed valve that causes it stands out as abnormal, and nothing else does', () => {
    const upset = plant()
    upset.runtime.tick(1_000)
    for (const command of commandsForProcessPlantAction({ actionId: 'steam-generator-b-feedwater-runback', parameters: { positionPercent: 35 }, graph: upset.plant.graph })) {
      upset.runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
    upset.runtime.tick(5_000)
    const result = compileOverviewDisplay(upset, new Set(), fullHd)
    if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
    const panel = result.display.panels.find(candidate => candidate.kind === 'mimic')!
    if (panel.kind !== 'mimic') throw new Error('expected the mimic')
    const index = indexSample(panel.mimic.paths.map(path => ({ path, value: upset.runtime.readVariable(path), quality: 'good' })))
    const abnormal = panel.mimic.items.filter(item => itemTreatment(drawnLook(item.binding, item.rows, index), false) === 'abnormal').map(item => item.components.join(','))
    expect(abnormal).toEqual(['feedwaterControlValveB'])
  })

  test('after a trip it leads with the heat path: the subcooling margin, the core-exit temperature and the auxiliary feedwater the actuation delivers', () => {
    // Evaluation run 22 (HMI review, 5-second test): in Hot standby after SG B's runback tripped the unit, the
    // overview led with "0 MW · 3600 MW below HI ALM" and the generator's output, and showed no auxiliary feedwater.
    const upset = plant()
    const step = () => {
      upset.runtime.tick(1_000)
      upset.protection!.evaluate({ runtime: upset.runtime, elapsedMs: upset.runtime.elapsedMs(), simulationRunId: 'run-overview' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
    step()
    const atPower = compileOverviewDisplay(upset, new Set(), fullHd)
    for (const command of commandsForProcessPlantAction({ actionId: 'steam-generator-b-feedwater-runback', parameters: { positionPercent: 35 }, graph: upset.plant.graph })) {
      upset.runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
    for (let second = 0; second < 180; second += 1) step()
    const tripped = compileOverviewDisplay(upset, new Set(), fullHd)
    const leads = (result: typeof tripped) => {
      if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
      const readouts = result.display.panels.find(panel => panel.kind === 'readouts')!
      if (readouts.kind !== 'readouts') throw new Error('expected the lead values')
      return readouts.pens.map(pen => pen.tagId ?? String(pen.path))
    }
    // Containment pressure, at atmospheric inside its normal range, yields its place at power as after the trip.
    // The simulator-only net inventory flow never leads (C1 E2): the vessel's liquid level takes its place.
    expect(leads(atPower)).toEqual(['NIS-PR-AVG', 'PT-455', 'SUB-MARGIN', 'RVLS-DYN', 'CET-AVG', 'GEN-MW'])
    // No energy sink is watched once the turbine has tripped: the heat path leads (core cooling, then the heat sink
    // the actuation feeds), then the pressure safety injection can still act on and the pressurizer's level.
    expect(leads(tripped)).toEqual(['SUB-MARGIN', 'CET-AVG', 'AFW-FLOW', 'PT-455', 'PZR-LVL', 'RVLS-DYN'])
    expect(upset.runtime.readVariable('auxFeedwaterHeader.outletFlowKgPerS' as never)).toBeGreaterThan(50)
    if (!tripped.ok) return
    // Still the whole column, and it still fits the window.
    expect(tripped.display.height).toBeLessThanOrEqual(fullHd.height)
  }, PLANT_HANG_GUARD_MS)

  test('an overview state for another Plant is refused', () => {
    expect(() => ask('world.process-plant.display.view', { plantId: system.plant.id, state: JSON.stringify({ overview: { plantId: 'plant:other' } }) }))
      .toThrow(`Display state targets plant:other, not ${system.plant.id}`)
  })
})

describe('equipment opened from the unit overview', () => {
  const system = plant()
  const plants = new Map([[system.plant.id, system]])
  const ask = (capabilityId: string, input: unknown) => answerProcessPlantQuery({
    request: { capabilityId, input },
    plants,
    objects: new Map(),
    simulationTime: '2026-10-09T10:00:00.000Z' as IsoTimestamp,
    recordedSeriesIds: new Set(),
  })
  const detailState = (components: ReadonlyArray<string>) => JSON.stringify({ detail: { plantId: system.plant.id, components } })

  test('every drawn item names the components it opens: a group its members, other equipment itself', () => {
    const result = compileOverviewDisplay(system, new Set(), fullHd)
    if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
    const panel = result.display.panels.find(candidate => candidate.kind === 'mimic')!
    if (panel.kind !== 'mimic') throw new Error('expected the mimic')
    const opens = new Map(panel.mimic.items.map(item => [item.binding.label, item.components]))
    expect(opens.get('MFW A/B')).toEqual(['mainFeedwaterPumpA', 'mainFeedwaterPumpB'])
    expect(opens.get('SG B')).toEqual(['sgB'])
    expect(panel.mimic.items.every(item => item.components.length > 0)).toBe(true)
  })

  test('opens as what feeds it and where its outflow goes, its own values first and the alarms of what is drawn', () => {
    expect(() => ask('world.process-plant.display.view', { plantId: system.plant.id, state: detailState(['sgB']) })).toThrow('send its size')
    const result = ask('world.process-plant.display.view', { plantId: system.plant.id, state: detailState(['sgB']), size: fullHd }) as {
      kind: string
      display: CompiledComposedDisplay
    }
    expect(result.kind).toBe('detail')
    expect(result.display.title).toBe('Steam Generator B')
    expect(result.display.advice).toBeNull()
    expect(result.display.height).toBeLessThanOrEqual(fullHd.height)
    expect(result.display.panels.map(panel => panel.kind)).toEqual(['readouts', 'mimic', 'alarms'])
    const [readouts, mimic, alarms] = result.display.panels
    if (readouts?.kind !== 'readouts' || mimic?.kind !== 'mimic' || alarms?.kind !== 'alarms') throw new Error('expected readouts, a mimic and alarms')
    // Its own signals lead, the ones its I&C rules judge first, the wide-range level beside the narrow range; then the
    // auxiliary feed its low-low level starts into it, which the SG B detail of run 22 lacked, and the main feed its
    // high-high level isolates.
    expect(readouts.pens.map(pen => String(pen.path))).toEqual(['sgB.levelPercent', 'sgB.wideRangeLevelPercent', 'sgB.secondaryRadiationMSvPerH', 'sgB.pressureMPa', 'sgB.feedwaterFlowKgPerS', 'aux-feedwater-valve-b-to-sg-b.flowKgPerS', 'feedwater-control-valve-b-to-sg-b.flowKgPerS'])
    // Its three feed flows are named by what they are of the whole its feed inlet takes (HMI review of run 23:
    // "Feedwater inflow", AFW-B-FLOW and "Feedwater to steam generator B flow" read alike): the total, and each line
    // by where it branches from.
    expect(readouts.pens.slice(4).map(pen => pen.name)).toEqual(['Total feedwater inflow · Steam Generator B', 'AFW-B-FLOW', 'MFW header to SG B flow'])
    expect(readouts.pens[0]!.thresholds.length).toBeGreaterThan(0)
    // Narrowed to its loop: both sides of the steam generator and the shared headers, the other loops beyond as stops, every valve named.
    expect(mimic.mimic.profile).toBe('detail')
    expect(mimic.mimic.items.some(item => item.marker)).toBe(false)
    const labels = mimic.mimic.items.map(item => item.binding.label)
    expect(labels).toEqual(expect.arrayContaining(['SG B', 'RCP B', 'FCV B', 'MSIV B', 'Steam header']))
    expect(labels).not.toContain('SG A')
    expect(mimic.mimic.stubs.map(stub => stub.text)).toContain('to SG A, SG C, SG D')
    expect(alarms.scope).toBe('related')
    expect(alarms.ruleIds.length).toBeGreaterThan(0)
  })

  test('where every service at once does not draw legibly, it draws the one it works in and stops the others where they join', () => {
    const result = ask('world.process-plant.display.view', { plantId: system.plant.id, state: detailState(['core']), size: fullHd }) as { display: CompiledComposedDisplay }
    const mimic = result.display.panels.find(panel => panel.kind === 'mimic')!
    if (mimic.kind !== 'mimic') throw new Error('expected the mimic')
    // The core heats its coolant: that circuit is drawn, every loop of it.
    expect(mimic.mimic.summary.carriers).toEqual(['primaryCoolant'])
    expect(mimic.mimic.items.map(item => item.binding.label)).toEqual(expect.arrayContaining(['Core', 'PZR', 'SG A', 'RCP D']))
    // Its injection and charging lines stop at it, by name.
    expect(mimic.mimic.stubs.map(stub => stub.text)).toContain('from ACC ×4, CHG ×2, RHR iso, SI header')
    expect(result.display.height).toBeLessThanOrEqual(fullHd.height)
    // The core is an energy end: its faceplate under the drawing takes its lead values (C1 plan R1), so the column
    // beside the drawing holds only the alarms. Opened at power, those are the power range, Tavg's deviation from
    // Tref, subcooling margin, the RCS leak rate and the core-exit thermocouples, its outlet once (HMI review of run
    // 23: the model's mixed outlet temperature beside them repeated it), and its instruments, never a permissive:
    // the de-energized source range as its high voltage's state, the intermediate range and its startup rate.
    expect(result.display.panels.map(panel => panel.kind)).toEqual(['mimic', 'faceplate', 'alarms'])
    const faceplate = result.display.panels.find(panel => panel.kind === 'faceplate')!
    if (faceplate.kind !== 'faceplate') throw new Error('expected the faceplate')
    const shown = faceplate.pens.map(pen => pen.tagId ?? String(pen.path))
    expect(shown).toEqual(expect.arrayContaining(['NIS-PR-AVG', 'TAVG-TREF', 'SUB-MARGIN', 'RCS-LEAK-RATE', 'CET-AVG', 'NIS-SR-HV', 'NIS-IR', 'NIS-IR-SUR']))
    expect(shown).not.toContain('core.coolantOutletTemperatureC')
    expect(shown.filter(tag => tag === 'P-6' || tag === 'P-10')).toEqual([])
    expect(faceplate.pens.find(pen => pen.tagId === 'NIS-SR-HV')?.valueKind).toBe('boolean')
    // In the core's own detail its states read without its name (C1 E2): "Source-range HV off", not "… · Core".
    expect(faceplate.pens.find(pen => pen.tagId === 'NIS-SR-HV')?.states).toEqual({ on: 'Source-range HV on', off: 'Source-range HV off' })
  })

  test('every item of the overview opens', () => {
    const overview = compileOverviewDisplay(system, new Set(), fullHd)
    if (!overview.ok) throw new Error(overview.issues.map(issue => issue.message).join('; '))
    const panel = overview.display.panels.find(candidate => candidate.kind === 'mimic')!
    if (panel.kind !== 'mimic') throw new Error('expected the mimic')
    const refused = panel.mimic.items.flatMap(item => {
      const detail = compileDetailDisplay(system, new Set(), item.components, fullHd)
      return detail.ok ? [] : [`${item.binding.label}: ${detail.issues.map(issue => issue.message).join('; ')}`]
    })
    expect(refused).toEqual([])
  })

  test('equipment the Plant does not have is refused', () => {
    expect(() => ask('world.process-plant.display.view', { plantId: system.plant.id, state: detailState(['nope']), size: fullHd })).toThrow(new RegExp(`^${system.plant.id} has no component nope$`))
  })
})

describe('the alarms a generated display annunciates', () => {
  test('are the active ones and those that cleared unacknowledged; never shelved, suppressed or out of service, and never ones that have not fired', () => {
    const base = plant()
    const lifecycle = (id: string, phase: string, flags: { active: boolean; acknowledged: boolean; shelved?: boolean; suppressed?: boolean; outOfService?: boolean }) => ({
      id, ruleId: id, kind: 'alarm', title: id, severity: 'warning', phase, firstOut: false, latched: false,
      shelved: false, suppressed: false, outOfService: false, ...flags,
    })
    const system = {
      ...base,
      protection: {
        ...base.protection,
        snapshot: () => ({
          rules: ['normal', 'active', 'cleared', 'done', 'shelved', 'suppressed', 'out'].map(ruleId => ({ ruleId, active: ruleId === 'active' || ruleId === 'shelved' || ruleId === 'suppressed' || ruleId === 'out', latched: false, firedCount: 1 })),
          alarms: [
            lifecycle('normal', 'normal', { active: false, acknowledged: false }),
            lifecycle('active', 'activeUnacknowledged', { active: true, acknowledged: false }),
            lifecycle('cleared', 'clearedUnacknowledged', { active: false, acknowledged: false }),
            lifecycle('done', 'clearedAcknowledged', { active: false, acknowledged: true }),
            lifecycle('shelved', 'shelved', { active: true, acknowledged: false, shelved: true }),
            lifecycle('suppressed', 'suppressed', { active: true, acknowledged: false, suppressed: true }),
            lifecycle('out', 'outOfService', { active: true, acknowledged: false, outOfService: true }),
          ],
          trips: [],
        }),
      },
    } as unknown as ProcessPlantRuntimeInstance
    const sample = answerProcessPlantQuery({
      request: { capabilityId: 'world.process-plant.display.sample', input: { plantId: system.plant.id, paths: ['core.powerMw'], alarms: true } },
      plants: new Map([[system.plant.id, system]]),
      objects: new Map(),
      simulationTime: '2026-10-09T10:00:00.000Z' as IsoTimestamp,
      recordedSeriesIds: new Set(),
    }) as { alarms: ReadonlyArray<{ id: string; active: boolean }> }
    expect(sample.alarms.map(alarm => [alarm.id, alarm.active])).toEqual([['active', true], ['cleared', false]])
  })

  test('say apart a latched actuation whose condition cleared from one whose condition holds', () => {
    // SG B after its low-low level started AFW and then overfilled: the AFW start stays latched, its condition gone.
    const base = plant()
    const trip = (id: string, latched: boolean) => ({
      id, ruleId: id, kind: 'trip', title: id, severity: 'critical', phase: 'activeAcknowledged', firstOut: false, active: true, acknowledged: true, latched,
      shelved: false, suppressed: false, outOfService: false,
    })
    const system = {
      ...base,
      protection: {
        ...base.protection,
        snapshot: () => ({
          rules: [{ ruleId: 'sg-b-afw', active: false, latched: true, firedCount: 1 }, { ruleId: 'sg-c-afw', active: true, latched: true, firedCount: 1 }],
          alarms: [],
          trips: [trip('sg-b-afw', true), trip('sg-c-afw', true)],
        }),
      },
    } as unknown as ProcessPlantRuntimeInstance
    const sample = answerProcessPlantQuery({
      request: { capabilityId: 'world.process-plant.display.sample', input: { plantId: system.plant.id, paths: ['core.powerMw'], alarms: true } },
      plants: new Map([[system.plant.id, system]]),
      objects: new Map(),
      simulationTime: '2026-10-09T10:00:00.000Z' as IsoTimestamp,
      recordedSeriesIds: new Set(),
    })
    expect((sample as { alarms: ReadonlyArray<{ id: string; active: boolean; latched: boolean; conditionActive: boolean }> }).alarms.map(alarm => [alarm.id, alarm.active, alarm.latched, alarm.conditionActive]))
      .toEqual([['sg-b-afw', true, true, false], ['sg-c-afw', true, true, true]])
    expect(() => processPlantCapabilities.find(capability => capability.id === 'world.process-plant.display.sample')!.output.parse(sample)).not.toThrow()
  })
})
