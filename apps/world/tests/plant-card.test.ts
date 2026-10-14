import { describe, expect, test } from 'bun:test'
import { recordingSeriesIdFor, type IsoTimestamp, type OperationalObject, type SimulationRunId } from '../src/core/model/index.ts'
import { HOLD_GAP_MS, type TrendPoint } from '../src/packs/process-plant/displays/trend-reading.ts'
import { processPlantUnitPackDataSchema, type ProcessPlantUnitProjection, type ProcessPlantUnitSafetyFunction } from '../src/packs/process-plant/model.ts'
import type { OperationalPointFeature } from '../src/ui/map-runtime/types.ts'
import {
  dockObjectCard,
  objectCardAnchor,
  placeObjectCard,
  sameCardFrame,
  type MapCardFrame,
  type MapObjectAnchor,
} from '../src/ui/map/object-card-anchor.ts'
import { plantCardView, type PlantCardEnergy } from '../src/ui/process-display/plant-card.ts'
import { createPlantCardTrends, PLANT_CARD_TREND_MS, type PlantCardHistory } from '../src/ui/process-display/plant-card-trends.ts'
import { objectHoverCardHtml } from '../src/ui/map/object-hover-card.ts'
import type { ProcedureRunSummary, ProcedureRunSummaryGroup } from '../src/ui/procedures/procedure-run-selectors.ts'
import { scenarios } from './fixtures/scenarios.ts'

const at = '2026-10-14T09:00:00.000Z' as IsoTimestamp
const unit = scenarios.find(scenario => scenario.id === 'test-plant')?.initialObjects.find(object => object.packId === 'process-plant')
if (unit === undefined) throw new Error('the Plant fixture has no Plant')

// The Run's own time, which the energy readings carry; the projection's updatedAt is wall time.
const runAt = '2026-10-14T06:30:00.000Z' as IsoTimestamp

const running: ProcessPlantUnitProjection = {
  schemaVersion: 1,
  summary: 'Core thermal power 3400 MW · Electrical output 1162 MW',
  statusTone: 'ready',
  statusLabel: 'Normal',
  activeAlarmCount: 0,
  activeTripCount: 0,
  energy: [
    { path: 'core.totalThermalPowerMw', label: 'Core thermal power', role: 'source', value: 3400, unit: 'MW', simulationTime: runAt },
    { path: 'turbine.electricMw', label: 'Electrical output', role: 'sink', value: 1162.17, unit: 'MW', simulationTime: runAt },
  ],
  fields: [],
  updatedAt: at,
}

const heatSink = (status: ProcessPlantUnitSafetyFunction['status'], procedure?: string): ProcessPlantUnitSafetyFunction => ({
  id: 'heat-sink',
  label: 'Heat sink',
  shortLabel: 'HEAT SINK',
  status,
  ...(procedure === undefined ? {} : { procedure }),
  meaning: 'No steam generator has level on span and feed is below the minimum flow: the secondary heat sink is lost.',
})

const plantWith = (projection: ProcessPlantUnitProjection | undefined): OperationalObject => {
  const data = processPlantUnitPackDataSchema.parse(unit.packData)
  const { projection: _stored, ...rest } = data
  return { ...unit, packData: projection === undefined ? rest : { ...rest, projection } }
}

const noRuns: ProcedureRunSummaryGroup = { active: [], inactive: [] }

const runOf = (procedureId: string, step: { readonly label: string; readonly name: string } | null, driver?: 'ai'): ProcedureRunSummary => ({
  run: { runId: `run:${procedureId}`, ...(driver === 'ai' ? { driver: { kind: 'ai', actorId: 'actor:ai:assistant' } } : {}) },
  procedureId,
  title: `${procedureId} title`,
  status: 'active',
  step: step === null ? null : { stepId: `step-${step.label}`, ...step },
} as unknown as ProcedureRunSummary)

