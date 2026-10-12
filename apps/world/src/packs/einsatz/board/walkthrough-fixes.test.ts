import { describe, expect, test } from 'bun:test'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { borderWith, civilConfig, civilKinds, civilWith, createWall, onObject, openScreen, pastGuardMs, pointAt, roleScreen, runFor, taskAt, unitAt } from '../fixtures/board-harness.ts'
import { blue, red } from '../fixtures/combat-harness.ts'
import border from '../fixtures/halden-border.scenario.json'
import { openRun, type OpenRun } from '../fixtures/run-harness.ts'
import { neutralLexicon, wordFor } from '../lexicon.ts'
import { boardWords } from './text.ts'

/**
 * What the tap-only walkthrough of the touch-first Board found, against the
 * real runtime on a running clock: closing a call is its own verb and asks
 * while the call is unserved; the sites a unit can go to are listed under
 * Assets; a new action clears the last one's words; a resumed chain is no
 * standing order; a release names its load once per noun; a call a unit
 * holds queued says only who comes next; a highlighted asset shows each
 * property once; a removed move reads as a move; an undo takes back only
 * the step the unit's last order created.
 */

const kinds = civilKinds(civilConfig)
const { carrier, pairServer, conditionedServer, site } = kinds.types
const [top, , low] = kinds.classes as [string, string, string]
const at = (eastKm: number, northKm = 0): [number, number] => [11.38 + eastKm / 57.12, 59.12 + northKm / 110.54]
const borderTypes: ReadonlyArray<{ readonly id: string; readonly components: Readonly<Record<string, unknown>> }> = border.packs[0]!.config.unitTypes
/** The border configuration's first unit type with exactly these components. */
const borderType = (...components: ReadonlyArray<string>): string => borderTypes.find(type => Object.keys(type.components).sort().join() === [...components].sort().join())!.id
/** What the civil configuration calls the units its two-unit template needs, counted more than one. */
const pairNeed = civilConfig.taskTemplates.find(template => template.id === kinds.templates.pair)!.requires[0]!.label!.other

const withScene = async (items: ReadonlyArray<Record<string, unknown>>, body: (run: OpenRun) => Promise<void>): Promise<void> => {
  const run = await openRun({ definition: civilWith(items) })
  try { await body(run) } finally { await run.close() }
}
const accepted = async (run: OpenRun, capabilityId: string, input: unknown): Promise<void> => {
  const result = await run.invoke(capabilityId, input)
  if (!result.ok) throw new Error(`${capabilityId} refused: ${result.reason}`)
}

