import { describe, expect, test } from 'bun:test'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { borderWith, civilConfig, civilKinds, civilWith, createWall, identifiedTrack, onObject, openScreen, pastGuardMs, pointAt, roleScreen, runFor, taskAt, unitAt } from '../fixtures/board-harness.ts'
import { borderDefinitions, sensingCommandOf } from '../fixtures/border-harness.ts'
import { at as northEast, blue, red, types as combatTypes } from '../fixtures/combat-harness.ts'
import { openRun, type OpenRun } from '../fixtures/run-harness.ts'
import { wordFor } from '../lexicon.ts'
import { refusalCode } from '../refusal.ts'
import { boardWords } from './text.ts'

/**
 * Tap safety (A9: no accidental orders), against the real runtime on a
 * running clock: a call or a site in the lists takes the highlighted asset
 * only right after the asset's own tap, and a call row only when it has not
 * just moved under the finger; otherwise the tap selects the call and offers
 * the asset as a button of its own, or offers the site. A target the Board
 * can tell is refused is not sent or offered, and says why; a refusal the
 * engine gives highlights the asset again; a row tap during a confirmation
 * cancels it and then acts.
 */

const kinds = civilKinds(civilConfig)
const { carrier, pairServer, site } = kinds.types
const [top, , low] = kinds.classes as [string, string, string]
const at = (eastKm: number, northKm = 0): [number, number] => [11.38 + eastKm / 57.12, 59.12 + northKm / 110.54]

const withScene = async (items: ReadonlyArray<Record<string, unknown>>, body: (run: OpenRun) => Promise<void>): Promise<void> => {
  const run = await openRun({ definition: civilWith(items) })
  try { await body(run) } finally { await run.close() }
}
const accepted = async (run: OpenRun, capabilityId: string, input: unknown): Promise<void> => {
  const result = await run.invoke(capabilityId, input)
  if (!result.ok) throw new Error(`${capabilityId} refused: ${result.reason}`)
}

