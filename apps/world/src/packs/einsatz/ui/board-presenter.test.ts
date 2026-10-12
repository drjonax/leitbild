import { describe, expect, test } from 'bun:test'
import type { ContactRow, ContactSide, UnitRow, WorkRow } from '../board/types.ts'
import { createBoardController } from '../board/controller.ts'
import { boardWords } from '../board/text.ts'
import type { EinsatzConfig } from '../config-schema.ts'
import { civilConfig, civilKinds, civilWith, createWall, openScreen, pastGuardMs, runFor, taskAt, unitAt } from '../fixtures/board-harness.ts'
import { openRun, type OpenRun } from '../fixtures/run-harness.ts'
import { wordFor } from '../lexicon.ts'
import { openModeViewer } from '../picture.ts'
import { boardIconIds, createBoardIcons, svgImageSource } from './board-icons.ts'
import { contactFacts, contactIconTone, contactsSummary, logTime, stripHeading, unitFacts, unitIconTone, workFacts } from './board-presenter.ts'

/**
 * What the Board panel arranges beyond the controller's view: each row's
 * facts on one line, in the view's own words and in order, with numbers
 * marked for tabular digits; badge tones; log times; and the catalogue
 * artwork it asks for, each icon once.
 */

const unitRow = (changes: Partial<UnitRow> = {}): UnitRow => ({
  id: 'u1', label: 'U1', typeLabel: 'Carrier', icon: 'container', recallLabel: 'Recall', holdLabel: 'Hold', moveLabel: 'Move', phaseText: 'en route', phaseAgeText: '1:05',
  taskText: null, etaText: null, loadText: null, properties: [], propertiesText: null, integrityText: null,
  roeText: null, targetText: null, postureText: null, alerts: [], free: true, destroyed: false, selected: false, moveArmed: false,
  chain: [], pausedText: null, canAdd: true, adding: false,
  ...changes,
})
const contactRow = (changes: Partial<ContactRow> = {}): ContactRow => ({
  id: 'track:a:1', label: 'T-1', tierText: 'Contact', typeLabel: null, icon: 'circle-question-mark', ageText: '0:12',
  distanceText: '1.4 km', fixText: null, engagedText: null, destroyed: false,
  ...changes,
})
const workRow = (changes: Partial<WorkRow> = {}): WorkRow => ({
  id: 't1', label: 'T1', noun: 'Job', icon: 'package', code: 'C1', needText: null, served: false, ageText: '0:42',
  coverageText: '', etaText: null, nextText: null, statusText: null, alerts: [], closeLabel: 'Close', fresh: false, selected: false,
  ...changes,
})

describe('Board presenter', () => {
  test('a unit\'s facts read task, ETA, load, board properties, integrity, rules of engagement, target and posture, in that order, numbers marked', () => {
    expect(unitFacts(unitRow())).toEqual([])
    expect(unitFacts(unitRow({
      taskText: 'T1', etaText: 'ETA 3:10', loadText: '1 item', properties: [{ label: 'Payload', value: '300 kg' }], integrityText: 'damaged',
      roeText: 'weapons free', targetText: '→ T-7', postureText: 'Halting 0:12',
    }))).toEqual([
      { text: '→ T1', numeric: false },
      { text: 'ETA 3:10', numeric: true },
      { text: '1 item', numeric: false },
      { text: 'Payload 300 kg', numeric: true },
      { text: 'damaged', numeric: false },
      { text: 'weapons free', numeric: false },
      { text: '→ T-7', numeric: false },
      { text: 'Halting 0:12', numeric: true },
    ])
  })

  test('a unit holding a job chain shows its task in the chain, not twice, and says when it is paused', () => {
    const chain = [{ stepId: 'step-1', text: 'T1', active: true, removable: true }, { stepId: 'step-2', text: 'next: deliver to S1', active: false, removable: false }]
    expect(unitFacts(unitRow({ taskText: 'T1', chain, pausedText: 'paused' })).map(entry => entry.text)).toEqual(['paused'])
  })

  test('a work row\'s second line is its noun and coverage; a contact\'s facts say what it is, how far and old, and why it cannot be fired on', () => {
    expect(workFacts(workRow()).map(fact => fact.text)).toEqual(['Job'])
    expect(workFacts(workRow({ coverageText: '1 en route · needs 1 more' })).map(fact => fact.text)).toEqual(['Job', '1 en route · needs 1 more'])
    expect(contactFacts(contactRow({ fixText: 'No fire-control fix: contact report only' }))).toEqual([
      { text: 'Contact', numeric: false },
      { text: '1.4 km', numeric: true },
      { text: '0:12', numeric: true },
      { text: 'No fire-control fix: contact report only', numeric: false },
    ])
    expect(contactFacts(contactRow({ tierText: 'Identified', typeLabel: 'Gun', distanceText: null, engagedText: 'engaged by 2' })).map(fact => fact.text)).toEqual(['Identified · Gun', '0:12', 'engaged by 2'])
  })

  test('badges: a free unit shows it, a destroyed one is muted; a contact is neutral, an identified track is marked, a destroyed one muted', () => {
    expect([unitIconTone(unitRow()), unitIconTone(unitRow({ free: false })), unitIconTone(unitRow({ free: false, destroyed: true }))]).toEqual(['free', 'unit', 'muted'])
    expect([contactIconTone(contactRow()), contactIconTone(contactRow({ typeLabel: 'Gun' })), contactIconTone(contactRow({ typeLabel: 'Gun', destroyed: true }))]).toEqual(['contact', 'identified', 'muted'])
  })

  test('the strip carries the heading of the list the arrangement leads with', () => {
    const headings = { workList: 'Calls', unitBoard: 'Units', alerts: boardWords.alerts, log: boardWords.log }
    expect(stripHeading({ headings, arrangement: { lead: 'work-list', workList: true, unitBoard: true, contacts: false } })).toBe('Calls')
    expect(stripHeading({ headings, arrangement: { lead: 'map', workList: false, unitBoard: true, contacts: true } })).toBe('Units')
  })

  test('a log entry carries its Run time as the World clock shows it, in UTC', () => {
    expect(logTime({ atMs: Date.parse('2026-10-12T14:32:05.400Z'), recordId: 't1', text: 'T1: new' })).toBe('14:32:05')
    expect(() => logTime({ atMs: Number.NaN, recordId: 't1', text: 'T1: new' })).toThrow('A Board log entry holds no time')
  })
})

