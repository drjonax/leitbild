import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { compileProcessPlant, createProcessPlantRuntime, createPwrReferencePlantDefinition, type VariablePath } from '../src/packs/process-plant/index.ts'
import type { ComposedDisplayPen } from '../src/packs/process-plant/displays/compose.ts'
import { mimicQuickLookPaths, QUICK_LOOK_LEADS } from '../src/packs/process-plant/displays/mimic/quick-look.ts'
import { equipmentKeyValues } from '../src/packs/process-plant/displays/overview-key-values.ts'
import { compileMimicScope } from '../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import { principalCircuits } from '../src/packs/process-plant/displays/mimic/principal.ts'
import { chatMimicProfile, overviewMimicProfile } from '../src/packs/process-plant/displays/mimic/profiles.ts'
import { QUICK_LOOK_DOT, textWidth } from '../src/packs/process-plant/displays/mimic/text-metrics.ts'
import type { ComposedDisplayClient, ComposedDisplaySample } from '../src/ui/embed/composed-display/composed-display-client.ts'
import { keptInWindow, movedOverlay, nextPopover, OVERLAY_WIDTH, popoverPlacement, POPOVER_CLOSED, POPOVER_WIDTH, QUICK_LOOK_ROW, raisedOverlay, resizedOverlay, togglePinned, type PinnedOverlay, type PopoverMode, type PopoverState } from '../src/ui/embed/composed-display/mimic/popover.ts'
import { createMimicQuickLook, type QuickLookState } from '../src/ui/embed/composed-display/mimic/quick-look-source.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// An interactive drawing's detail dots and the popover they open: one at a
// time, a quick look when a dot is hovered a moment, the item's controls too
// when it is pressed; placed beside its item at 100 % whatever the window's
// zoom; pinned, an overlay a person drags and resizes, several at once; its
// quick look chosen with the drawing and read from the Run while it is open.