describe('Board tap safety', () => {
  test('a Calls row tapped right after the asset\'s own row takes the asset as the call on the map does; one that moved under the finger just before sends nothing, but selects the call and offers the asset beside its suggestion', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 1 })], async run => {
      const screen = await openScreen(run, createWall())
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'row', list: 'units', id: 'u2' })
      // A more urgent call arrives and sorts above T1: the row the finger aimed at moves down.
      await accepted(run, ids.taskCreate, { template: kinds.templates.load, label: 'T2', at: pointAt(at(0.5)), loads: { [top]: 1 } })
      await screen.sync()
      expect(screen.view().workList.rows.map(row => row.id)).toEqual(['task:1', 't1'])
      await screen.wait(120)
      await screen.click({ kind: 'row', list: 'work', id: 't1' })
      const selected = screen.view().selected
      expect([screen.calls.length, selected?.kind, selected?.id, screen.view().commit.offer, screen.view().feedback?.text]).toEqual([0, 'task', 't1', `${civilConfig.lexicon.send} U2 here`, 'Not sent: the list changed'])
      // The call's own suggestion stands beside the offer, each its own button.
      expect(screen.view().commit.button).toStartWith(`${civilConfig.lexicon.send} U1 → T1`)
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'offer' })
      expect(screen.calls.map(call => [call.input, call.result.ok])).toEqual([[{ units: ['u2'], to: { taskId: 't1' } }, true]])
      // Once the list stands still, the call row right after the asset's own row sends it: 2 taps, and the highlight lets go.
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      await screen.click({ kind: 'row', list: 'work', id: 'task:1' })
      expect([screen.calls.at(-1)!.input, screen.calls.at(-1)!.result.ok, screen.view().selected]).toEqual([{ units: ['u1'], to: { taskId: 'task:1' } }, true, null])
    })
  })

  test('an asset tapped onto a report, or onto a call it serves nothing of, is not sent, says why and stays highlighted; a call or a site tapped later in the lists only offers the lingering asset, and Cancel lets the offer go', async () => {
    const items = [
      unitAt('u1', 'U1', carrier, at(0)), unitAt('p1', 'P1', pairServer, at(0, 1)), unitAt('h1', 'H1', site, at(1, 1)),
      taskAt('r1', 'R1', kinds.templates.report, at(1)), taskAt('t1', 'T1', kinds.templates.load, at(2), { [low]: 1 }),
    ]
    await withScene(items, async run => {
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      await screen.click({ kind: 'row', list: 'work', id: 'r1' })
      expect([screen.view().feedback?.text, screen.view().selected]).toEqual(['R1 is a report: nothing to send', { kind: 'unit', id: 'u1' }])
      expect(screen.preview('u1', onObject('r1'))).toEqual({ text: 'R1 is a report: nothing to send', refused: true })
      // The highlight now lingers: a call tapped in the list is selected, and the asset only offered beside its suggestion.
      await screen.click({ kind: 'row', list: 'work', id: 't1' })
      expect([screen.view().selected?.id, screen.view().commit.offer, screen.calls.length]).toEqual(['t1', `${civilConfig.lexicon.send} U1 here`, 0])
      await screen.click({ kind: 'cancel' })
      expect([screen.view().commit.offer, screen.view().selected?.id, screen.calls.length]).toEqual([null, 't1', 0])
      // A site tapped under a lingering highlight is offered as the order it would send; the asset stays highlighted.
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      await screen.mapTap('r1')
      await screen.click({ kind: 'site', id: 'h1' })
      expect([screen.view().commit.state, screen.view().commit.offer, screen.view().selected, screen.calls.length]).toEqual(['asset', `${wordFor(civilConfig.lexicon, 'move')} U1 → H1`, { kind: 'unit', id: 'u1' }, 0])
      await screen.click({ kind: 'offer' })
      expect(screen.calls.map(call => [call.input, call.result.ok])).toEqual([[{ units: ['u1'], to: { siteId: 'h1' } }, true]])
      // P1 serves nothing T1 needs: refused right after its own tap, and a later tap on T1 selects it with no offer, saying why.
      await screen.click({ kind: 'row', list: 'units', id: 'p1' })
      await screen.click({ kind: 'row', list: 'work', id: 't1' })
      expect([screen.view().feedback?.text, screen.view().selected]).toEqual(['P1 provides nothing T1 needs', { kind: 'unit', id: 'p1' }])
      await screen.click({ kind: 'row', list: 'work', id: 't1' })
      expect([screen.view().feedback?.text, screen.view().selected?.id, screen.view().commit.offer]).toEqual(['P1 provides nothing T1 needs', 't1', null])
      await screen.click({ kind: 'row', list: 'units', id: 'p1' })
      await screen.mapTap('t1')
      expect([screen.view().feedback?.text, screen.view().selected, screen.mapSelection()]).toEqual(['P1 provides nothing T1 needs', { kind: 'unit', id: 'p1' }, 'p1'])
      expect(screen.calls).toHaveLength(1)
    })
  })

  test('when the engine refuses an asset sent by a tap, the asset is highlighted again for another target', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(-1), { [top]: 1 })]
    await withScene(items, async run => {
      const wall = createWall()
      const mine = await openScreen(run, wall)
      const other = await openScreen(run, wall)
      await mine.click({ kind: 'row', list: 'units', id: 'u1' })
      // Another screen takes U1 before this one's tap; this screen has not seen it yet.
      mine.freeze(true)
      await other.click({ kind: 'row', list: 'work', id: 't2' })
      await other.click({ kind: 'commit' })
      await mine.mapTap('t1')
      const refused = mine.calls.at(-1)!.result
      if (refused.ok) throw new Error('expected a refusal')
      expect(refusalCode(refused.reason)).toBe('unit_committed')
      expect([mine.view().feedback?.tone, mine.view().selected, mine.mapSelection()]).toEqual(['refused', { kind: 'unit', id: 'u1' }, 'u1'])
      // Highlighted again by the Board, not picked from a list: the camera stays.
      expect(mine.revealed()).toEqual(['u1'])
    })
  })

  test('the offer waits out the guard as the commit button does: an offer whose order changes under the finger is disabled and refused for 500 ms', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('r1', 'R1', kinds.templates.report, at(1)), taskAt('t1', 'T1', kinds.templates.load, at(2), { [top]: 1 }), taskAt('far', 'FAR', kinds.templates.load, at(30), { [low]: 1 })]
    await withScene(items, async run => {
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      // Refused on the map: the highlight lingers, so T1 in the list only offers U1.
      await screen.mapTap('r1')
      await screen.click({ kind: 'row', list: 'work', id: 't1' })
      expect(screen.view().commit.offer).toBe(`${civilConfig.lexicon.send} U1 here`)
      // Another dispatcher sends U1 elsewhere: under the finger the offer turns into a divert.
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 'far' } })
      await screen.sync()
      expect([screen.view().commit.offer, screen.view().commit.enabled]).toEqual(['Divert U1 here', false])
      await screen.click({ kind: 'offer' })
      expect([screen.calls.length, screen.view().feedback?.text]).toEqual([0, 'Not sent: the list changed · Confirm next: T1'])
      await screen.wait(pastGuardMs)
      expect(screen.view().commit.enabled).toBe(true)
      await screen.click({ kind: 'offer' })
      // U1 now holds a call: doing this now diverts it, so it asks first.
      expect([screen.view().commit.state, screen.calls.length]).toEqual(['choice', 0])
    })
  })

  test('a row tap during a busy asset\'s choice cancels the choice, then acts: a call row selects the call, an asset row highlights the asset', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('low', 'LOW', kinds.templates.load, at(20), { [low]: 1 }), taskAt('top', 'TOP', kinds.templates.load, at(3), { [top]: 1 })]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 'low' } })
      const screen = await openScreen(run, createWall())
      await screen.mapTap('u1')
      await screen.mapTap('top')
      expect(screen.view().commit.state).toBe('choice')
      await screen.click({ kind: 'row', list: 'work', id: 'low' })
      expect([screen.view().commit.state, screen.view().selected?.id, screen.view().feedback?.text]).toEqual(['none', 'low', 'Cancelled'])
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      await screen.click({ kind: 'row', list: 'work', id: 'top' })
      expect(screen.view().commit.state).toBe('choice')
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      expect([screen.view().commit.state, screen.view().selected, screen.view().feedback?.text]).toEqual(['asset', { kind: 'unit', id: 'u1' }, 'Cancelled'])
      expect(screen.calls).toHaveLength(0)
    })
  })
})