describe('Fixes from the tap-only walkthrough', () => {
  test('"Close call" is the configuration\'s verb, apart from the commit button, and asks to confirm while the call is unserved, naming what it still needs; once served it closes at once', async () => {
    const items = [unitAt('p1', 'P1', pairServer, at(0)), unitAt('p2', 'P2', pairServer, at(0, 1)), taskAt('o1', 'O1', kinds.templates.pair, at(1)), taskAt('o2', 'O2', kinds.templates.pair, at(1, 1))]
    await withScene(items, async run => {
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'work', id: 'o1' })
      // No detail line stands above the row Close is pinned to (`ui/board-layout.test.ts`).
      expect([civilConfig.lexicon.close, screen.view().commit.close, screen.view().commit.verbs, screen.view().commit.detail]).toEqual(['Close call', { label: 'Close call', id: 'o1' }, [], null])
      await screen.click({ kind: 'verb', verb: 'close', id: 'o1' })
      expect(screen.view().commit).toMatchObject({ state: 'confirm', text: 'Close call O1', detail: `${boardWords.remainder} 2 more ${pairNeed}` })
      expect(screen.calls).toHaveLength(0)
      await screen.click({ kind: 'cancel' })
      await accepted(run, ids.send, { units: ['p1', 'p2'], to: { taskId: 'o2' } })
      await screen.sync()
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'row', list: 'work', id: 'o2' })
      await screen.click({ kind: 'verb', verb: 'close', id: 'o2' })
      expect(screen.calls.map(call => [call.capabilityId, call.input, call.result.ok])).toEqual([[ids.taskClose, { taskId: 'o2' }, true]])
    })
  })

  test('the sites a unit can go to are listed under Assets; a tap on one sends the highlighted asset there, and with none it says to tap one first', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), unitAt('h1', 'H1', site, at(2)), taskAt('t1', 'T1', kinds.templates.load, at(3), { [low]: 1 })], async run => {
      const screen = await openScreen(run, createWall())
      expect(screen.view().unitBoard.rows.map(row => row.id)).toEqual(['u1'])
      expect(screen.view().unitBoard.sites.map(entry => [entry.id, entry.label])).toEqual([['h1', 'H1']])
      expect(screen.view().unitBoard.sitesHeading).toBe(neutralLexicon.sites)
      await screen.click({ kind: 'site', id: 'h1' })
      expect([screen.view().feedback?.text, screen.calls]).toEqual([`Tap one of ${civilConfig.lexicon.unitBoard} first, then H1`, []])
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      await screen.click({ kind: 'site', id: 'h1' })
      expect(screen.calls.map(call => [call.input, call.result.ok])).toEqual([[{ units: ['u1'], to: { siteId: 'h1' } }, true]])
    })
  })

  test('Sites lists only places the screen\'s assets can be sent to: another side\'s post is left out, and an asset tapped onto it on the map is refused at once', async () => {
    const post = { id: 'post', label: 'Post', icon: 'binoculars', tags: ['post'], components: { sensor: { detectM: 3000, identifyM: 2000 } } }
    const definition = borderWith([
      unitAt('amb', 'AMB', borderType('carry', 'mobility', 'service'), at(0), { side: blue }),
      unitAt('post-blue', 'BLUE POST', 'post', at(1), { side: blue }),
      unitAt('post-red', 'RED POST', 'post', at(2), { side: red }),
      unitAt('kalnes', 'KALNES', borderType('receiving'), at(3)),
    ]) as { readonly packs: ReadonlyArray<{ readonly config: { readonly unitTypes: ReadonlyArray<unknown> } }> }
    const pack = definition.packs[0]!
    const run = await openRun({ definition: { ...definition, packs: [{ ...pack, config: { ...pack.config, unitTypes: [...pack.config.unitTypes, post] } }] } })
    try {
      // The Controller sees both sides' posts; its only asset is Blue's, so Red's post is no place it can send anything.
      const controller = border.roles.find(role => role.class === 'controller')!.id
      const screen = await openScreen(run, createWall(), { actor: roleScreen(run, controller) })
      expect(screen.view().unitBoard.rows.map(row => row.id)).toEqual(['amb'])
      expect(screen.view().unitBoard.sites.map(entry => entry.id)).toEqual(['kalnes', 'post-blue'])
      await screen.mapTap('amb')
      await screen.mapTap('post-red')
      expect([screen.view().feedback?.text, screen.view().selected, screen.calls]).toEqual(['AMB cannot use another side\'s RED POST', { kind: 'unit', id: 'amb' }, []])
    } finally {
      await run.close()
    }
  })

  test('the map brings into view only what the operator picks from the lists: the next call the Board selects itself after a commit moves no camera', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [top]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(2), { [low]: 1 })]
    await withScene(items, async run => {
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'work', id: 't1' })
      expect(screen.revealed()).toEqual(['t1'])
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'commit' })
      // Once the Run shows the send, the Board selects the next unserved call by itself.
      expect([screen.view().selected?.id, screen.mapSelection(), screen.revealed()]).toEqual(['t2', 't2', ['t1']])
      // An asset row, and the urgent key, are the operator's picks.
      await screen.click({ kind: 'row', list: 'units', id: 'u2' })
      await screen.key('n')
      expect(screen.revealed()).toEqual(['t1', 'u2', 't2'])
      // A tap on the map selects without moving the camera.
      await screen.mapTap('u2')
      expect([screen.view().selected, screen.revealed()]).toEqual([{ kind: 'unit', id: 'u2' }, ['t1', 'u2', 't2']])
    })
  })

  test('a new action clears the feedback line: a refusal does not stand under the next tap\'s "Move here"', async () => {
    await withScene([unitAt('p1', 'P1', pairServer, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(2), { [low]: 1 })], async run => {
      const screen = await openScreen(run, createWall())
      await screen.mapTap('p1')
      await screen.mapTap('t1')
      expect(screen.view().feedback?.text).toBe('P1 provides nothing T1 needs')
      await screen.groundTap(at(1, 1))
      expect([screen.view().feedback, screen.view().mapPrompt?.unitId]).toEqual([null, 'p1'])
    })
  })

  test('Stop, then Resume: the chain carries on as the next step, never as a standing order, and the asset is let go each time', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(20), { [low]: 1 })], async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
      const screen = await openScreen(run, createWall())
      await runFor(run, 120_000, [screen])
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      expect(screen.view().commit.verbs[0]).toEqual({ verb: 'hold', label: wordFor(civilConfig.lexicon, 'hold'), id: 'u1' })
      await screen.click({ kind: 'verb', verb: 'hold', id: 'u1' })
      expect(screen.view().selected).toBeNull()
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      await screen.click({ kind: 'verb', verb: 'resume', id: 'u1' })
      expect(screen.view().selected).toBeNull()
      await runFor(run, 2_000, [screen])
      expect(run.unit('u1').taskId).toBe('t1')
      const own = screen.view().log.filter(entry => entry.recordId === 'u1').map(entry => entry.text)
      expect(own).toContain('U1: sent to T1 · next step')
      expect(own.some(text => text.includes('standing order'))).toBe(false)
    })
  })

  test('the neutral word for the chain\'s halt is Stop, as A9 names it', () => {
    expect([neutralLexicon.hold, wordFor({}, 'hold'), neutralLexicon.close]).toEqual(['Stop', 'Stop', 'Close task'])
  })

  test('a release names the load waiting once per noun: two classes sharing a noun read "2 <noun> waiting", never "1 <noun>, 1 <noun>"', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(20), { [top]: 1, [low]: 1 })], async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
      await accepted(run, ids.recall, { unitId: 'u1', fromTaskId: 't1' })
      const noun = civilConfig.loadClasses[0]!.noun
      expect(civilConfig.loadClasses.every(entry => entry.noun.other === noun.other)).toBe(true)
      expect(run.task('t1').alerts.map(alert => alert.message)).toEqual([`U1 released from T1 · 2 ${noun.other} waiting`])
    })
  })

  test('a call a unit holds queued says who comes next, and no line beside it says that no unit can come', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(6), { [low]: 1 })], async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
      await accepted(run, ids.queue, { unitId: 'u1', to: { taskId: 't2' } })
      const screen = await openScreen(run, createWall())
      const row = screen.view().workList.rows.find(entry => entry.id === 't2')!
      expect([row.served, row.nextText, row.statusText]).toEqual([false, 'U1 next, 1 step ahead', null])
    })
  })

  test('a highlighted asset shows each property once: those on its detail line are not repeated', async () => {
    await withScene([unitAt('e1', 'E1', conditionedServer, at(0))], async run => {
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'units', id: 'e1' })
      const row = screen.view().unitBoard.rows[0]!
      expect([row.selected, row.properties.length, row.propertiesText]).toEqual([true, 1, null])
    })
  })

  test('a removed move reads as a move, and the × lets the asset go', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0))], async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { point: pointAt(at(3)) } })
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      await screen.click({ kind: 'remove-step', unitId: 'u1', stepId: 'step-1' })
      expect([screen.view().feedback?.text, screen.view().selected]).toEqual([`✓ ${boardWords.removeStep} move to ${boardWords.mapPoint} · U1`, null])
    })
  })

  test('an undo takes back only the step the unit\'s last order created; a queued step\'s undo logs it as undone', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(6), { [low]: 1 })], async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'verb', verb: 'add', id: 'u1' })
      await screen.mapTap('t2')
      expect((await run.refusal(ids.stepRemove, { unitId: 'u1', stepId: 'step-1', undo: true })).code).toBe('step_not_undoable')
      await screen.click({ kind: 'undo' })
      expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.stepRemove, input: { unitId: 'u1', stepId: 'step-2', undo: true }, result: { ok: true } })
      await screen.sync()
      expect(screen.view().log[0]?.text).toBe('U1: step removed: T2 (undo)')
      expect(run.unit('u1').orders.map(step => step.id)).toEqual(['step-1'])
      expect(screen.preview('u1', onObject('t2'))?.refused).toBe(false)
    })
  })
})