describe('the item popover', () => {
  const open = (item: string, mode: PopoverMode): PopoverState => ({ kind: 'open', item, mode })

  test('hovering opens a quick look, a press the item\'s controls too; a second press on its dot closes it', () => {
    expect(nextPopover(POPOVER_CLOSED, { kind: 'hovered', item: 'a' })).toEqual(open('a', 'look'))
    expect(nextPopover(open('a', 'look'), { kind: 'pressed', item: 'a' })).toEqual(open('a', 'operate'))
    expect(nextPopover(open('a', 'operate'), { kind: 'pressed', item: 'a' })).toEqual(POPOVER_CLOSED)
    expect(nextPopover(open('a', 'operate'), { kind: 'pressed', item: 'b' })).toEqual(open('b', 'operate'))
    expect(nextPopover(POPOVER_CLOSED, { kind: 'pressed', item: 'a' })).toEqual(open('a', 'operate'))
  })

  test('hovering never takes over a popover a press opened; leaving, Esc or a press outside close either (there is no Close)', () => {
    expect(nextPopover(open('a', 'operate'), { kind: 'hovered', item: 'b' })).toEqual(open('a', 'operate'))
    expect(nextPopover(open('a', 'look'), { kind: 'hovered', item: 'b' })).toEqual(open('b', 'look'))
    expect(nextPopover(open('a', 'look'), { kind: 'left' })).toEqual(POPOVER_CLOSED)
    expect(nextPopover(open('a', 'operate'), { kind: 'left' })).toEqual(POPOVER_CLOSED)
    expect(nextPopover(open('a', 'operate'), { kind: 'dismissed' })).toEqual(POPOVER_CLOSED)
  })

  test('the pin keeps a popover on the surface until it is pressed again; several stand at once, the one touched last on top', () => {
    const a: PinnedOverlay = { item: 'a', x: 100, y: 50, width: POPOVER_WIDTH, rows: null }
    const b: PinnedOverlay = { item: 'b', x: 500, y: 50, width: POPOVER_WIDTH, rows: null }
    const both = togglePinned(togglePinned([], a), b)
    expect(both.map(overlay => overlay.item)).toEqual(['a', 'b'])
    expect(raisedOverlay(both, 'a').map(overlay => overlay.item)).toEqual(['b', 'a'])
    expect(togglePinned(both, a)).toEqual([b])
  })

  test('an overlay is dragged and kept inside the window, at the window\'s zoom', () => {
    const page = { width: 1600, height: 900 }
    const a: PinnedOverlay = { item: 'a', x: 100, y: 50, width: 340, rows: null }
    expect(movedOverlay(a, { dx: 40, dy: 10 }, 200, page, 1)).toEqual({ ...a, x: 140, y: 60 })
    // Never past the window's edges: 340 wide, 200 tall.
    expect(movedOverlay(a, { dx: 5000, dy: 5000 }, 200, page, 1)).toEqual({ ...a, x: 1260, y: 700 })
    expect(movedOverlay(a, { dx: -500, dy: -500 }, 200, page, 1)).toEqual({ ...a, x: 0, y: 0 })
    // Drawn at 1/2 when the window shows the display at 200 %: it takes half the page's px.
    expect(movedOverlay(a, { dx: 5000, dy: 0 }, 200, page, 2)).toEqual({ ...a, x: 1430, y: 50 })
    // A smaller window moves it back inside.
    expect(keptInWindow({ ...a, x: 1400 }, 200, { width: 1200, height: 900 }, 1)).toEqual({ ...a, x: 860 })
  })

  test('resizing widens only the trends, between 280 and 520 px, and shows whole rows, dropping the rest from the bottom', () => {
    const page = { width: 1600, height: 900 }
    const a: PinnedOverlay = { item: 'a', x: 100, y: 50, width: 340, rows: null }
    const start = { width: 340, rows: 6 }
    // 6 rows drawn in 260 px: chrome 92 px.
    expect(resizedOverlay(a, start, { dx: 100, dy: 0 }, 6, 260, page, 1)).toEqual({ ...a, width: 440, rows: null })
    expect(resizedOverlay(a, start, { dx: 1000, dy: 0 }, 6, 260, page, 1).width).toBe(OVERLAY_WIDTH.max)
    expect(resizedOverlay(a, start, { dx: -1000, dy: 0 }, 6, 260, page, 1).width).toBe(OVERLAY_WIDTH.min)
    // Two rows up: 4 rows; a short drag snaps to whole rows; never fewer than one, never more than it has.
    expect(resizedOverlay(a, start, { dx: 0, dy: -2 * QUICK_LOOK_ROW }, 6, 260, page, 1).rows).toBe(4)
    expect(resizedOverlay(a, start, { dx: 0, dy: -10 }, 6, 260, page, 1).rows).toBeNull()
    expect(resizedOverlay(a, start, { dx: 0, dy: -1000 }, 6, 260, page, 1).rows).toBe(1)
    expect(resizedOverlay(a, { width: 340, rows: 2 }, { dx: 0, dy: 1000 }, 6, 148, page, 1).rows).toBeNull()
    // Near the window's bottom edge it shows only the rows that fit above it: 200 px less 92 px of chrome hold 3.
    expect(resizedOverlay({ ...a, y: 700 }, { width: 340, rows: 2 }, { dx: 0, dy: 1000 }, 6, 148, page, 1).rows).toBe(3)
  })

  test('it stands beside its item, never over it, and reads at 100 % at the window\'s zoom', () => {
    const page = { width: 1600, height: 900 }
    const popover = { width: 360, height: 400 }
    // Right of the item where it fits, its top level with the item's.
    expect(popoverPlacement({ x: 100, y: 200, width: 120, height: 60 }, popover, page, 1)).toEqual({ x: 228, y: 200 })
    // At the page's right edge it goes left of the item; near the bottom it is lifted to fit.
    expect(popoverPlacement({ x: 1500, y: 700, width: 80, height: 100 }, popover, page, 1)).toEqual({ x: 1132, y: 500 })
    // At half zoom it is drawn twice as large in the page's px, so it reads at 100 %: it needs twice the room.
    expect(popoverPlacement({ x: 100, y: 0, width: 120, height: 60 }, popover, page, 0.5)).toEqual({ x: 236, y: 0 })
    expect(popoverPlacement({ x: 1000, y: 0, width: 120, height: 60 }, popover, page, 0.5)).toEqual({ x: 264, y: 0 })
  })
})