describe('Board verbs and Undo say only what they do', () => {
  test('Cancel on a "Move here", or on a move armed by M, lets the asset go as the verbs do: the next tap on open ground brings back no bubble', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0))], async run => {
      const screen = await openScreen(run, createWall())
      await screen.mapTap('u1')
      await screen.groundTap(at(1, 1))
      expect(screen.view().mapPrompt?.unitId).toBe('u1')
      await screen.click({ kind: 'cancel' })
      expect([screen.view().feedback?.text, screen.view().selected, screen.mapSelection(), screen.view().mapPrompt]).toEqual(['Move cancelled', null, null, null])
      await screen.groundTap(at(1, 2))
      expect([screen.view().mapPrompt, screen.calls]).toEqual([null, []])
      await screen.mapTap('u1')
      await screen.key('m')
      await screen.key('Escape')
      expect([screen.view().feedback?.text, screen.view().selected]).toEqual(['Move cancelled', null])
    })
  })

  test('Stop is offered for every asset and Resume once it is paused; Clear while it holds steps; recall always; each lets the highlight go', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 })], async run => {
      await accepted(run, ids.send, { units: ['u2'], to: { taskId: 't1' } })
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      expect(screen.view().commit.verbs.map(entry => entry.verb)).toEqual(['hold', 'recall'])
      await screen.click({ kind: 'row', list: 'units', id: 'u2' })
      expect(screen.view().commit.verbs.map(entry => entry.verb)).toEqual(['hold', 'clear', 'recall'])
      await screen.click({ kind: 'verb', verb: 'hold', id: 'u2' })
      expect([screen.view().selected, screen.mapSelection()]).toEqual([null, null])
      expect(screen.view().unitBoard.rows.find(row => row.id === 'u2')?.pausedText).toBe(boardWords.paused)
      await screen.click({ kind: 'row', list: 'units', id: 'u2' })
      expect(screen.view().commit.verbs.map(entry => entry.verb)).toEqual(['resume', 'clear', 'recall'])
      await screen.click({ kind: 'verb', verb: 'resume', id: 'u2' })
      expect(screen.view().selected).toBeNull()
      expect(screen.calls.map(call => [call.capabilityId, call.result.ok])).toEqual([[ids.hold, true], [ids.resume, true]])
      expect(run.unit('u2').paused).toBeUndefined()
      // The next tap on a call selects it: no asset is left highlighted to send there.
      await screen.click({ kind: 'row', list: 'work', id: 't1' })
      expect([screen.view().selected?.id, screen.view().commit.offer, screen.calls.length]).toEqual(['t1', null, 2])
    })
  })

  test('a send of a free asset to a call, a site or open ground offers Undo, which removes the step the send created; a send that drops a step offers none', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)), unitAt('h1', 'H1', site, at(1, 1)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 })], async run => {
      const screen = await openScreen(run, createWall())
      await screen.mapTap('u1')
      await screen.mapTap('h1')
      expect([screen.calls.at(-1)!.input, screen.view().undo]).toEqual([{ units: ['u1'], to: { siteId: 'h1' } }, boardWords.undo])
      await screen.click({ kind: 'undo' })
      expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.stepRemove, input: { unitId: 'u1', stepId: 'step-1' }, result: { ok: true } })
      expect(run.unit('u1').orders).toEqual([])
      await screen.mapTap('u2')
      await screen.groundTap(at(2, 2))
      await screen.click({ kind: 'move-here' })
      expect([screen.calls.at(-1)!.input, screen.view().undo]).toEqual([{ units: ['u2'], to: { point: pointAt(at(2, 2)) } }, boardWords.undo])
      // U2 now holds a step: a call tapped for it asks, and doing it now drops the move, so it offers no Undo.
      await screen.mapTap('u2')
      await screen.mapTap('t1')
      expect(screen.view().commit).toMatchObject({ state: 'choice', detail: 'U2 stops: to a map point' })
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'option', option: 'do-now' })
      expect([screen.calls.at(-1)!.input, screen.calls.at(-1)!.result.ok, screen.view().undo]).toEqual([{ units: ['u2'], to: { taskId: 't1' } }, true, null])
    })
  })

  test('Undo is offered only where removing the step gives the asset back as it stood: not for one parked at a point, paused, or on its way home', async () => {
    const items = [
      unitAt('parked', 'PARKED', carrier, at(0)), unitAt('paused', 'PAUSED', carrier, at(0, 1)), unitAt('home', 'HOME', carrier, at(0, 2)),
      taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(5, 1), { [low]: 1 }), taskAt('t3', 'T3', kinds.templates.load, at(5, 2), { [low]: 1 }),
    ]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['parked'], to: { point: pointAt(at(0.5)) } })
      await accepted(run, ids.send, { units: ['home'], to: { point: pointAt(at(1, 2)) } })
      await accepted(run, ids.hold, { unitId: 'paused' })
      await runFor(run, 300_000)
      await accepted(run, ids.recall, { unitId: 'home' })
      expect([run.unit('parked').phase, run.unit('parked').orders, run.unit('paused').paused, run.unit('home').phase]).toEqual(['holding', [], true, 'returning'])
      const screen = await openScreen(run, createWall())
      for (const [unitId, taskId] of [['parked', 't1'], ['paused', 't2'], ['home', 't3']] as const) {
        await screen.mapTap(unitId)
        await screen.mapTap(taskId)
        // Free, so sent at once; undone, it would be sent home, resumed or made to idle, so Undo is not offered.
        expect([screen.calls.at(-1)!.input, screen.calls.at(-1)!.result.ok, screen.view().undo]).toEqual([{ units: [unitId], to: { taskId } }, true, null])
      }
    })
  })

  test('a step added behind an asset\'s steps, or while it is paused, keeps Undo, which leaves the asset as it stood', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 })], async run => {
      await accepted(run, ids.hold, { unitId: 'u1' })
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'verb', verb: 'add', id: 'u1' })
      await screen.mapTap('t1')
      expect([screen.calls.at(-1)!.capabilityId, screen.calls.at(-1)!.result.ok, screen.view().undo]).toEqual([ids.queue, true, boardWords.undo])
      expect(run.unit('u1').orders.map(step => [step.id, step.state])).toEqual([['step-1', 'queued']])
      await screen.click({ kind: 'undo' })
      expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.stepRemove, input: { unitId: 'u1', stepId: 'step-1' }, result: { ok: true } })
      expect([run.unit('u1').orders, run.unit('u1').paused, run.unit('u1').atBase]).toEqual([[], true, true])
    })
  })
})

