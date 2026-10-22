import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AlertState } from '../src/core/model/alerts.ts'
import type { ObjectId } from '../src/core/model/ids.ts'
import type { Observable, Observation } from '../src/core/observation/model.ts'
import type { AlertRow } from '../src/features/displays/alerts/rows.ts'
import { alertDetail, alertIcon, sectionLines, UNACK_WORD, unacknowledged, wordsThatFit, worstChip } from '../src/ui/embed/vignette/alerts.ts'
import { provenanceMark, quantityText } from '../src/ui/embed/vignette/format.ts'
import type { VignetteValue } from '../src/features/displays/compose/model.ts'
import { activeState, limitBar, orderWord, readingLook, valueLook } from '../src/ui/embed/vignette/readout.ts'
import { appendPoint, limitLabelYs, sharedLimits, stepPath, stripDrawing, stripDomain, timeTicks } from '../src/ui/embed/vignette/trend.ts'
import { recordedHoldMs } from '../src/features/historian/policy.ts'

// The vignette renderer's presenters (architecture B1): the limit chip, the
// step-and-hold trace, the limits a strip shares, neutral values without an
// observation priority, and "priority not declared".

type Threshold = Observable['thresholds'][number]
const threshold = (id: string, direction: 'low' | 'high', order: number, value: number, extra: Partial<Threshold> = {}): Threshold =>
  ({ id, direction, order, value, effect: 'alarm', priority: 'warning', ...extra })

const level: VignetteValue = {
  ref: 'unit-1#level', label: 'Unit 1 · Vessel level', quantity: 'level', unit: '%', valueType: 'number',
  thresholds: [threshold('lo', 'low', 1, 30), threshold('lolo', 'low', 2, 20, { effect: 'trip', priority: 'alarm', consequence: 'unit trip' }), threshold('hi', 'high', 1, 80)],
  series: { seriesId: 'unit-1.level', intervalMs: 1_000 },
}
const at = '2026-10-21T10:00:00.000Z'
const observation = (ref: string, value: Observation['value'], extra: Partial<Observation> = {}): Observation =>
  ({ ref, at, clock: 'simulation', value, quality: 'good', priority: 'none', ...extra })