describe('a Plant card says what its projection and procedure runs say', () => {
  test('a running unit: its energy readings at their Run time, its mode, no chip, "No alarms" and "None running"', () => {
    const view = plantCardView(plantWith({ ...running, modeLabel: 'Power operation' }), noRuns)
    expect(view).toEqual({
      name: unit.label,
      tone: 'ready',
      statusLabel: 'Normal',
      chip: null,
      mode: 'Power operation',
      energy: [
        { path: 'core.totalThermalPowerMw', label: 'Core thermal power', text: '3400 MW', unit: 'MW', point: { t: Date.parse(runAt), v: 3400 } },
        { path: 'turbine.electricMw', label: 'Electrical output', text: '1162 MW', unit: 'MW', point: { t: Date.parse(runAt), v: 1162.17 } },
      ],
      safetyFunction: null,
      alarms: { text: 'No alarms', severity: null },
      procedure: { text: 'None running', title: null, summary: null, drivenByAi: false },
    })
  })

  test('a reactor trip shows the chip; trips and alarms are counted with the highest severity, an actuation alone is no reactor trip', () => {
    const tripped = plantCardView(plantWith({ ...running, statusTone: 'error', activeTripCount: 2, activeAlarmCount: 7, highestSeverity: 'critical', reactorTripped: true, modeLabel: 'Hot standby' }), noRuns)
    expect([tripped?.chip, tripped?.mode, tripped?.alarms]).toEqual(['Tripped', 'Hot standby', { text: '2 trips · 7 alarms', severity: 'critical' }])
    const actuation = plantCardView(plantWith({ ...running, statusTone: 'error', activeTripCount: 1, activeAlarmCount: 0, highestSeverity: 'critical' }), noRuns)
    expect([actuation?.chip, actuation?.alarms?.text]).toEqual([null, '1 trip'])
    const warning = plantCardView(plantWith({ ...running, statusTone: 'working', activeAlarmCount: 1, highestSeverity: 'warning' }), noRuns)
    expect(warning?.alarms).toEqual({ text: '1 alarm', severity: 'warning' })
  })

  test('a unit whose runtime is pending says only that: no energy, no alarm count, no mode', () => {
    for (const object of [plantWith(undefined), plantWith({ ...running, summary: 'Process runtime pending', statusTone: 'idle', statusLabel: 'Runtime pending' })]) {
      const view = plantCardView(object, noRuns)
      expect([view?.chip, view?.tone, view?.energy, view?.alarms, view?.mode]).toEqual(['Pending', 'idle', null, null, null])
    }
  })

  test('the procedures row names the first active run and its step as words, counts the others and marks an AI driver', () => {
    const e0 = runOf('E-0', { label: '4', name: 'Verify SI actuated' }, 'ai')
    const frh = runOf('FR-H.1', null)
    const view = plantCardView(plantWith(running), { active: [e0, frh], inactive: [] })
    expect([view?.procedure.text, view?.procedure.summary, view?.procedure.drivenByAi]).toEqual(['E-0 step 4 +1', e0, true])
    expect(view?.procedure.title).toContain('Verify SI actuated')
    expect(plantCardView(plantWith(running), { active: [frh], inactive: [e0] })?.procedure.text).toBe('FR-H.1')
  })

  test('a reading that is no number reads "—" and has no point for its line', () => {
    const [thermal] = running.energy
    const view = plantCardView(plantWith({ ...running, energy: [{ ...thermal!, value: null }] }), noRuns)
    expect(view?.energy).toEqual([{ path: 'core.totalThermalPowerMw', label: 'Core thermal power', text: '—', unit: 'MW', point: null }])
  })

  test('the safety function line names the most challenged one in its colour, with the procedure it calls for while no run runs it', () => {
    const frh = runOf('FR-H.1', { label: '2', name: 'Check secondary heat sink' })
    const lost = plantWith({ ...running, worstSafetyFunction: heatSink('red', 'FR-H.1') })
    expect(plantCardView(lost, noRuns)?.safetyFunction).toEqual({
      status: 'red',
      text: 'HEAT SINK · FR-H.1',
      title: 'Heat sink: RED\nNo steam generator has level on span and feed is below the minimum flow: the secondary heat sink is lost.',
      notRunning: 'FR-H.1',
    })
    // Running it, or a run of it ended and entered again, is no longer "not running".
    expect(plantCardView(lost, { active: [frh], inactive: [] })?.safetyFunction?.notRunning).toBeNull()
    expect(plantCardView(lost, { active: [], inactive: [frh] })?.safetyFunction?.notRunning).toBe('FR-H.1')
  })

  test('none challenged reads "CSF" in green; one that cannot be judged reads "?"; none judged now, none declared or a pending runtime show no line', () => {
    const green = plantCardView(plantWith({ ...running, worstSafetyFunction: heatSink('green') }), noRuns)?.safetyFunction
    expect(green).toEqual({ status: 'green', text: 'CSF', title: 'Critical safety functions: none challenged', notRunning: null })
    expect(plantCardView(plantWith({ ...running, worstSafetyFunction: heatSink('unknown') }), noRuns)?.safetyFunction).toMatchObject({ status: 'unknown', text: 'HEAT SINK ?', notRunning: null })
    expect(plantCardView(plantWith({ ...running, worstSafetyFunction: heatSink('not-monitored') }), noRuns)?.safetyFunction).toBeNull()
    expect(plantCardView(plantWith(running), noRuns)?.safetyFunction).toBeNull()
    expect(plantCardView(plantWith({ ...running, statusTone: 'idle', worstSafetyFunction: heatSink('red', 'FR-H.1') }), noRuns)?.safetyFunction).toBeNull()
    // A procedure name the procedure window cannot open is named, not linked.
    expect(plantCardView(plantWith({ ...running, worstSafetyFunction: heatSink('orange', 'see the shift supervisor') }), noRuns)?.safetyFunction)
      .toMatchObject({ text: 'HEAT SINK · see the shift supervisor', notRunning: null })
  })

  test('an object that is no Plant has no card', () => {
    expect(plantCardView({ ...unit, packData: { type: 'drone' } }, noRuns)).toBeNull()
  })
})

