import { describe, expect, test } from 'bun:test'
import type { MimicItemBinding, MimicRangeBinding, MimicStateBinding } from '../src/packs/process-plant/displays/mimic/bindings.ts'
import type { LinkFlowBinding } from '../src/packs/process-plant/equipment/link-flow.ts'
import { commandsHeld, flowLook, indexSample, itemLook, powerLook } from '../src/packs/process-plant/displays/mimic/evaluate.ts'
import { drawnLook, itemRows, itemTreatment, rangeText, rowText, shutdownDemanded } from '../src/packs/process-plant/displays/mimic/rows.ts'
import { textWidth } from '../src/packs/process-plant/displays/mimic/text-metrics.ts'

const sample = (values: Record<string, number | boolean>, quality: Record<string, string> = {}) =>
  indexSample(Object.entries(values).map(([path, value]) => ({ path, value, quality: quality[path] ?? 'good' })))

const item = (state: MimicStateBinding | null): MimicItemBinding => ({
  item: { kind: 'component', component: 0 }, label: 'X', state, values: [], ranges: [], shutdown: [], limits: [], frames: [],
})

// As the model declares them: a pump's run state follows its command within the step, a valve strokes in 10 s.
const pump = item({ aspect: 'running', state: { path: 'p.speedRpm' as never, reading: 'aboveZero' }, command: 'p.running' as never, travel: { onS: 0, offS: 0 } })
const valve = item({ aspect: 'position', state: { path: 'v.effective' as never, reading: 'value' }, command: 'v.command' as never, travel: { onS: 10, offS: 10 } })
const porv = item({ aspect: 'position', command: 'r.command' as never, throughput: { path: 'r.flow' as never, noFlowBelow: 0.2 } })

/** A sample whose commands people or AI agents issued at these plant times, read at `nowMs`. */
const issued = (values: Record<string, number | boolean>, log: ReadonlyArray<{ readonly path: string; readonly value: number | boolean; readonly elapsedMs: number }>, nowMs: number) =>
  indexSample(Object.entries(values).map(([path, value]) => ({ path, value, quality: 'good' })), commandsHeld(log, nowMs))