describe('readout', () => {
  test('a value past a limit carries its chip: order word, the limit at its decimals, the consequence; the colour is the observation\'s', () => {
    const look = valueLook(level, [observation(level.ref, 18.04, { priority: 'alarm', past: 'lolo' })], level.ref)
    expect(look.text).toBe('18.0')
    expect(look.unit).toBe('%')
    expect(look.tone).toBe('alarm')
    expect(look.chip).toEqual({ word: 'LO-LO', text: 'LO-LO 20.0 · unit trip', tone: 'alarm' })
  })

  test('order words name the direction once per order', () => {
    expect([orderWord({ direction: 'low', order: 1 }), orderWord({ direction: 'low', order: 2 }), orderWord({ direction: 'high', order: 1 }), orderWord({ direction: 'high', order: 2 })])
      .toEqual(['LO', 'LO-LO', 'HI', 'HI-HI'])
  })

  test('the chip takes the observation\'s priority, not the threshold\'s: an advisory past a limit is drawn neutral', () => {
    const look = valueLook(level, [observation(level.ref, 85, { priority: 'none', past: 'hi' })], level.ref)
    expect(look.chip).toEqual({ word: 'HI', text: 'HI 80.0', tone: null })
    expect(look.tone).toBeNull()
  })

  test('neutral telemetry: a value without an observation priority takes no colour and no emphasis', () => {
    const look = readingLook('Vehicle · Fuel', 'number', undefined, { value: 4.2, unit: '%', thresholds: [] })
    expect(look).toMatchObject({ kind: 'number', text: '4.2', tone: null, emphasis: false, chip: null, bar: null })
  })

  test('notice is bold without a hue; a bad reading is "?", one that does not apply "—"', () => {
    expect(valueLook(level, [observation(level.ref, 50, { priority: 'notice' })], level.ref)).toMatchObject({ tone: null, emphasis: true })
    expect(valueLook(level, [observation(level.ref, 50, { quality: 'bad' })], level.ref)).toMatchObject({ text: '?', unit: '', bar: null })
    expect(valueLook(level, [observation(level.ref, null, { quality: 'not-applicable' })], level.ref).text).toBe('—')
    // Outside its declared validity a reading shows neither its value nor its unit, and draws no bar.
    const invalid = valueLook(level, [observation(level.ref, 50, { quality: 'not-applicable' })], level.ref)
    expect([invalid.text, invalid.unit, invalid.value, invalid.bar]).toEqual(['—', '', null, null])
    expect(valueLook(level, [], level.ref).text).toBe('?')
  })

  test('a countdown names the effect of the limit it runs to', () => {
    const look = valueLook(level, [observation(level.ref, 24, { priority: 'warning', timeToAct: { threshold: 'lolo', seconds: 240 } })], level.ref)
    expect(look.note).toBe('trip in 4 min')
  })

  test('the limit bar (obc-bar-horizontal) spans the limits, padded, reaches the value beyond them, and shows each limit as an advice zone, hinted until passed', () => {
    expect(limitBar(50, level.thresholds, 'lolo')).toEqual({
      min: 11, max: 89, value: 50,
      advices: [{ min: 11, max: 30, type: 'caution', hinted: true }, { min: 11, max: 20, type: 'caution', hinted: false }, { min: 80, max: 89, type: 'caution', hinted: true }],
    })
    const below = limitBar(0, level.thresholds)!
    expect([below.min, below.value]).toEqual([-12, 0])
    expect(limitBar(5, [])).toBeNull()
  })

  test('the readout block gets the number and its decimals, or nothing and the word it shows instead', () => {
    expect(valueLook(level, [observation(level.ref, 18.04)], level.ref)).toMatchObject({ value: 18, decimals: 1, text: '18.0' })
    expect(readingLook('Roll', 'number', undefined, { value: -0.3, unit: 'deg', thresholds: [] })).toMatchObject({ value: 0, text: '0' })
    // A count reads whole, as the card writes it.
    expect(readingLook('Energised islands', 'number', undefined, { value: 1, unit: '1', quantity: 'count', thresholds: [] })).toMatchObject({ text: '1', decimals: 0 })
    expect(valueLook(level, [observation(level.ref, 50, { quality: 'bad' })], level.ref)).toMatchObject({ value: null, text: '?' })
    // A reading over decades is shown as written (the block's text value), never as NaN, which the block draws as "—".
    const current = readingLook('Intermediate range current', 'number', undefined, { value: 4.4e-8, unit: 'A', thresholds: [] })
    expect(current).toMatchObject({ kind: 'number', text: '4.4×10⁻⁸', value: '4.4×10⁻⁸', unit: 'A' })
    expect(readingLook('Leak rate', 'number', undefined, { value: 2.3e-12, unit: 'kg/s', thresholds: [] }).value).toBe('2.3×10⁻¹²')
    expect(readingLook('Leak rate', 'number', undefined, { value: 0, unit: 'kg/s', thresholds: [] }).value).toBe(0)
  })

  test('states: a word from the declaration, active only where declared so or true (Q8), "?" while unknown, "since" its last change', () => {
    const states = [{ value: 'open', label: 'open' }, { value: 'closed', label: 'closed' }]
    expect(readingLook('Breaker', 'enum', states, { value: 'closed', unit: '', thresholds: [], since: { at, clock: 'simulation' } })).toMatchObject({ kind: 'state', text: 'closed', fill: 'hollow', note: 'since 10:00:00' })
    const declared = [{ value: 'open', label: 'open' }, { value: 'closed', label: 'closed', active: true as const }]
    expect(readingLook('Breaker', 'enum', declared, { value: 'closed', unit: '', thresholds: [] }).fill).toBe('filled')
    expect([activeState('closed', declared), activeState('open', declared), activeState('closed', states), activeState(false, undefined)]).toEqual([true, false, null, false])
    expect(readingLook('Bus · Energised', 'boolean', undefined, { value: true, unit: '', thresholds: [] })).toMatchObject({ text: 'yes', fill: 'filled' })
    expect(readingLook('Bus · Energised', 'boolean', undefined, { value: null, unit: '', thresholds: [], quality: 'bad' })).toMatchObject({ text: '?', fill: 'unknown' })
  })

  test('numbers read as the card writes them', () => {
    expect([quantityText(287.44, 'degC'), quantityText(-0.01, '%'), quantityText(3, '1'), quantityText(1234.5, 'MW')]).toEqual(['287.4 °C', '0.0 %', '3.00', '1235 MW'])
  })
})