describe('a Plant card\'s energy lines begin with the Run\'s recorded history, never with the card', () => {
  const runId = 'run:card' as SimulationRunId
  const t0 = Date.parse(runAt)
  const thermal = (t: number, v: number | null): PlantCardEnergy =>
    ({ path: 'core.totalThermalPowerMw', label: 'Core thermal power', text: v === null ? '—' : `${v} MW`, unit: 'MW', point: v === null ? null : { t, v } })
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

  /** A historian that answers each read when told to, and says what it was asked. */
  const historian = () => {
    const asked: Array<{ readonly seriesId: string; readonly from: number; readonly to: number; readonly answer: (points: ReadonlyArray<TrendPoint>) => void; readonly fail: (error: Error) => void }> = []
    const history: PlantCardHistory = (_run, seriesId, window) => new Promise((resolve, reject) => {
      asked.push({ seriesId, ...window, answer: resolve, fail: reject })
    })
    return { asked, history }
  }

  test('reads the ten minutes before now from the series the historian records the rate in, then continues with each newer reading', async () => {
    const { asked, history } = historian()
    const trends = createPlantCardTrends({ history })
    trends.show({ runId, objectId: unit.id, energy: [thermal(t0, 3400)] })
    expect(asked.map(read => [read.seriesId, read.from, read.to])).toEqual([[recordingSeriesIdFor(unit.id, 'core.totalThermalPowerMw'), t0 - PLANT_CARD_TREND_MS - HOLD_GAP_MS, t0]])
    expect(trends.lines().get('core.totalThermalPowerMw')).toEqual({ kind: 'reading' })
    // A reading the projection brings while the history is read continues the line once it is read.
    trends.show({ runId, objectId: unit.id, energy: [thermal(t0 + 1_000, 3401)] })
    asked[0]!.answer([{ t: t0 - 120_000, v: 3398 }, { t: t0 - 1_000, v: 3399 }, { t: t0, v: 3400 }])
    await settle()
    expect(trends.lines().get('core.totalThermalPowerMw')).toEqual({ kind: 'line', points: [{ t: t0 - 120_000, v: 3398 }, { t: t0 - 1_000, v: 3399 }, { t: t0, v: 3400 }, { t: t0 + 1_000, v: 3401 }] })
    // The same reading again adds nothing; a newer one extends the line, and those whose hold ends before the window leave it.
    trends.show({ runId, objectId: unit.id, energy: [thermal(t0 + 1_000, 3401)] })
    trends.show({ runId, objectId: unit.id, energy: [thermal(t0 + PLANT_CARD_TREND_MS + HOLD_GAP_MS, 3402)] })
    const line = trends.lines().get('core.totalThermalPowerMw')
    expect(line?.kind === 'line' ? line.points.map(point => point.v) : null).toEqual([3400, 3401, 3402])
    expect(asked).toHaveLength(1)
  })

  test('no line where the historian holds nothing in the window or cannot be read, nor where no Run is joined, however long the card stays open', async () => {
    const { asked, history } = historian()
    const trends = createPlantCardTrends({ history })
    trends.show({ runId, objectId: unit.id, energy: [thermal(t0, 3400), { ...thermal(t0, 1162), path: 'turbine.electricMw' }] })
    asked[0]!.answer([])
    asked[1]!.fail(new Error('the historian is unavailable'))
    await settle()
    for (let second = 1; second <= 60; second += 1) trends.show({ runId, objectId: unit.id, energy: [thermal(t0 + second * 1_000, 3400)] })
    expect(trends.lines().get('core.totalThermalPowerMw')).toEqual({ kind: 'none', reason: 'The Run\'s historian holds none of its readings from the last 10 min' })
    expect(trends.lines().get('turbine.electricMw')).toEqual({ kind: 'none', reason: 'Its history could not be read: the historian is unavailable' })
    const unjoined = createPlantCardTrends({ history })
    unjoined.show({ runId: null, objectId: unit.id, energy: [thermal(t0, 3400)] })
    expect(unjoined.lines().get('core.totalThermalPowerMw')?.kind).toBe('none')
    expect(asked).toHaveLength(2)
  })

  test('another unit, or Run time that goes back, reads the history again, and a read for a unit no longer shown is dropped', async () => {
    const { asked, history } = historian()
    const trends = createPlantCardTrends({ history })
    trends.show({ runId, objectId: unit.id, energy: [thermal(t0, 3400)] })
    trends.show({ runId, objectId: 'plant:other', energy: [thermal(t0, 2900)] })
    asked[0]!.answer([{ t: t0, v: 3400 }])
    asked[1]!.answer([{ t: t0 - 1_000, v: 2900 }])
    await settle()
    expect(trends.lines().get('core.totalThermalPowerMw')).toEqual({ kind: 'line', points: [{ t: t0 - 1_000, v: 2900 }, { t: t0, v: 2900 }] })
    // The Run restarted: its time stands before the line's last point.
    trends.show({ runId, objectId: 'plant:other', energy: [thermal(t0 - 600_000, 3400)] })
    expect(asked.map(read => read.to)).toEqual([t0, t0, t0 - 600_000])
    expect(trends.lines().get('core.totalThermalPowerMw')).toEqual({ kind: 'reading' })
    trends.close()
    asked[2]!.answer([{ t: t0 - 600_000, v: 3400 }])
    await settle()
    expect(trends.lines().size).toBe(0)
  })
})

