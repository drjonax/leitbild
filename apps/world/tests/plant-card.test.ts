import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, OperationalObject } from '../src/core/model/index.ts'
import { processPlantUnitPackDataSchema, type ProcessPlantUnitProjection } from '../src/packs/process-plant/model.ts'
import type { OperationalPointFeature } from '../src/ui/map-runtime/types.ts'
import {
  dockObjectCard,
  objectCardAnchor,
  placeObjectCard,
  sameCardFrame,
  type MapCardFrame,
  type MapObjectAnchor,
} from '../src/ui/map/object-card-anchor.ts'
import { plantCardView } from '../src/ui/process-display/plant-card.ts'
import { objectHoverCardHtml } from '../src/ui/map/object-hover-card.ts'
import type { ProcedureRunSummary, ProcedureRunSummaryGroup } from '../src/ui/procedures/procedure-run-selectors.ts'
import { scenarios } from './fixtures/scenarios.ts'

const at = '2026-10-14T09:00:00.000Z' as IsoTimestamp
const unit = scenarios.find(scenario => scenario.id === 'test-plant')?.initialObjects.find(object => object.packId === 'process-plant')
if (unit === undefined) throw new Error('the Plant fixture has no Plant')

const running: ProcessPlantUnitProjection = {
  schemaVersion: 1,
  summary: 'Core thermal power 3400 MW · Electrical output 1162 MW',
  statusTone: 'ready',
  statusLabel: 'Normal',
  activeAlarmCount: 0,
  activeTripCount: 0,
  fields: [],
  updatedAt: at,
}

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
  test('a running unit: its energy sentence, its mode, no chip, "No alarms" and "None running"', () => {
    const view = plantCardView(plantWith({ ...running, modeLabel: 'Power operation' }), noRuns)
    expect(view).toEqual({
      name: unit.label,
      tone: 'ready',
      statusLabel: 'Normal',
      chip: null,
      mode: 'Power operation',
      energy: 'Core thermal power 3400 MW · Electrical output 1162 MW',
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

  test('an object that is no Plant has no card', () => {
    expect(plantCardView({ ...unit, packData: { type: 'drone' } }, noRuns)).toBeNull()
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