describe('trend strip', () => {
  const window = { start: 0, end: 10_000 }
  const x = (t: number): number => t / 100
  const y = (v: number): number => 100 - v

  test('step-and-hold: each value holds until the next sample, and the trace breaks where the record is silent past the hold gap', () => {
    expect(stepPath([{ t: 0, v: 10 }, { t: 2_000, v: 20 }], x, y, window, 3_000)).toBe('M0.0 90.0 L20.0 90.0 L20.0 80.0 L50.0 80.0')
    expect(stepPath([{ t: 0, v: 10 }, { t: 6_000, v: 20 }], x, y, window, 3_000)).toBe('M0.0 90.0 L30.0 90.0 M60.0 80.0 L90.0 80.0')
  })

  test('the Historian\'s hold, served with the record: a steady value it stores 30 to 88 s apart draws as one piece over ten minutes; a silence past the hold breaks it', () => {
    const now = 600_000
    const drawn = (points: ReadonlyArray<{ t: number; v: number }>) => stripDrawing({ pens: [level], series: new Map([[level.ref, { holdMs: recordedHoldMs, points }]]), observations: [], now, horizonMs: 600_000, width: 600, height: 72 })!
    const pieces = (path: string): number => path.match(/M/g)?.length ?? 0
    // The heartbeat's stored samples of a steady value, with the longest gap measured on Halden (88 s), and the live point now.
    const steady = [0, 30_000, 118_000, 150_000, 210_000, 298_000, 330_000, 390_000, 450_000, 538_000, 570_000, 600_000].map(t => ({ t, v: 50 }))
    expect(pieces(drawn(steady).pens[0]!.path)).toBe(1)
    expect(drawn(steady).unrecorded).toBeNull()
    // Nothing stored for 150 s (the Run was not recording): the trace holds 90 s, then breaks until the next sample.
    const gap = [...steady.filter(point => point.t <= 330_000), ...steady.filter(point => point.t >= 480_000)]
    expect(pieces(drawn(gap).pens[0]!.path)).toBe(2)
    expect(drawn(gap).pens[0]!.path).toContain('L420.0')
    // The guess this replaces, three recording intervals of 5 s, broke the same steady record into pieces.
    expect(pieces(stepPath(steady, t => t / 1_000, () => 0, { start: 0, end: now }, 15_000))).toBeGreaterThan(2)
  })

  test('the time before the record starts is hatched; a value held into the window\'s start leaves nothing hatched', () => {
    const drawn = (points: ReadonlyArray<{ t: number; v: number }>) => stripDrawing({ pens: [level], series: new Map([[level.ref, { holdMs: recordedHoldMs, points }]]), observations: [], now: 600_000, horizonMs: 600_000, width: 600, height: 72 })!
    // A Run that started 90 s ago: hatched up to its first sample, and the trace starts there.
    const young = drawn([{ t: 510_000, v: 50 }, { t: 540_000, v: 50 }, { t: 600_000, v: 50 }])
    expect(young.unrecorded).toEqual({ width: 510 })
    expect(young.pens[0]!.path.startsWith('M510.0')).toBe(true)
    // Its sample 40 s before the window holds into its start: nothing to hatch.
    expect(drawn([{ t: -40_000, v: 50 }, { t: 30_000, v: 50 }]).unrecorded).toBeNull()
    // One 100 s before holds only 90: what lies between is not recorded.
    expect(drawn([{ t: -100_000, v: 50 }, { t: 100_000, v: 50 }]).unrecorded).toEqual({ width: 100 })
  })

  test('a live point keeps the window and the one point before it', () => {
    expect(appendPoint([{ t: 0, v: 1 }, { t: 5, v: 2 }, { t: 9, v: 3 }], { t: 12, v: 4 }, 7)).toEqual([{ t: 5, v: 2 }, { t: 9, v: 3 }, { t: 12, v: 4 }])
  })

  test('shared limits: a strip draws a limit only where every pen declares it under one id at one value', () => {
    const other = { ...level, ref: 'unit-1#level-b', thresholds: [threshold('lo', 'low', 1, 30), threshold('lolo', 'low', 2, 25), threshold('hi', 'high', 1, 80)] }
    expect(sharedLimits([level, other]).map(limit => limit.id)).toEqual(['lo', 'hi'])
    expect(sharedLimits([level]).map(limit => limit.id)).toEqual(['lo', 'lolo', 'hi'])
    expect(sharedLimits([level, { ...level, thresholds: [] }])).toEqual([])
  })

  test('the scale widens a steady value and reaches limits within reach only', () => {
    const steady = stripDomain({ min: 50, max: 50 }, [], 1)
    expect(steady.max - steady.min).toBeGreaterThan(2)
    const reached = stripDomain({ min: 40, max: 60 }, [30, 1_000], 1)
    expect(reached.min).toBeLessThan(30)
    expect(reached.max).toBeLessThan(100)
  })

  test('the drawing names the limit nearest each edge beyond its scale, and colours a pen only by its observation', () => {
    const pens = [level, { ...level, ref: 'unit-1#level-b', thresholds: level.thresholds.map(limit => (limit.id === 'hi' ? { ...limit, value: 80 } : limit)) }]
    const drawn = (values: ReadonlyArray<number>) => stripDrawing({
      pens, series: new Map([[level.ref, { holdMs: 90_000, points: values.map((v, index) => ({ t: index * 1_000, v })) }], ['unit-1#level-b', { holdMs: 90_000, points: [{ t: 0, v: values[0]! }] }]]),
      observations: [observation('unit-1#level-b', values[0]!, { priority: 'caution' })], now: 10_000, horizonMs: 10_000, width: 100, height: 72,
    })!
    const wide = drawn([35, 50])
    expect(wide.pens.map(pen => [pen.dash, pen.tone])).toEqual([['', null], ['6 3', 'caution']])
    expect([wide.limits.map(limit => limit.label), wide.beyond]).toEqual([['LO 30.0', 'LO-LO 20.0', 'HI 80.0'], []])
    const steady = drawn([49, 51])
    expect([steady.limits, steady.beyond.map(limit => `${limit.edge} ${limit.label}`)]).toEqual([[], ['top HI 80.0', 'bottom LO 30.0']])
    expect(stripDrawing({ pens: [level], series: new Map(), observations: [], now: 1, horizonMs: 1, width: 1, height: 1 })).toBeNull()
  })

  test('limit names never touch: above the line, below where the one above is near, else left to the line\'s title', () => {
    const free = { height: 72, top: false, bottom: false }
    expect(limitLabelYs([10, 15, 60], free)).toEqual([22, null, 58])
    expect(limitLabelYs([60, 30], free)).toEqual([58, 28])
    // Never past the strip's bottom, nor onto the names of limits beyond the scale at its edges.
    expect(limitLabelYs([69], free)).toEqual([67])
    expect(limitLabelYs([69], { ...free, bottom: true })).toEqual([null])
    expect(limitLabelYs([5, 30], { ...free, top: true })).toEqual([null, 28])
  })

  test('time ticks count back from now in round steps', () => {
    expect(timeTicks(600_000, 600_000).map(tick => tick.label)).toEqual(['−10 min', '−8 min', '−6 min', '−4 min', '−2 min', 'now'])
    expect(timeTicks(120_000, 120_000).map(tick => tick.label)).toEqual(['−2 min', '−90 s', '−1 min', '−30 s', 'now'])
  })
})

