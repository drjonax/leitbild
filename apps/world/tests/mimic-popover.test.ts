import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import type { ComposedReadoutsPanel } from '../src/packs/process-plant/displays/compose.ts'
import { compileMimicScope } from '../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import type { MimicDrawnItem } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'
import { principalCircuits } from '../src/packs/process-plant/displays/mimic/principal.ts'
import { chatMimicProfile, overviewMimicProfile } from '../src/packs/process-plant/displays/mimic/profiles.ts'
import { QUICK_LOOK_DOT, textWidth } from '../src/packs/process-plant/displays/mimic/text-metrics.ts'
import type { ComposedDisplayClient, ComposedDisplaySample } from '../src/ui/embed/composed-display/composed-display-client.ts'
import { nextPopover, popoverPlacement, POPOVER_CLOSED, type PopoverState } from '../src/ui/embed/composed-display/mimic/popover.ts'
import { createMimicQuickLook, QUICK_LOOK_LEADS, type QuickLookState } from '../src/ui/embed/composed-display/mimic/quick-look-source.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// An interactive drawing's detail dots and the popover they open: one at a
// time, opened by hovering a dot a moment or by pressing it, which pins it;
// placed beside its item at 100 % whatever the window's zoom; its quick look
// read from the item's detail while it is open.