describe('mimic state of one sample', () => {
  test('a pump runs when it turns; a run command it does not follow is stated', () => {
    expect(itemLook(pump, sample({ 'p.speedRpm': 1200, 'p.running': true }))).toEqual({ state: { kind: 'running' }, notMeasured: false, mismatch: null, words: 'running' })
    // Loss of power: commanded to run, not turning.
    expect(itemLook(pump, sample({ 'p.speedRpm': 0, 'p.running': true }))).toMatchObject({ state: { kind: 'stopped' }, mismatch: 'CMD RUN', words: 'stopped; commanded to run' })
    expect(itemLook(pump, sample({ 'p.running': true })).state.kind).toBe('unknown')
  })

  test('a pump writes RUN as it writes STOP, so its icon\'s fill is never all that tells them apart', () => {
    const presentation = { element: 'device' } as never
    const rows = (stacked: boolean) => itemRows(pump, presentation, { marker: false, members: [], commands: stacked ? 'stacked' : 'inline', offSpan: 'end' })
    for (const stacked of [false, true]) {
      const state = rows(stacked)[0]!
      expect(state.kind === 'state' && state.texts.includes('RUN') && state.texts.includes('STOP')).toBe(true)
      const words = (values: Record<string, number | boolean>) => rows(stacked).map(row => rowText(row, itemLook(pump, sample(values)), sample(values), String))
      expect(words({ 'p.speedRpm': 1200, 'p.running': true })[0]).toBe('RUN')
      expect(words({ 'p.speedRpm': 0, 'p.running': false })[0]).toBe('STOP')
      // A run command it does not follow still says so.
      expect(words({ 'p.speedRpm': 0, 'p.running': true }).join(' ')).toContain('RUN')
    }
  })

  test('a valve sits where it actually is; a stuck one shows the demand it ignores', () => {
    expect(itemLook(valve, sample({ 'v.effective': 0.35, 'v.command': 1 }))).toMatchObject({ state: { kind: 'position', fraction: 0.35 }, mismatch: 'CMD 100 %', words: '35 % open; commanded 100 % disagrees' })
    expect(itemLook(valve, sample({ 'v.effective': 1, 'v.command': 1 }))).toMatchObject({ mismatch: null, words: 'open' })
    // An out-of-range reading is unknown, never a position.
    expect(itemLook(valve, sample({ 'v.effective': 2 }, { 'v.effective': 'outside-hard-range' })).state.kind).toBe('unknown')
  })

  test('a valve that isolates or relieves is commanded OPEN or SHUT at either end of its travel, as its position reads there', () => {
    // HMI review of run 26: MOV-8000A, the PORV block valve, read "100 %" in one place and "OPEN" in another.
    const block = item({ aspect: 'position', state: { path: 'b.effective' as never, reading: 'value' }, command: 'b.command' as never, travel: { onS: 10, offS: 10 }, twoState: true })
    expect(itemLook(block, sample({ 'b.effective': 0, 'b.command': 1 }))).toMatchObject({ mismatch: 'CMD OPEN', words: 'closed; commanded open disagrees' })
    expect(itemLook(block, sample({ 'b.effective': 1, 'b.command': 0 }))).toMatchObject({ mismatch: 'CMD SHUT', words: 'open; commanded shut disagrees' })
    // Between its ends it is commanded where it is told to stand, as any valve.
    expect(itemLook(block, sample({ 'b.effective': 1, 'b.command': 0.4 })).mismatch).toBe('CMD 40 %')
    // A control valve keeps its demand in percent at the end of its travel too.
    expect(itemLook(valve, sample({ 'v.effective': 0.35, 'v.command': 1 })).mismatch).toBe('CMD 100 %')
  })

  test('a valve whose position is not computed reads by what passes it, and is never judged not followed', () => {
    // The model declares no travel time for a state it does not solve (an accumulator's discharge isolation valve):
    // what passes it is what it shows, whatever it is commanded (I-2).
    expect(itemLook(porv, sample({ 'r.flow': 8.5, 'r.command': 0 }))).toEqual({
      state: { kind: 'passing', flow: 8.5 }, notMeasured: true, mismatch: null, words: 'position not measured; passing 8.5 kg/s',
    })
    expect(itemLook(porv, sample({ 'r.flow': 0.1, 'r.command': 0 }))).toMatchObject({ state: { kind: 'notPassing' }, mismatch: null })
    expect(itemLook(porv, sample({ 'r.flow': 0, 'r.command': 1 }))).toEqual({ state: { kind: 'notPassing', flow: 0 }, notMeasured: true, mismatch: null, words: 'position not measured; no flow' })
  })

  test('a command a person or an AI agent issued is judged not followed only after its travel time and margin (QA-6)', () => {
    const shut = [{ path: 'v.command', value: 0, elapsedMs: 100_000 }]
    // Shut 5 s ago and stroking: no CMD, the valve is where it is.
    expect(itemLook(valve, issued({ 'v.effective': 0.6, 'v.command': 0 }, shut, 105_000))).toMatchObject({ mismatch: null, words: '60 % open' })
    // 10 s stroke + 2.5 s margin: at 12 s still awaited, at 13 s not followed.
    expect(itemLook(valve, issued({ 'v.effective': 0.2, 'v.command': 0 }, shut, 112_000)).mismatch).toBeNull()
    expect(itemLook(valve, issued({ 'v.effective': 0.2, 'v.command': 0 }, shut, 113_000))).toMatchObject({ mismatch: 'CMD SHUT', words: '20 % open; commanded shut disagrees' })
    // A pump follows within the step: 2 s of margin, then not followed.
    const start = [{ path: 'p.running', value: true, elapsedMs: 50_000 }]
    expect(itemLook(pump, issued({ 'p.speedRpm': 0, 'p.running': true }, start, 52_000)).mismatch).toBeNull()
    expect(itemLook(pump, issued({ 'p.speedRpm': 0, 'p.running': true }, start, 52_001)).mismatch).toBe('CMD RUN')
    // A command the I&C or a scenario wrote since (the log's last write is not what it reads) is judged as it reads.
    expect(itemLook(valve, issued({ 'v.effective': 0.6, 'v.command': 1 }, shut, 101_000)).mismatch).toBe('CMD 100 %')
    // Each direction has its own travel: a breaker closes in 0 s and opens in 5 s.
    const breaker = item({ aspect: 'position', state: { path: 'b.closed' as never, reading: 'closedWhileTrue' }, command: 'b.close' as never, travel: { onS: 0, offS: 5 } })
    expect(itemLook(breaker, issued({ 'b.closed': true, 'b.close': false }, [{ path: 'b.close', value: false, elapsedMs: 0 }], 6_000)).mismatch).toBeNull()
    expect(itemLook(breaker, issued({ 'b.closed': false, 'b.close': true }, [{ path: 'b.close', value: true, elapsedMs: 0 }], 2_500)).mismatch).toBe('CMD CLOSE')
    // Where the model declares no travel time, the state is awaited and never judged not followed.
    const undeclared = item({ aspect: 'running', state: { path: 'u.speedRpm' as never, reading: 'aboveZero' }, command: 'u.running' as never })
    expect(itemLook(undeclared, sample({ 'u.speedRpm': 0, 'u.running': true })).mismatch).toBeNull()
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
    const second = item({ aspect: 'running', state: { path: 'q.speedRpm' as never, reading: 'aboveZero' }, command: 'q.running' as never, travel: { onS: 0, offS: 0 } })
    const rows = itemRows(pump, { element: 'device', icon: 'pump', aspect: 'running' }, { marker: false, members: [pump, second], commands: 'stacked', offSpan: 'end' })
    expect(itemTreatment(drawnLook(pump, rows, sample({ 'p.speedRpm': 1200, 'p.running': true, 'q.speedRpm': 0, 'q.running': true })), false)).toBe('abnormal')
    expect(itemTreatment(drawnLook(pump, rows, sample({ 'p.speedRpm': 1200, 'p.running': true, 'q.speedRpm': 0, 'q.running': false })), false)).toBe('normal')
  })

  test('pipes draw direction only where the model solves it', () => {
    const solved: LinkFlowBinding = { flowPath: 'l.flow' as never, fidelity: 'solved', noFlowBelow: 2 }
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

  test('a power line is live while its solved state reads energized; a stub of several lines while any of them is', () => {
    expect(powerLook(['l.energized'], sample({ 'l.energized': true }))).toBe('live')
    expect(powerLook(['l.energized'], sample({ 'l.energized': false }))).toBe('dead')
    expect(powerLook([null], sample({}))).toBe('unknown')
    // A bus fed from its diesel while its offsite feeder is open.
    expect(powerLook(['offsite.energized', 'diesel.energized'], sample({ 'offsite.energized': false, 'diesel.energized': true }))).toBe('live')
    expect(powerLook(['offsite.energized', 'diesel.energized'], sample({ 'offsite.energized': false }))).toBe('unknown')
    expect(powerLook(['offsite.energized', 'diesel.energized'], sample({ 'offsite.energized': false, 'diesel.energized': false }))).toBe('dead')
  })

  test('a flag that says the item stopped is quiet at power, says so once it has, and says a trip it does not follow', () => {
    // A core: rods on bottom in its declared words, and every trip's command to it (full rod insertion).
    const core: MimicItemBinding = {
      ...item(null),
      shutdown: [{ path: 'c.rodsOnBottom' as never, words: { on: 'Rods on bottom', off: 'Rods off bottom' }, demands: [{ path: 'c.rodInsertion' as never, value: 1 }] }],
    }
    const rows = itemRows(core, { element: 'tank', tank: 'pressurized', aspect: 'level' }, { marker: false, members: [], commands: 'stacked', offSpan: 'end' })
    expect(rows.map(row => row.kind === 'shutdown' ? [row.part, row.texts] : row.kind)).toEqual([['word', ['Rods on bottom', 'Rods off bottom', '?']], ['command', ['CMD trip']]])
    const read = (values: Record<string, number | boolean>) => {
      const index = sample(values)
      const look = drawnLook(core, rows, index)
      return { texts: rows.map(row => rowText(row, look, index, String)), words: look.words, treatment: itemTreatment(look, false, shutdownDemanded(rows, index)) }
    }
    // At power: rod control holds the bank part-way in; nothing to say.
    expect(read({ 'c.rodsOnBottom': false, 'c.rodInsertion': 0.15 })).toEqual({ texts: ['', ''], words: '', treatment: 'normal' })
    // Tripped, rods falling: the command stands unmet, and the item is outlined as not following it.
    expect(read({ 'c.rodsOnBottom': false, 'c.rodInsertion': 1 })).toEqual({ texts: ['Rods off bottom', 'CMD trip'], words: 'Rods off bottom; commanded to trip', treatment: 'abnormal' })
    expect(read({ 'c.rodsOnBottom': true, 'c.rodInsertion': 1 })).toEqual({ texts: ['Rods on bottom', ''], words: 'Rods on bottom', treatment: 'normal' })
    // Without a reading it says only that it does not know.
    expect(read({})).toEqual({ texts: ['?', ''], words: '', treatment: 'normal' })
  })

  test('an on/off state reads in the words its equipment declares, a key value of a device in the digits its instrument declares', () => {
    // A generator running on its output breaker, ON LINE and OFF LINE; its output over a declared 0-1300 MW.
    const generator: MimicItemBinding = {
      ...item({ aspect: 'running', state: { path: 'g.breaker' as never, reading: 'true' }, words: { on: 'ON LINE', off: 'OFF LINE' } }),
      values: [{ path: 'g.mw' as never, unit: 'MW', span: { min: 0, max: 1300 }, range: { min: 0, max: 1300 } }, { path: 'g.unranged' as never, unit: 'MW' }],
    }
    const rows = itemRows(generator, { element: 'device', icon: 'generator', aspect: 'running' }, { marker: false, members: [], commands: 'stacked', offSpan: 'end' })
    expect(rows).toEqual([
      { kind: 'state', texts: ['ON LINE', 'OFF LINE', '?'], words: { on: 'ON LINE', off: 'OFF LINE' }, required: true },
      // A value its instrument declares no range for has no row: its width could not be reserved.
      { kind: 'value', path: 'g.mw', unit: 'MW', required: false, span: { min: 0, max: 1300 }, digits: 4 },
    ])
    const at = (values: Record<string, number | boolean>) => rows.map(row => rowText(row, itemLook(generator, sample(values)), sample(values), (value, unit) => `${value} ${unit}`))
    expect(at({ 'g.breaker': true, 'g.mw': 1162 })).toEqual(['ON LINE', '1162 MW'])
    expect(itemLook(generator, sample({ 'g.breaker': false })).words).toBe('OFF LINE')
    expect(at({ 'g.breaker': false })).toEqual(['OFF LINE', '—'])
    // Without declared words, the aspect's own.
    expect(itemRows({ ...generator, state: { ...generator.state!, words: undefined } as never }, { element: 'device', icon: 'generator', aspect: 'running' }, { marker: false, members: [], commands: 'stacked', offSpan: 'end' })[0]).toEqual({ kind: 'state', texts: ['RUN', 'STOP', '?'], required: true })
  })

  test('a quantity its instruments read in turn reads on the widest whose flag holds, over decades in powers of ten', () => {
    // A core's flux: source range counts until P-6, intermediate range current above it, power range above P-10.
    const flux: MimicRangeBinding = {
      steps: [
        { path: 'c.sr' as never, unit: 'cps', span: { min: 0, max: 1e6 }, meaningful: 'c.srHv' as never, widerWhile: 'c.p6' as never },
        { path: 'c.ir' as never, unit: 'amps', span: { min: 1e-11, max: 1e-3 }, widerWhile: 'c.p10' as never },
        { path: 'c.pr' as never, unit: 'percent', letters: 'PWR', span: { min: 0, max: 120 } },
      ],
    }
    const at = (values: Record<string, number | boolean>) => rangeText(flux, sample(values))
    expect(at({ 'c.p6': true, 'c.p10': true, 'c.pr': 99.97, 'c.ir': 2.2e-4 })).toBe('PWR 100.0 %')
    expect(at({ 'c.p6': true, 'c.p10': false, 'c.pr': 2, 'c.ir': 6.9e-7 })).toBe('6.9×10⁻⁷ A')
    expect(at({ 'c.p6': false, 'c.p10': false, 'c.srHv': true, 'c.sr': 24_000, 'c.ir': 1e-10 })).toBe('24000 cps')
    // The source range counts nothing while its high voltage is off; a reading off its span says only where it is.
    expect(at({ 'c.p6': false, 'c.p10': false, 'c.srHv': false, 'c.sr': 0 })).toBe('—')
    expect(at({ 'c.p6': true, 'c.p10': false, 'c.ir': 1e-12 })).toBe('<1.0×10⁻¹¹ A')
    // A switching flag not known says so, never a guess at the instrument.
    expect(at({ 'c.p6': true, 'c.ir': 6.9e-7 })).toBe('?')
    // Its row reserves room for the widest it can write, which on a vessel stays inside a hub's column (94 px at 12 px).
    const rows = itemRows({ ...item(null), ranges: [flux] }, { element: 'tank', tank: 'pressurized', aspect: 'level' }, { marker: false, members: [], commands: 'stacked', offSpan: 'end' })
    const range = rows[0]!
    expect(range.kind).toBe('range')
    if (range.kind !== 'range') return
    for (const text of ['PWR 100.0 %', '6.9×10⁻⁷ A', '24000 cps', '<1.0×10⁻¹¹ A', '>1000000 cps']) expect(Math.max(...range.texts.map(candidate => textWidth('tag', candidate)))).toBeGreaterThanOrEqual(textWidth('tag', text))
    expect(Math.max(...range.texts.map(candidate => textWidth('tag', candidate)))).toBeLessThanOrEqual(94)
  })
})