describe('Board engage taps', () => {
  const spot = (north: number, east = 0): [number, number] => [...northEast(north, east).coordinates] as [number, number]

  test('an armed asset tapped onto an identified enemy track engages it; an unarmed one is refused in the engine\'s words and stays highlighted', async () => {
    const items = [
      unitAt('bt', 'BT', combatTypes.blueGun, spot(0), { side: blue }), unitAt('br', 'BR', combatTypes.blueScout, spot(0, 100), { side: blue }),
      unitAt('rr', 'RR', combatTypes.redScout, spot(400), { side: red }),
    ]
    const run = await openRun({ definition: borderWith(items) })
    try {
      const command = sensingCommandOf(borderDefinitions.scripted, blue).roles.map(role => role.id)
      const screen = await openScreen(run, createWall(), { actor: roleScreen(run, ...command) })
      const track = await identifiedTrack(run, blue, [screen])
      await screen.mapTap('br')
      await screen.mapTap(track.id)
      expect([screen.view().feedback?.text, screen.view().selected, screen.calls]).toEqual(['BR cannot fire', { kind: 'unit', id: 'br' }, []])
      expect(screen.preview('br', onObject(track.id))).toEqual({ text: 'BR cannot fire', refused: true })
      await screen.mapTap('bt')
      expect(screen.preview('bt', onObject(track.id))).toEqual({ text: `${boardWords.engage} BT → ${track.label}`, refused: false })
      await screen.mapTap(track.id)
      expect(screen.calls.map(call => [call.capabilityId, call.input, call.result.ok])).toEqual([[ids.send, { units: ['bt'], to: { trackId: track.id } }, true]])
      expect([screen.view().feedback?.text, screen.view().selected]).toEqual([`✓ ${boardWords.engage} BT → ${track.label}`, null])
      expect(run.unit('bt').orders.map(step => [step.kind, step.state, step.target])).toEqual([['engage', 'active', { trackId: track.id }]])
    } finally {
      await run.close()
    }
  }, 120_000)
})