describe('the quick look', () => {
  const pen = (path: string, recorded: boolean, gate?: string) => ({
    path, seriesId: `series:${path}`, recorded, valueKind: 'number',
    thresholds: gate === undefined ? [] : [{ gates: [{ path: gate }] }],
  })
  const pens = [pen('sgB.level', true, 'core.aboveP10'), pen('sgB.pressure', false), pen('sgB.wideLevel', true)] as unknown as ReadonlyArray<ComposedDisplayPen>
  const sample = (time: string): ComposedDisplaySample => ({ simulationTime: time, plantElapsedMs: 0, values: [{ path: 'sgB.level', value: 52, quality: 'good' }] })
  const harness = (failSample = false) => {
    const calls: Array<{ kind: string; detail: unknown }> = []
    let tick: (() => void) | undefined
    let cleared = false
    const client: Pick<ComposedDisplayClient, 'history' | 'sample'> = {
      history: async (_runId, seriesId, window) => {
        calls.push({ kind: 'history', detail: { seriesId, window } })
        return seriesId === 'series:sgB.level' ? [{ t: Date.parse('2026-10-12T10:05:00.000Z'), v: 55 }] : []
      },
      sample: async (_runId, _plantId, paths, alarms) => {
        calls.push({ kind: 'sample', detail: { paths, alarms } })
        if (failSample) throw new Error('the Run is not loaded')
        return sample('2026-10-12T10:10:00.000Z')
      },
    }
    const source = createMimicQuickLook({
      client, runId: 'run-1' as SimulationRunId, plantId: 'plant:a',
      setInterval: run => { tick = run; return 'timer' }, clearInterval: () => { cleared = true },
    })
    return { calls, source, tick: () => tick?.(), cleared: () => cleared }
  }
  const settle = async () => { for (let at = 0; at < 6; at++) await new Promise(resolve => setTimeout(resolve, 0)) }

  test('opening one compiles nothing: it samples its lead values and reads their sparklines\' history', async () => {
    const { calls, source } = harness()
    const states: QuickLookState[] = []
    const stop = source.open({ pens, sparklineMs: 600_000 }, state => states.push(state))
    await settle()
    expect(states[0]).toEqual({ kind: 'loading' })
    // Only samples and history: no display is drawn or compiled for it.
    expect(new Set(calls.map(call => call.kind))).toEqual(new Set(['sample', 'history']))
    // Sampled with what its limits' gates read, without alarms (the drawing's own sample carries them).
    expect(calls[0]).toEqual({ kind: 'sample', detail: { paths: ['sgB.level', 'core.aboveP10', 'sgB.pressure', 'sgB.wideLevel'], alarms: false } })
    // History for the recorded ones, from a hold gap before the sparkline's 10 minutes, up to the Run's time now.
    const histories = calls.filter(call => call.kind === 'history').map(call => call.detail as { seriesId: string; window: { from: number; to: number } })
    expect(histories.map(call => call.seriesId)).toEqual(['series:sgB.level', 'series:sgB.wideLevel'])
    expect(histories[0]!.window).toEqual({ from: Date.parse('2026-10-12T10:10:00.000Z') - 600_000 - 90_000, to: Date.parse('2026-10-12T10:10:00.000Z') })
    const shown = states.at(-1)!
    if (shown.kind !== 'shown') throw new Error(shown.kind)
    expect(shown.latest?.values[0]?.value).toBe(52)
    expect(shown.history.historyMissing.has('sgB.wideLevel')).toBe(true)
    expect(shown.history.series.get('sgB.level')?.map(point => point.v)).toEqual([55, 52])
    stop()
  })

  test('it reads each second while open and nothing once closed', async () => {
    const { calls, source, tick, cleared } = harness()
    const states: QuickLookState[] = []
    const stop = source.open({ pens, sparklineMs: 600_000 }, state => states.push(state))
    await settle()
    const samples = () => calls.filter(call => call.kind === 'sample').length
    expect(samples()).toBe(1)
    tick()
    await settle()
    expect(samples()).toBe(2)
    const seen = states.length
    stop()
    expect(cleared()).toBe(true)
    tick()
    await settle()
    expect(states.length).toBe(seen)
  })

  test('a sample that fails says so beside the values it last had', async () => {
    const { source } = harness(true)
    const states: QuickLookState[] = []
    source.open({ pens, sparklineMs: 600_000 }, state => states.push(state))
    await settle()
    expect(states.at(-1)).toMatchObject({ kind: 'shown', latest: undefined, sampleError: 'the Run is not loaded' })
  })

  test('each drawn item\'s quick look is the first six of what its detail leads with now', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:quick-looks', loopCount: 4 }))
    const runtime = createProcessPlantRuntime({ system: plant })
    const principal = principalCircuits(plant.graph)
    if (!principal.ok) throw new Error(principal.reason)
    const drawn = compileMimicScope(plant, principal.scope, { profile: overviewMimicProfile, maxWidth: 4000, maxHeight: 4000 })
    if (!drawn.ok) throw new Error('not drawn')
    const now = { mode: 'powerOperation', read: (path: VariablePath) => runtime.readVariable(path) }
    const looks = mimicQuickLookPaths(plant, drawn.mimic, now)
    for (const item of drawn.mimic.items) {
      const components = item.components.map(id => plant.graph.componentIndexById.get(id as never)!)
      expect(looks[item.id] ?? []).toEqual(equipmentKeyValues(plant, components, now).slice(0, QUICK_LOOK_LEADS))
    }
    expect(Object.values(looks).every(paths => paths.length > 0 && paths.length <= QUICK_LOOK_LEADS)).toBe(true)
    const core = drawn.mimic.items.find(item => item.binding.label === 'Core')!
    expect(looks[core.id]?.[0]).toBe('core.powerRangePercent' as never)
  })
})

describe('detail dots on the drawing', () => {
  test('an interactive drawing reserves each item\'s dot after its tag; a chat answer\'s does not', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:dots', loopCount: 4 }))
    const principal = principalCircuits(plant.graph)
    if (!principal.ok) throw new Error(principal.reason)
    const drawn = (profile: typeof overviewMimicProfile) => {
      const result = compileMimicScope(plant, principal.scope, { profile, maxWidth: 4000, maxHeight: 4000 })
      if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
      return result.mimic
    }
    const dot = QUICK_LOOK_DOT.gap + QUICK_LOOK_DOT.size
    for (const item of drawn(overviewMimicProfile).items) expect(item.text!.width).toBeGreaterThanOrEqual(textWidth('tag', item.binding.label) + dot)
    expect(overviewMimicProfile.quickLooks).toBe(true)
    expect(chatMimicProfile.quickLooks).toBe(false)
  })
})