describe('alerts', () => {
  const row = (id: string, objectId: string, priority: AlertRow['priority'], extra: Partial<AlertState> = {}): AlertRow => ({
    key: `${objectId}|${id}`, objectId: objectId as ObjectId, objectLabel: objectId, packId: 'fixture', categoryId: 'thing', group: { objectId: objectId as ObjectId },
    alert: { id, kind: 'alarm', severity: priority === 'alarm' ? 'critical' : 'warning', message: id, raisedAt: at as never, acknowledged: false, ...(priority === null ? {} : { priority }), ...extra },
    priority, state: 'active-unack', raised: { at: at as never, clock: 'simulation' },
  })

  test('"priority not declared": an alert without a priority never ranks as one; alone it shows its severity word', () => {
    expect(worstChip([], [row('a', 'one', null)])).toEqual({ kind: 'undeclared', severity: 'warning' })
    expect(worstChip([{ priority: 'caution' }], [row('a', 'one', null)])).toEqual({ kind: 'priority', priority: 'caution' })
    expect(worstChip([{ priority: 'notice' }], [])).toBeNull()
  })

  test('each row takes OpenBridge\'s alert icon by its declared priority, drawn steady: acknowledged, or rectified once returned; notice and an undeclared priority read as words', () => {
    // Nothing in a vignette acknowledges (W2.7): an unacknowledged icon would flash for ever (UX audit H11).
    expect(alertIcon(row('a', 'one', 'emergency'))).toEqual({ type: 'level-critical', acknowledged: true, active: true })
    expect(alertIcon({ ...row('a', 'one', 'warning'), state: 'active-ack' })).toEqual({ type: 'warning', acknowledged: true, active: true })
    expect(alertIcon({ ...row('a', 'one', 'alarm'), state: 'returned-unack' })).toEqual({ type: 'alarm', acknowledged: true, active: false })
    expect(alertIcon(row('a', 'one', 'notice'))).toEqual({ word: 'Notice' })
    expect(alertIcon(row('a', 'one', null))).toEqual({ word: 'Warning · priority not declared' })
    expect(alertDetail({ ...row('a', 'one', 'caution', { standing: true, acknowledged: true, acknowledgedBy: 'ai' }), state: 'active-ack' })).toBe('standing · acknowledged by Assistant · 10:00:00 UTC')
  })

  test('the word UNACK carries what the steady icon does not: on each unacknowledged row and in the section\'s counts; standing alarms and advisories never count (R43)', () => {
    const rows = [
      row('a', 'one', 'alarm'), { ...row('r', 'one', 'warning'), state: 'returned-unack' as const }, { ...row('k', 'one', 'alarm', { acknowledged: true }), state: 'active-ack' as const },
      row('s', 'one', 'caution', { standing: true }), row('x', 'one', 'warning'),
    ]
    expect(rows.map(entry => [entry.alert.id, unacknowledged(entry), alertDetail(entry)])).toEqual([
      ['a', true, '10:00:00 UTC'], ['r', true, 'returned · 10:00:00 UTC'], ['k', false, 'acknowledged · 10:00:00 UTC'], ['s', false, 'standing · 10:00:00 UTC'], ['x', true, '10:00:00 UTC'],
    ])
    expect(UNACK_WORD).toBe('UNACK')
    expect(sectionLines(rows, { objectIds: ['one'] }, 5).unacknowledged).toEqual({ all: 3, more: 0 })
    expect(sectionLines(rows, { objectIds: ['one'] }, 3)).toMatchObject({ more: 3, unacknowledged: { all: 3, more: 1 } })
  })

  test('a row\'s message gives way by whole words before any ellipsis, a lone word too long cut last; what fits stays whole', () => {
    const within = (characters: number) => (shown: string): boolean => shown.length <= characters
    const message = 'Steam generator A low-low level'
    expect(wordsThatFit(message, within(40))).toBe(message)
    expect(wordsThatFit(message, within(18))).toBe('Steam generator A…')
    expect(wordsThatFit(message, within(17))).toBe('Steam generator…')
    // A comma before the cut is left out with the words after it.
    expect(wordsThatFit('Feedwater isolation on reactor trip, low Tavg', within(37))).toBe('Feedwater isolation on reactor trip…')
    expect(wordsThatFit('Feedwater isolation', within(5))).toBe('Feed…')
    expect(wordsThatFit('Feedwater', within(0))).toBe('…')
    // It tries whole words first, and cuts within the first word only after every whole-word start failed.
    const tried: string[] = []
    expect(wordsThatFit(message, shown => { tried.push(shown); return shown.length <= 4 })).toBe('Ste…')
    const wholeWords = (shown: string): boolean => shown === message || (message.startsWith(shown.slice(0, -1)) && message[shown.length - 1] === ' ')
    const inFirstWord = (shown: string): boolean => shown.length - 1 < 'Steam'.length
    expect(tried.filter(shown => !wholeWords(shown) && !inFirstWord(shown))).toEqual([])
    expect(tried.slice(tried.findIndex(inFirstWord)).filter(wholeWords)).toEqual([])
  })

  test('in an alert row only the message gives way: the icon, UNACK, a FIRST OUT mark, a heading, the state and the time never shrink', () => {
    const source = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/AlertsSection.svelte'), 'utf8')
    const rule = (selector: string): string => source.match(new RegExp(`\\n\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
    expect(rule('.message')).toContain('flex: 1 1 0;')
    expect(rule('.message')).toContain('min-width: 0;')
    expect(rule('.detail')).toContain('flex: none;')
    expect(rule('.icon')).toContain('flex: none;')
    expect(source).toMatch(/strong, \.mark, \.unack \{ flex: none; \}/)
    expect(source).toContain('use:fitted={line.row.alert.message}')
  })

  test('a section keeps the sample\'s order (the Run context\'s ranking), its objects only, within its room, the last line counting the rest', () => {
    const rows = [row('a', 'two', 'alarm'), row('w', 'one', 'warning'), row('c', 'one', 'caution'), row('x', 'three', 'alarm')]
    const own = sectionLines(rows, { objectIds: ['one', 'two'] }, 5)
    expect(own.lines.map(line => [line.row.alert.id, line.heading])).toEqual([['a', 'two'], ['w', 'one'], ['c', 'one']])
    const tight = sectionLines(rows, { objectIds: 'run' }, 2)
    expect([tight.lines.map(line => line.row.alert.id), tight.more]).toEqual([['a'], 3])
    expect(sectionLines([row('a', 'one', 'alarm', { firstOut: { group: 'g', rank: 1 } })], { objectIds: ['one'] }, 3).lines[0]).toMatchObject({ firstOut: true })
  })

  test('a section narrowed to elements or observables shows only the alerts on them', () => {
    const rows = [
      row('on-pump', 'one', 'warning', { subject: { element: 'pump-a' } }), row('on-level', 'one', 'alarm', { observable: 'one#level' }),
      row('elsewhere', 'one', 'caution', { subject: { element: 'pump-b' } }), row('other-object', 'two', 'alarm', { subject: { element: 'pump-a' } }),
    ]
    expect(sectionLines(rows, { objectIds: ['one'], elements: ['pump-a'] }, 5).lines.map(line => line.row.alert.id)).toEqual(['on-pump'])
    expect(sectionLines(rows, { objectIds: ['one'], refs: ['one#level'] }, 5).lines.map(line => line.row.alert.id)).toEqual(['on-level'])
    expect(sectionLines(rows, { objectIds: ['one'], elements: ['pump-a'], refs: ['one#level'] }, 5).lines.map(line => line.row.alert.id)).toEqual(['on-pump', 'on-level'])
  })
})

describe('footer', () => {
  test('every vignette says it is not an operating display, and whether World generated it from the model or the Assistant composed it', () => {
    expect(provenanceMark({})).toBe('Generated from the model · not an operating display')
    expect(provenanceMark({ by: 'assistant' })).toBe('AI-composed view · not an operating display')
    // Before its view is read, it does not yet say who made it.
    expect(provenanceMark(undefined)).toBe('not an operating display')
    // The frame every host shows (the window, a chat answer inline, a procedure tag's dialog) writes it in its footer.
    const frame = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/Vignette.svelte'), 'utf8')
    expect(frame.slice(frame.indexOf('<footer'), frame.indexOf('</footer>'))).toContain('{provenanceMark(view)}')
  })
})