describe('Board icons', () => {
  test('asks for each icon once, reports the ones that did not load with the cause, and draws artwork only as an image', async () => {
    const asked: Array<ReadonlyArray<string>> = []
    let changes = 0
    let answer: (loaded: ReadonlyMap<string, string>) => void = () => undefined
    let fail: (error: Error) => void = () => undefined
    const icons = createBoardIcons({
      load: async ids => {
        asked.push(ids)
        return await new Promise<ReadonlyMap<string, string>>((resolve, reject) => { answer = resolve; fail = reject })
      },
      changed: () => { changes += 1 },
    })
    icons.request(['container', 'package', 'container'])
    icons.request(['package'])
    expect(asked).toEqual([['container', 'package']])
    answer(new Map([['container', '<svg>container</svg>']]))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect([icons.svg('container'), icons.svg('package'), changes]).toEqual(['<svg>container</svg>', undefined, 1])
    expect(icons.missing()).toBe('No map artwork for icon: package')
    icons.request(['container', 'package', 'warehouse'])
    expect(asked).toEqual([['container', 'package'], ['warehouse']])
    fail(new Error('Capability query failed: 503'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(icons.missing()).toBe('No map artwork for icon: package, warehouse (Capability query failed: 503)')
    expect(svgImageSource('<svg stroke="white"/>')).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%20stroke%3D%22white%22%2F%3E')
  })

  test('a view asks for its work rows\', unit rows\' and contacts\' icons', () => {
    const board = createBoardController({ config: civilConfig, viewer: openModeViewer, declaredRoles: [], sides: [] })
    const view = board.view()
    expect(boardIconIds(view)).toEqual([])
    const side = (label: string | null, engageable: ReadonlyArray<ContactRow>, other: ReadonlyArray<ContactRow>): ContactSide => ({
      label,
      engageable: { heading: 'Engageable', rows: engageable, empty: null },
      other: { heading: 'Other', rows: other, empty: null },
    })
    const withRows = {
      ...view,
      workList: { rows: [workRow({ icon: 'package' })], empty: null },
      unitBoard: { rows: [unitRow({ icon: 'container' }), unitRow({ id: 'u2', icon: 'container' })], empty: null, sitesHeading: 'Sites', sites: [{ id: 's1', label: 'S1', typeLabel: 'Depot', icon: 'warehouse' }] },
      contacts: { heading: 'Tracks', sides: [side('A', [contactRow({ icon: 'shield' })], [contactRow({ id: 'track:a:2' })]), side('B', [], [contactRow({ id: 'track:b:1', icon: 'flag' })])] },
    }
    expect(boardIconIds(withRows)).toEqual(['package', 'container', 'warehouse', 'shield', 'circle-question-mark', 'flag'])
  })

  test('folded Contacts read as one line of counts, under each side\'s label on a screen holding several sides', () => {
    const side = (label: string | null, engageable: ReadonlyArray<ContactRow>, other: ReadonlyArray<ContactRow>): ContactSide => ({
      label,
      engageable: { heading: 'Engageable', rows: engageable, empty: engageable.length === 0 ? 'None' : null },
      other: { heading: 'Other', rows: other, empty: other.length === 0 ? 'None' : null },
    })
    const quiet = { heading: 'Contacts', sides: [side(null, [], [contactRow({ id: 'track:a:1' }), contactRow({ id: 'track:a:2' })])] }
    expect(contactsSummary(quiet)).toBe('Engageable 0 · Other 2')
    // Several sides' tracks are counted under each side's label.
    expect(contactsSummary({ ...quiet, sides: [side('Blue', [], []), side('Red', [], [contactRow({ id: 'track:b:1' })])] })).toBe('Blue · Engageable 0 · Other 0 · Red · Engageable 0 · Other 1')
  })
})

/**
 * Every word the Board panel renders is a view field: verbs, list words and
 * what an empty list says come from the configuration's lexicon, verbatim,
 * never lower-cased; the few mechanism words come from `boardWords`.
 */
describe('Board words', () => {
  const kinds = civilKinds(civilConfig)
  const { carrier } = kinds.types
  const [top] = kinds.classes as [string]
  const at = (eastKm: number): [number, number] => [11.38 + eastKm / 57.12, 59.12]
  const worded: EinsatzConfig = {
    ...civilConfig,
    lexicon: { ...civilConfig.lexicon, unitBoard: 'Einheiten', noUnits: 'Keine Einheiten', recall: 'Zurückrufen', move: 'Verlegen', close: 'Abschließen' },
  }
  const withScene = async (items: ReadonlyArray<Record<string, unknown>>, body: (run: OpenRun) => Promise<void>): Promise<void> => {
    const run = await openRun({ definition: civilWith(items) })
    try { await body(run) } finally { await run.close() }
  }

  test('a unit\'s verbs, a call\'s close verb and remainder, and the unit\'s ETA are the configuration\'s words', async () => {
    // One carrier for a task with two loads: the proposal leaves one behind.
    await withScene([unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(3), { [top]: 2 })], async run => {
      const wall = createWall()
      const screen = await openScreen(run, wall, { config: worded })
      const hold = wordFor(worded.lexicon, 'hold', worded.unitTypes.find(type => type.id === carrier)!.lexicon)
      expect(screen.view().unitBoard).toMatchObject({ rows: [{ recallLabel: 'Zurückrufen', holdLabel: hold, moveLabel: 'Verlegen', etaText: null }], empty: null })
      expect(screen.view().workList.rows[0]?.closeLabel).toBe('Abschließen')
      await screen.click({ kind: 'row', list: 'work', id: 't1' })
      // Closing the call is its own control, apart from the commit button.
      expect([screen.view().commit.verbs, screen.view().commit.close]).toEqual([[], { label: 'Abschließen', id: 't1' }])
      const selected = screen.view().selected
      if (selected?.kind !== 'task') throw new Error('A click on the row selects the task')
      expect(selected.remainder.length).toBeGreaterThan(0)
      expect(selected.remainderText).toBe(`${boardWords.remainder} ${selected.remainder.join(', ')}`)
      expect(screen.view().headings).toEqual({ workList: wordFor(worded.lexicon, 'workList'), unitBoard: 'Einheiten', alerts: boardWords.alerts, log: boardWords.log })
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      expect(screen.view().commit).toMatchObject({ state: 'asset', verbs: [{ verb: 'hold', label: hold, id: 'u1' }, { verb: 'recall', label: 'Zurückrufen', id: 'u1' }] })

      await screen.key('n')
      wall.advance(pastGuardMs)
      await screen.key('Enter')
      await runFor(run, 5_000, [screen])
      expect(screen.view().unitBoard.rows[0]?.etaText).toMatch(new RegExp(`^${boardWords.eta} \\d+:\\d\\d$`))
    })
  })

  test('sound says how to enable it, then that it is on; an empty unit board says so in the configuration\'s words', async () => {
    await withScene([taskAt('t1', 'T1', kinds.templates.load, at(3), { [top]: 1 })], async run => {
      const screen = await openScreen(run, createWall(), { config: worded })
      expect(screen.view().sound).toEqual({ on: false, text: boardWords.soundOff })
      await screen.click({ kind: 'enable-sound' })
      expect(screen.view().sound).toEqual({ on: true, text: boardWords.soundOn })

      expect(screen.view().unitBoard).toEqual({ rows: [], empty: 'Keine Einheiten', sitesHeading: wordFor(worded.lexicon, 'sites'), sites: [] })
      // Stepping through an empty unit board says so, in the configuration's words.
      await screen.key(']')
      await screen.key('ArrowDown')
      expect(screen.view().feedback).toEqual({ text: 'Keine Einheiten', tone: 'info' })
    })
  })
})