const disk = (x: number, y: number) => ({ x, y, radius: 17 })
const clear = { left: 0, top: 0, right: 1000, bottom: 700 }
const size = { width: 300, height: 230 }

describe('a card stands beside its icon, clear of the other icons and the panels', () => {
  test('to the right where it fits and covers nothing', () => {
    expect(placeObjectCard({ disk: disk(400, 300), others: [], clear }, size)).toEqual({ side: 'right', left: 429, top: 185 })
  })

  test('to the left when a sibling unit stands to the right, below or above when both sides are taken', () => {
    const siblingRight = { disk: disk(400, 300), others: [disk(520, 300)], clear }
    expect(placeObjectCard(siblingRight, size).side).toBe('left')
    const fan: MapObjectAnchor = { disk: disk(400, 300), others: [disk(520, 300), disk(280, 300)], clear }
    expect(placeObjectCard(fan, size).side).toBe('below')
  })

  test('to the left near the clear area\'s right edge, which a panel may set', () => {
    expect(placeObjectCard({ disk: disk(700, 300), others: [], clear: { ...clear, right: 760 } }, size).side).toBe('left')
  })

  test('never off screen: where no side fits, pressed into the clear area', () => {
    const cramped = placeObjectCard({ disk: disk(150, 120), others: [], clear: { left: 0, top: 0, right: 320, bottom: 240 } }, size)
    expect(cramped.left).toBeGreaterThanOrEqual(8)
    expect(cramped.left + size.width).toBeLessThanOrEqual(320)
  })

  test('docked in the clear top-left corner, below what already stands there', () => {
    expect(dockObjectCard({ left: 0, top: 0, right: 1000, bottom: 700 }, [], size)).toEqual({ side: 'docked', left: 12, top: 12 })
    expect(dockObjectCard({ left: 0, top: 0, right: 1000, bottom: 700 }, [{ left: 18, top: 18, right: 478, bottom: 140 }], size).top).toBe(152)
  })

  test('docked over what stands in the corner rather than off the bottom of a short map', () => {
    const short = { left: 0, top: 0, right: 1000, bottom: 300 }
    expect(dockObjectCard(short, [{ left: 18, top: 18, right: 478, bottom: 140 }], size).top).toBe(62)
  })

  test('a frame that says nothing new is not placed again', () => {
    const frame: MapCardFrame = { origin: { x: 360, y: 0 }, clear, anchor: { disk: disk(400, 300), others: [disk(520, 300)], clear } }
    expect(sameCardFrame(null, frame)).toBe(false)
    expect(sameCardFrame(frame, { ...frame, anchor: { ...frame.anchor!, others: [disk(520, 300)] } })).toBe(true)
    expect(sameCardFrame(frame, { ...frame, anchor: { ...frame.anchor!, disk: disk(401, 300) } })).toBe(false)
    expect(sameCardFrame(frame, { ...frame, anchor: null })).toBe(false)
    expect(sameCardFrame({ ...frame, anchor: null }, { ...frame, anchor: null })).toBe(true)
    expect(sameCardFrame(frame, { ...frame, origin: { x: 0, y: 0 } })).toBe(false)
  })

  test('the anchor is the icon as drawn, and there is none when the icon is outside the clear area or not drawn', () => {
    const pointOf = (id: string, x: number): OperationalPointFeature => ({ id, object: { id } as OperationalObject, position: [x, 0, 0], sizePx: 23 } as unknown as OperationalPointFeature)
    const points = [pointOf('a', 100), pointOf('b', 140), pointOf('far', 5000)]
    const screenOf = (position: readonly [number, number, number]) => ({ x: position[0], y: 300 })
    const anchor = objectCardAnchor({ points, objectId: 'a', screenOf, clear })
    expect(anchor?.disk.x).toBe(100)
    expect(anchor?.others.map(other => other.x)).toEqual([140])
    expect(objectCardAnchor({ points, objectId: 'far', screenOf, clear })).toBeNull()
    expect(objectCardAnchor({ points, objectId: 'missing', screenOf, clear })).toBeNull()
  })
})

