import { describe, expect, test } from 'bun:test'
import type { MimicFlowBinding, MimicItemBinding, MimicStateBinding } from '../src/packs/process-plant/displays/mimic/bindings.ts'
import { flowLook, indexSample, itemLook, powerLook } from '../src/packs/process-plant/displays/mimic/evaluate.ts'
import { drawnLook, itemRows, itemTreatment } from '../src/packs/process-plant/displays/mimic/rows.ts'

const sample = (values: Record<string, number | boolean>, quality: Record<string, string> = {}) =>
  indexSample(Object.entries(values).map(([path, value]) => ({ path, value, quality: quality[path] ?? 'good' })))

const item = (state: MimicStateBinding | null): MimicItemBinding => ({
  item: { kind: 'component', component: 0 }, label: 'X', state, values: [], limits: [], frames: [],
})

const pump = item({ aspect: 'running', state: { path: 'p.speedRpm' as never, reading: 'aboveZero' }, command: 'p.running' as never })
const valve = item({ aspect: 'position', state: { path: 'v.effective' as never, reading: 'value' }, command: 'v.command' as never })
const porv = item({ aspect: 'position', command: 'r.command' as never, throughput: { path: 'r.flow' as never, noFlowBelow: 0.2 } })

describe('mimic state of one sample', () => {
  test('a pump runs when it turns; a run command it does not follow is stated', () => {
    expect(itemLook(pump, sample({ 'p.speedRpm': 1200, 'p.running': true }))).toEqual({ state: { kind: 'running' }, notMeasured: false, mismatch: null, words: 'running' })
    // Loss of power: commanded to run, not turning.
    expect(itemLook(pump, sample({ 'p.speedRpm': 0, 'p.running': true }))).toMatchObject({ state: { kind: 'stopped' }, mismatch: 'CMD RUN', words: 'stopped; commanded to run' })
    expect(itemLook(pump, sample({ 'p.running': true })).state.kind).toBe('unknown')
  })

  test('a valve sits where it actually is; a stuck one shows the demand it ignores', () => {
    expect(itemLook(valve, sample({ 'v.effective': 0.35, 'v.command': 1 }))).toMatchObject({ state: { kind: 'position', fraction: 0.35 }, mismatch: 'CMD 100 %', words: '35 % open; commanded 100 % disagrees' })
    expect(itemLook(valve, sample({ 'v.effective': 1, 'v.command': 1 }))).toMatchObject({ mismatch: null, words: 'open' })
    // An out-of-range reading is unknown, never a position.
    expect(itemLook(valve, sample({ 'v.effective': 2 }, { 'v.effective': 'outside-hard-range' })).state.kind).toBe('unknown')
  })

  test('a relief valve whose position is not computed reads by what passes it', () => {
    // PORV stuck open: commanded shut, passing 8.5 kg/s.
    expect(itemLook(porv, sample({ 'r.flow': 8.5, 'r.command': 0 }))).toEqual({
      state: { kind: 'passing', flow: 8.5 }, notMeasured: true, mismatch: 'CMD SHUT', words: 'position not measured; passing 8.5 kg/s; commanded shut',
    })
    expect(itemLook(porv, sample({ 'r.flow': 0.1, 'r.command': 0 }))).toMatchObject({ state: { kind: 'notPassing' }, mismatch: null })
    expect(itemLook(porv, sample({ 'r.flow': 0, 'r.command': 1 })).mismatch).toBe('CMD 100 %')
  })

  test('equipment that does not follow its command stands out as abnormal, and in its alarm\'s colour only while an alarm of its own is active', () => {
    // FCV B failed at 35 % while commanded 100 %: the cause of the runback, before any alarm it leads to.
    const stuck = itemLook(valve, sample({ 'v.effective': 0.35, 'v.command': 1 }))
    expect(itemTreatment(stuck, false)).toBe('abnormal')
    expect(itemTreatment(stuck, true)).toBe('alarm')
    expect(itemTreatment(itemLook(valve, sample({ 'v.effective': 1, 'v.command': 1 })), false)).toBe('normal')
    expect(itemTreatment(itemLook(pump, sample({ 'p.speedRpm': 0, 'p.running': true })), false)).toBe('abnormal')
    // A stale or missing sample says nothing it cannot know.
    expect(itemTreatment(itemLook(valve, sample({})), false)).toBe('normal')
    // A group stands out while any member disagrees.
    const second = item({ aspect: 'running', state: { path: 'q.speedRpm' as never, reading: 'aboveZero' }, command: 'q.running' as never })
    const rows = itemRows(pump, { element: 'device', icon: 'pump', aspect: 'running' }, { marker: false, members: [pump, second], commands: 'stacked' })
    expect(itemTreatment(drawnLook(pump, rows, sample({ 'p.speedRpm': 1200, 'p.running': true, 'q.speedRpm': 0, 'q.running': true })), false)).toBe('abnormal')
    expect(itemTreatment(drawnLook(pump, rows, sample({ 'p.speedRpm': 1200, 'p.running': true, 'q.speedRpm': 0, 'q.running': false })), false)).toBe('normal')
  })

  test('pipes draw direction only where the model solves it', () => {
    const solved: MimicFlowBinding = { flowPath: 'l.flow' as never, fidelity: 'solved', noFlowBelow: 2 }
    expect(flowLook(solved, sample({ 'l.flow': 80 }))).toEqual({ look: 'forward', value: 80 })
    expect(flowLook(solved, sample({ 'l.flow': -12 })).look).toBe('reverse')
    expect(flowLook(solved, sample({ 'l.flow': 0.03 })).look).toBe('none')
    // A loop leg carries its pump's loop flow, which never reverses: size, no direction.
    expect(flowLook({ ...solved, fidelity: 'magnitudeOnly' }, sample({ 'l.flow': 401 })).look).toBe('flowing')
    expect(flowLook({ ...solved, fidelity: 'unverified' }, sample({ 'l.flow': 3400 }))).toEqual({ look: 'unknown', value: null })
    expect(flowLook(solved, sample({})).look).toBe('unknown')
  })

  test('equipment that runs on a flow runs only above its no-flow band (a coasting turbine has stopped)', () => {
    const turbine = item({ aspect: 'running', state: { path: 't.steam' as never, reading: 'flow', noFlowBelow: 4 } })
    expect(itemLook(turbine, sample({ 't.steam': 0.5 })).state.kind).toBe('stopped')
    expect(itemLook(turbine, sample({ 't.steam': 380 })).state.kind).toBe('running')
  })

  test('a power line is live while what feeds it is energized', () => {
    expect(powerLook('b.energized', sample({ 'b.energized': false }))).toBe('dead')
    expect(powerLook(null, sample({}))).toBe('unknown')
  })
})