describe('the item popover', () => {
  const open = (item: string, pinned: boolean): PopoverState => ({ kind: 'open', item, pinned })

  test('a press always pins: it never closes a popover hovering opened, only a pinned one on its own dot', () => {
    expect(nextPopover(POPOVER_CLOSED, { kind: 'hovered', item: 'a' })).toEqual(open('a', false))
    expect(nextPopover(open('a', false), { kind: 'pressed', item: 'a' })).toEqual(open('a', true))
    expect(nextPopover(open('a', true), { kind: 'pressed', item: 'a' })).toEqual(POPOVER_CLOSED)
    expect(nextPopover(open('a', true), { kind: 'pressed', item: 'b' })).toEqual(open('b', true))
    expect(nextPopover(POPOVER_CLOSED, { kind: 'pressed', item: 'a' })).toEqual(open('a', true))
  })

  test('hovering never takes over a pinned popover, and leaving closes only a hovered one', () => {
    expect(nextPopover(open('a', true), { kind: 'hovered', item: 'b' })).toEqual(open('a', true))
    expect(nextPopover(open('a', false), { kind: 'hovered', item: 'b' })).toEqual(open('b', false))
    expect(nextPopover(open('a', false), { kind: 'left' })).toEqual(POPOVER_CLOSED)
    expect(nextPopover(open('a', true), { kind: 'left' })).toEqual(open('a', true))
    expect(nextPopover(open('a', true), { kind: 'dismissed' })).toEqual(POPOVER_CLOSED)
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
  const item = { id: 'c3', components: ['sgB'], binding: { label: 'SG B' } } as unknown as MimicDrawnItem
  const pen = (path: string, recorded: boolean, gate?: string) => ({
    path, seriesId: `series:${path}`, recorded, valueKind: 'number',
    thresholds: gate === undefined ? [] : [{ gates: [{ path: gate }] }],
  })
  const panel = { kind: 'readouts', sparklineMs: 600_000, pens: [pen('sgB.level', true, 'core.aboveP10'), pen('sgB.pressure', false), ...Array.from({ length: 6 }, (_, at) => pen(`sgB.more${at}`, true))] } as unknown as ComposedReadoutsPanel
  const sample = (time: string): ComposedDisplaySample => ({ simulationTime: time, plantElapsedMs: 0, values: [{ path: 'sgB.level', value: 52, quality: 'good' }] })
  const harness = () => {
    const calls: Array<{ kind: string; detail: unknown }> = []
    let tick: (() => void) | undefined
    let cleared = false
    const client: Pick<ComposedDisplayClient, 'view' | 'history' | 'sample'> = {
      view: async (runId, plantId, state, size) => {
        calls.push({ kind: 'view', detail: { runId, plantId, state: JSON.parse(state), size } })
        return { kind: 'detail', plantId, plantLabel: null, simulationTime: '2026-10-12T10:10:00.000Z', display: { panels: [panel, { kind: 'mimic' }] } } as never
      },
      history: async (_runId, seriesId, window) => {
        calls.push({ kind: 'history', detail: { seriesId, window } })
        return seriesId === 'series:sgB.level' ? [{ t: Date.parse('2026-10-12T10:05:00.000Z'), v: 55 }] : []
      },
      sample: async (_runId, _plantId, paths, alarms) => {
        calls.push({ kind: 'sample', detail: { paths, alarms } })
        return sample('2026-10-12T10:10:01.000Z')
      },
    }
    const source = createMimicQuickLook({
      client, runId: 'run-1' as SimulationRunId, plantId: 'plant:a', size: () => ({ width: 1896, height: 972 }),
      setInterval: run => { tick = run; return 'timer' }, clearInterval: () => { cleared = true },
    })
    return { calls, source, tick: () => tick?.(), cleared: () => cleared }
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

  test('it is the item\'s detail\'s lead values, the first six, each recorded one with its sparkline\'s history', async () => {
    const { calls, source } = harness()
    const states: QuickLookState[] = []
    const stop = source.open(item, state => states.push(state))
    for (let at = 0; at < 5; at++) await settle()
    // The same detail the item opens, drawn for the same window, so the two are one compile and never disagree.
    expect(calls[0]).toEqual({ kind: 'view', detail: { runId: 'run-1', plantId: 'plant:a', state: { detail: { plantId: 'plant:a', components: ['sgB'] } }, size: { width: 1896, height: 972 } } })
    expect(states[0]).toEqual({ kind: 'loading' })
    const shown = states.at(-1)!
    if (shown.kind !== 'shown') throw new Error(shown.kind)
    expect(shown.panel?.pens.map(entry => String(entry.path))).toHaveLength(QUICK_LOOK_LEADS)
    // History for the recorded ones, from a hold gap before the sparkline's 10 minutes.
    const histories = calls.filter(call => call.kind === 'history').map(call => call.detail as { seriesId: string; window: { from: number; to: number } })
    expect(histories.map(call => call.seriesId)).toEqual(['series:sgB.level', 'series:sgB.more0', 'series:sgB.more1', 'series:sgB.more2', 'series:sgB.more3'])
    expect(histories[0]!.window.to - histories[0]!.window.from).toBe(600_000 + 90_000)
    expect(shown.history.historyMissing.has('sgB.more0')).toBe(true)
    // Sampled with what its limits' gates read, without alarms (the drawing's own sample carries them).
    expect(calls.find(call => call.kind === 'sample')?.detail).toEqual({ paths: ['sgB.level', 'core.aboveP10', 'sgB.pressure', 'sgB.more0', 'sgB.more1', 'sgB.more2', 'sgB.more3'], alarms: false })
    expect(shown.latest?.values[0]?.value).toBe(52)
    expect(shown.history.series.get('sgB.level')?.map(point => point.v)).toEqual([55, 52])
    stop()
  })

  test('it reads each second while open and nothing once closed', async () => {
    const { calls, source, tick, cleared } = harness()
    const states: QuickLookState[] = []
    const stop = source.open(item, state => states.push(state))
    for (let at = 0; at < 5; at++) await settle()
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

  test('a detail that cannot be drawn says why, in place of the values', async () => {
    const source = createMimicQuickLook({
      client: { view: async () => { throw new Error('nothing around it can be drawn legibly') }, history: async () => [], sample: async () => sample('2026-10-12T10:10:00.000Z') },
      runId: 'run-1' as SimulationRunId, plantId: 'plant:a', size: () => null,
    })
    const states: QuickLookState[] = []
    source.open(item, state => states.push(state))
    for (let at = 0; at < 3; at++) await settle()
    expect(states.at(-1)).toEqual({ kind: 'failed', message: 'nothing around it can be drawn legibly' })
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