describe('the hover card previews the card', () => {
  const presentation = { categoryId: 'plants', icon: 'factory', color: '#22845d', summary: '', fields: [{ key: 'model', label: 'Model', value: 'pwr' }] }

  test('an object with a glance shows its glance lines instead of every field; without one, the fields as before', () => {
    const glanced = objectHoverCardHtml({ object: unit, presentation: { ...presentation, glance: ['Normal · Power operation', 'Core thermal power 3400 MW'] }, hasNewInfo: false, targetPreview: null })
    expect(glanced).toBe(`<strong>${unit.label}</strong><div>Normal · Power operation</div><div>Core thermal power 3400 MW</div>`)
    expect(objectHoverCardHtml({ object: unit, presentation, hasNewInfo: false, targetPreview: null })).toBe(`<strong>${unit.label}</strong><div>Model: pwr</div>`)
  })

  test('an order preview still leads the glance', () => {
    const html = objectHoverCardHtml({ object: unit, presentation: { ...presentation, glance: ['Normal'] }, hasNewInfo: false, targetPreview: { text: 'Send D-1 to Halden Unit 1', refused: false } })
    expect(html).toBe(`<strong>${unit.label}</strong><div class="hover-target-preview">Send D-1 to Halden Unit 1</div><div>Normal</div>`)
  })
})
