import { describe, expect, test } from 'bun:test'
import { scenarioRoleSchema } from '../../../core/model/index.ts'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { borderWith, civilConfig, civilKinds, civilRolesWith, civilWith, createWall, identifiedTrack, openScreen, pastGuardMs, pointAt, roleScreen, runFor, setupActor, taskAt, unitAt, type Screen } from '../fixtures/board-harness.ts'
import { borderDefinitions, commanderOf } from '../fixtures/border-harness.ts'
import { at as northEast, blue, red, types as combatTypes } from '../fixtures/combat-harness.ts'
import roles from '../fixtures/halden-civil-roles.scenario.json'
import { openRun, type OpenRun } from '../fixtures/run-harness.ts'
import { boardWords } from './text.ts'

/**
 * The dispatcher's tap budgets (A9: dispatch 2, a job-chain step added 2,
 * removed 2, stop 2, engaging an enemy track 2, a late top-priority divert
 * 3; a committed asset's
 * active step, whose removal releases its call, and a call-first send of an
 * asset holding steps ask first, 3), counted against the real runtime on a
 * running clock. Each flow runs in both tap modalities: taps on map objects,
 * routed exactly as the World surface routes them with the Board open
 * (`ui/map-target-routing.ts`), and taps on the Board's rows: a call row
 * tapped right after the asset's own row, or its +, takes the asset as the
 * call on the map does, so asset first holds the same budgets through the
 * lists (`taps.test.ts` covers a highlight that lingers). Waiting out a
 * guard is not a tap. Budgets run in open mode and in the role that queues
 * the load template; dispatch and alternatives also as Controller. A role's
 * Board runs on a real role Run, so core's gates and the Einsatz adapter
 * enforce its authority on every call. Keys remain hidden desktop accelerators; their
 * flows are covered in `controller.test.ts`.
 */

const kinds = civilKinds(civilConfig)
const { carrier, pairServer, conditionedServer } = kinds.types
const [top, , low] = kinds.classes as [string, string, string]
const roleConfig = einsatzConfigSchema.parse(roles.packs[0]!.config)
const loadRole = roleConfig.authority.find(entry => entry.taskTemplates.includes(kinds.templates.load))!.roleId
const pairRole = roleConfig.authority.find(entry => entry.taskTemplates.includes(kinds.templates.pair))!.roleId
const controllerRole = roles.roles.map(role => scenarioRoleSchema.parse(role)).find(role => role.class === 'controller')!

/** Where a Board sits: open mode, or a screen holding these roles in a role Run. */
interface Seat { readonly name: string; readonly roleIds?: ReadonlyArray<string> }
const open: Seat = { name: 'open mode' }
const operatorSeat = (roleId: string): Seat => ({ name: `role ${roleId}`, roleIds: [roleId] })
const controller: Seat = { name: 'Controller', roleIds: [controllerRole.id] }
/** Taps on the map's objects, or on the Board's rows. */
const modalities = ['map', 'rows'] as const
type Modality = typeof modalities[number]

const at = (eastKm: number, northKm = 0): [number, number] => [11.38 + eastKm / 57.12, 59.12 + northKm / 110.54]

const withSeat = async (seat: Seat, items: ReadonlyArray<Record<string, unknown>>, body: (run: OpenRun, screen: Screen) => Promise<void>): Promise<void> => {
  const run = await openRun({ definition: seat.roleIds === undefined ? civilWith(items) : civilRolesWith(items) })
  try {
    await body(run, await openScreen(run, createWall(), seat.roleIds === undefined ? {} : { actor: roleScreen(run, ...seat.roleIds) }))
  } finally {
    await run.close()
  }
}
const accepted = async (run: OpenRun, capabilityId: string, input: unknown): Promise<void> => {
  const result = await run.invoke(capabilityId, input, setupActor(run))
  if (!result.ok) throw new Error(`${capabilityId} refused: ${result.reason}`)
}
/** Counts the taps a flow takes from a settled Board, and checks every command it sent was accepted. */
const counted = async (screen: Screen, flow: () => Promise<void>): Promise<number> => {
  await screen.wait(pastGuardMs)
  screen.resetActions()
  const before = screen.calls.length
  await flow()
  expect(screen.calls.slice(before).every(call => call.result.ok)).toBe(true)
  return screen.actions()
}
/** A tap on an asset or a call: on the map, or on its row in Assets or Calls. */
const tapAsset = (screen: Screen, modality: Modality, id: string) => modality === 'map' ? screen.mapTap(id) : screen.click({ kind: 'row', list: 'units', id })
const tapCall = (screen: Screen, modality: Modality, id: string) => modality === 'map' ? screen.mapTap(id) : screen.click({ kind: 'row', list: 'work', id })
const tapButton = (screen: Screen) => screen.click({ kind: 'commit' })
const confirm = async (screen: Screen, state: 'confirm' | 'choice'): Promise<void> => {
  expect(screen.view().commit.state).toBe(state)
  await screen.wait(pastGuardMs)
  await (state === 'confirm' ? tapButton(screen) : screen.click({ kind: 'option', option: 'do-now' }))
}
const sentLast = (screen: Screen) => screen.calls.at(-1)!.input

/** A scene with another role's more urgent work and unit beside the load template's, so a role's Board must skip them. */
const dispatchScene = [
  unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(3)), unitAt('e1', 'E1', conditionedServer, at(10)),
  taskAt('t1', 'T1', kinds.templates.load, at(1), { [top]: 1 }), taskAt('t9', 'T9', kinds.templates.conditioned, at(11)),
]

describe('Board tap budgets', () => {
  for (const seat of [open, operatorSeat(loadRole), controller]) {
    for (const modality of modalities) {
      test(`dispatch, asset then call: 2 taps, shown as sent with Undo (${seat.name}, ${modality})`, async () => {
        await withSeat(seat, dispatchScene, async (_run, screen) => {
          const commandable = screen.view().unitBoard.rows.map(entry => entry.id)
          expect(commandable).toEqual(seat === open || seat === controller ? ['e1', 'u1', 'u2'] : ['u1', 'u2'])
          const taps = await counted(screen, async () => {
            await tapAsset(screen, modality, 'u2')
            expect(screen.view().selected).toEqual({ kind: 'unit', id: 'u2' })
            await tapCall(screen, modality, 't1')
          })
          expect(taps).toBe(2)
          expect(sentLast(screen)).toEqual({ units: ['u2'], to: { taskId: 't1' } })
          expect([screen.view().feedback?.text, screen.view().undo]).toEqual([`✓ ${civilConfig.lexicon.send} U2 → T1`, boardWords.undo])
          // The highlight lets go once the asset is sent.
          expect(screen.view().selected).toBeNull()
        })
      })

      test(`dispatch, call then its suggestion: 2 taps (${seat.name}, ${modality})`, async () => {
        await withSeat(seat, dispatchScene, async (_run, screen) => {
          const taps = await counted(screen, async () => {
            await tapCall(screen, modality, 't1')
            expect(screen.view().commit).toMatchObject({ state: 'ready', button: expect.stringMatching(new RegExp(`^${civilConfig.lexicon.send} U1 → T1 · `)) })
            await tapButton(screen)
          })
          expect(taps).toBe(2)
          expect(sentLast(screen)).toEqual({ units: ['u1'], to: { taskId: 't1' } })
        })
      })

      test(`an alternative: 2 taps, the call then the alternative (${seat.name}, ${modality})`, async () => {
        await withSeat(seat, dispatchScene, async (_run, screen) => {
          const taps = await counted(screen, async () => {
            await tapCall(screen, modality, 't1')
            await screen.click({ kind: 'alternative', number: 1 })
          })
          expect(taps).toBe(2)
          expect(sentLast(screen)).toEqual({ units: ['u2'], to: { taskId: 't1' } })
        })
      })

      test(`a divert alternative: 3 taps, the call, the alternative and confirm; the confirmation names the call it leaves once (${seat.name}, ${modality})`, async () => {
        const items = [
          unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)),
          taskAt('low', 'LOW', kinds.templates.load, at(25), { [low]: 1 }), taskAt('low2', 'LOW2', kinds.templates.load, at(25, 1), { [low]: 1 }),
          taskAt('top', 'TOP', kinds.templates.load, at(2), { [top]: 1 }),
        ]
        await withSeat(seat, items, async (run, screen) => {
          await accepted(run, ids.send, { units: ['u1'], to: { taskId: 'low' } })
          await accepted(run, ids.send, { units: ['u2'], to: { taskId: 'low2' } })
          await screen.sync()
          expect(await counted(screen, async () => {
            await tapCall(screen, modality, 'top')
            const selected = screen.view().selected
            if (selected?.kind !== 'task') throw new Error('expected the call selected')
            expect(selected.proposal.map(unit => unit.label)).toEqual(['U1'])
            const alternative = selected.alternatives.find(row => row.label === 'U2')
            if (alternative === undefined) throw new Error('expected U2 offered as a divert alternative')
            await screen.click({ kind: 'alternative', number: alternative.number })
            const { text, detail } = screen.view().commit
            expect([text, detail]).toEqual(['Divert U2 → TOP', expect.stringMatching(/^LOW2 \(/)])
            expect(`${text} ${detail}`.split('LOW2')).toHaveLength(2)
            await confirm(screen, 'confirm')
          })).toBe(3)
          expect(sentLast(screen)).toEqual({ units: ['u2'], to: { taskId: 'top' }, divert: [{ unitId: 'u2', fromTaskId: 'low2' }] })
        })
      })
    }
  }

  for (const seat of [open, operatorSeat(loadRole)]) {
    for (const modality of modalities) {
      test(`backlog after an own dispatch: 1 tap per call (${seat.name}, ${modality})`, async () => {
        const items = [
          unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)), unitAt('u3', 'U3', carrier, at(0, 2)),
          taskAt('t1', 'T1', kinds.templates.load, at(1), { [top]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(1, 1), { [kinds.classes[1]!]: 1 }),
          taskAt('t3', 'T3', kinds.templates.load, at(1, 2), { [low]: 1 }),
        ]
        await withSeat(seat, items, async (_run, screen) => {
          await tapCall(screen, modality, 't1')
          await tapButton(screen)
          for (const [unit, task] of [['u2', 't2'], ['u3', 't3']]) {
            expect(await counted(screen, async () => { await tapButton(screen) })).toBe(1)
            expect(sentLast(screen)).toEqual({ units: [unit], to: { taskId: task } })
          }
          // With no call left the served row is let go: nothing stale lingers.
          expect([screen.view().selected, screen.view().commit.state]).toEqual([null, 'none'])
        })
      })

      test(`a late top-priority call with no free unit, divert and confirm: 3 taps, call first or asset first (${seat.name}, ${modality})`, async () => {
        const items = [
          unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)),
          taskAt('low', 'LOW', kinds.templates.load, at(25), { [low]: 1 }), taskAt('low2', 'LOW2', kinds.templates.load, at(25, 1), { [low]: 1 }),
          taskAt('top', 'TOP', kinds.templates.load, at(2), { [top]: 1 }), taskAt('top2', 'TOP2', kinds.templates.load, at(2, 1), { [top]: 1 }),
        ]
        await withSeat(seat, items, async (run, screen) => {
          await accepted(run, ids.send, { units: ['u1'], to: { taskId: 'low' } })
          await accepted(run, ids.send, { units: ['u2'], to: { taskId: 'low2' } })
          await screen.sync()
          expect(await counted(screen, async () => {
            await tapCall(screen, modality, 'top')
            await tapButton(screen)
            // The confirmation names the call the unit leaves once, in its detail.
            expect(screen.view().commit).toMatchObject({ text: 'Divert U1 → TOP', detail: expect.stringMatching(/^LOW \(/) })
            await confirm(screen, 'confirm')
          })).toBe(3)
          expect(sentLast(screen)).toEqual({ units: ['u1'], to: { taskId: 'top' }, divert: [{ unitId: 'u1', fromTaskId: 'low' }] })
          expect(screen.view().undo).toBeNull()
          expect(await counted(screen, async () => {
            await tapAsset(screen, modality, 'u2')
            await tapCall(screen, modality, 'top2')
            expect(screen.view().commit).toMatchObject({ state: 'choice', text: 'Divert U2 → TOP2', options: [{ option: 'do-now', label: boardWords.doNow }, { option: 'add-to-end', label: boardWords.addToEnd }] })
            await confirm(screen, 'choice')
          })).toBe(3)
          expect(sentLast(screen)).toEqual({ units: ['u2'], to: { taskId: 'top2' }, divert: [{ unitId: 'u2', fromTaskId: 'low2' }] })
        })
      })

      test(`stop and recall: 2 taps each, the asset then its verb (${seat.name}, ${modality})`, async () => {
        await withSeat(seat, [unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 })], async (run, screen) => {
          await accepted(run, ids.send, { units: ['u1'], to: { point: pointAt(at(3)) } })
          await accepted(run, ids.send, { units: ['u2'], to: { taskId: 't1' } })
          await screen.sync()
          expect(await counted(screen, async () => {
            await tapAsset(screen, modality, 'u1')
            expect(screen.view().commit.verbs.map(entry => entry.verb)).toEqual(['hold', 'clear', 'recall'])
            await screen.click({ kind: 'verb', verb: 'hold', id: 'u1' })
          })).toBe(2)
          expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.hold, input: { unitId: 'u1' } })
          expect(run.unit('u1').phase).toBe('holding')
          expect(await counted(screen, async () => {
            await tapAsset(screen, modality, 'u2')
            expect(screen.view().commit.verbs.map(entry => entry.verb)).toEqual(['hold', 'clear', 'recall'])
            await screen.click({ kind: 'verb', verb: 'recall', id: 'u2' })
          })).toBe(2)
          expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.recall, input: { unitId: 'u2', fromTaskId: 't1' } })
        })
      })

      test(`add a job-chain step: 2 taps, the asset's + then the target (${seat.name}, ${modality})`, async () => {
        await withSeat(seat, [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(6), { [low]: 1 })], async (run, screen) => {
          await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
          await screen.sync()
          expect(await counted(screen, async () => {
            await screen.click({ kind: 'verb', verb: 'add', id: 'u1' })
            await tapCall(screen, modality, 't2')
          })).toBe(2)
          expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.queue, input: { unitId: 'u1', to: { taskId: 't2' } } })
          expect(run.unit('u1').orders.map(step => [step.id, step.state])).toEqual([['step-1', 'active'], ['step-2', 'queued']])
        })
      })

      test(`remove a job-chain step: 2 taps, the asset then the step's × (${seat.name}, ${modality})`, async () => {
        await withSeat(seat, [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(6), { [low]: 1 })], async (run, screen) => {
          await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
          await accepted(run, ids.queue, { unitId: 'u1', to: { taskId: 't2' } })
          await screen.sync()
          expect(await counted(screen, async () => {
            await tapAsset(screen, modality, 'u1')
            expect(screen.view().unitBoard.rows.find(entry => entry.id === 'u1')?.chain.map(step => [step.stepId, step.removable])).toEqual([['step-1', true], ['step-2', true]])
            await screen.click({ kind: 'remove-step', unitId: 'u1', stepId: 'step-2' })
          })).toBe(2)
          expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.stepRemove, input: { unitId: 'u1', stepId: 'step-2' } })
          expect(run.unit('u1').orders.map(step => step.id)).toEqual(['step-1'])
        })
      })

      test(`remove the active step of a committed asset: 3 taps, the asset, the step's × and Confirm, naming what returns to the call (${seat.name}, ${modality})`, async () => {
        await withSeat(seat, [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 })], async (run, screen) => {
          await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
          await screen.sync()
          expect(await counted(screen, async () => {
            await tapAsset(screen, modality, 'u1')
            await screen.click({ kind: 'remove-step', unitId: 'u1', stepId: 'step-1' })
            expect(screen.calls).toHaveLength(0)
            expect(screen.view().commit).toMatchObject({ state: 'confirm', detail: expect.stringMatching(/^T1 \(.+\) · 1 .+ returns to the queue$/) })
            await confirm(screen, 'confirm')
          })).toBe(3)
          expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.stepRemove, input: { unitId: 'u1', stepId: 'step-1' } })
          expect([run.unit('u1').taskId, run.unit('u1').orders]).toEqual([undefined, []])
        })
      })

      test(`dispatch, call first, of an asset on a move: 3 taps, the call, its suggestion and Do now; Add to end keeps the move (${seat.name}, ${modality})`, async () => {
        const items = [
          unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 5)),
          taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(1, 5), { [low]: 1 }),
        ]
        await withSeat(seat, items, async (run, screen) => {
          await accepted(run, ids.send, { units: ['u1'], to: { point: pointAt(at(3)) } })
          await accepted(run, ids.send, { units: ['u2'], to: { point: pointAt(at(3, 5)) } })
          await screen.sync()
          const choice = [{ option: 'do-now', label: boardWords.doNow }, { option: 'add-to-end', label: boardWords.addToEnd }]
          expect(await counted(screen, async () => {
            await tapCall(screen, modality, 't1')
            await tapButton(screen)
            expect(screen.view().commit).toMatchObject({ state: 'choice', detail: 'U1 stops: to a map point', options: choice })
            await confirm(screen, 'choice')
          })).toBe(3)
          expect([sentLast(screen), screen.view().undo]).toEqual([{ units: ['u1'], to: { taskId: 't1' } }, null])
          expect(await counted(screen, async () => {
            await tapCall(screen, modality, 't2')
            await tapButton(screen)
            expect(screen.view().commit).toMatchObject({ state: 'choice', detail: 'U2 stops: to a map point', options: choice })
            await screen.wait(pastGuardMs)
            await screen.click({ kind: 'option', option: 'add-to-end' })
          })).toBe(3)
          expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.queue, input: { unitId: 'u2', to: { taskId: 't2' } } })
          expect(run.unit('u2').orders.map(step => [step.kind, step.state])).toEqual([['move', 'active'], ['serve', 'queued']])
        })
      })

      test(`move to open ground: 3 taps, the asset, the ground and "Move here"; panning sends nothing (${seat.name}, ${modality})`, async () => {
        await withSeat(seat, [unitAt('u1', 'U1', carrier, at(0))], async (_run, screen) => {
          expect(await counted(screen, async () => {
            await tapAsset(screen, modality, 'u1')
            await screen.groundTap(at(2, 1))
            expect(screen.calls).toHaveLength(0)
            await screen.click({ kind: 'move-here' })
          })).toBe(3)
          expect(sentLast(screen)).toEqual({ units: ['u1'], to: { point: pointAt(at(2, 1)) } })
        })
      })
    }
  }

  for (const seat of [open, operatorSeat(pairRole)]) {
    for (const modality of modalities) {
      test(`acknowledge a report: 2 taps (${seat.name}, ${modality})`, async () => {
        await withSeat(seat, [unitAt('p1', 'P1', pairServer, at(0)), taskAt('r1', 'R1', kinds.templates.report, at(1))], async (run, screen) => {
          const taps = await counted(screen, async () => {
            await tapCall(screen, modality, 'r1')
            await tapButton(screen)
          })
          expect(taps).toBe(2)
          expect(run.task('r1').closedAtMs).toBeDefined()
        })
      })

      test(`a call needing two units: 2 taps, sent at once (${seat.name}, ${modality})`, async () => {
        const items = [unitAt('p1', 'P1', pairServer, at(0)), unitAt('p2', 'P2', pairServer, at(0, 1)), unitAt('p3', 'P3', pairServer, at(20)), taskAt('o1', 'O1', kinds.templates.pair, at(1))]
        await withSeat(seat, items, async (run, screen) => {
          const taps = await counted(screen, async () => {
            await tapCall(screen, modality, 'o1')
            expect(screen.view().commit.button).toStartWith(`${civilConfig.lexicon.send} P1 + P2 → O1`)
            await tapButton(screen)
          })
          expect(taps).toBe(2)
          expect(screen.calls).toHaveLength(1)
          expect(sentLast(screen)).toEqual({ units: ['p1', 'p2'], to: { taskId: 'o1' } })
          expect(['p1', 'p2', 'p3'].map(id => run.unit(id).taskId)).toEqual(['o1', 'o1', undefined])
        })
      })
    }
  }

  test('Undo, for 8 s after a send of free units, removes the step the send created, as the unit\'s last order names it, quietly; then it is gone', async () => {
    await withSeat(open, [unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 })], async (run, screen) => {
      await screen.mapTap('u1')
      await screen.mapTap('t1')
      expect([screen.view().undo, run.unit('u1').lastAction?.stepId]).toEqual([boardWords.undo, 'step-1'])
      await screen.click({ kind: 'undo' })
      expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.stepRemove, input: { unitId: 'u1', stepId: 'step-1', undo: true }, result: { ok: true } })
      expect([screen.view().undo, run.unit('u1').taskId, run.unit('u1').orders]).toEqual([null, undefined, []])
      // An undo puts things back quietly: no release alert on the call, in the header or the log.
      await screen.sync()
      expect([run.task('t1').alerts, screen.view().alerts, screen.view().workList.rows.find(row => row.id === 't1')?.alerts]).toEqual([[], [], []])
      expect(screen.view().log[0]?.text).toBe('U1: recalled (undo)')
      expect(screen.view().log.some(entry => entry.text.includes('released'))).toBe(false)
      await screen.mapTap('u2')
      await screen.mapTap('t1')
      expect(screen.view().undo).toBe(boardWords.undo)
      await screen.wait(7_000)
      expect(screen.view().undo).toBe(boardWords.undo)
      await screen.wait(1_000)
      expect(screen.view().undo).toBeNull()
      await screen.click({ kind: 'undo' })
      expect([screen.calls.at(-1)!.capabilityId, screen.view().feedback?.text]).toEqual([ids.send, 'Nothing to undo'])
    })
  })

  test('a second tap on the highlighted asset lets it go; a tap on another switches to it', async () => {
    await withSeat(open, [unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1))], async (_run, screen) => {
      for (const modality of modalities) {
        await tapAsset(screen, modality, 'u1')
        expect([screen.view().selected, screen.mapSelection()]).toEqual([{ kind: 'unit', id: 'u1' }, 'u1'])
        await tapAsset(screen, modality, 'u2')
        expect([screen.view().selected, screen.mapSelection()]).toEqual([{ kind: 'unit', id: 'u2' }, 'u2'])
        await tapAsset(screen, modality, 'u2')
        expect([screen.view().selected, screen.mapSelection()]).toEqual([null, null])
      }
    })
  })

  test('a role seat calls as its role: the adapter refuses it another role\'s unit and task, and lastAction names the role', async () => {
    await withSeat(operatorSeat(loadRole), dispatchScene, async (run, screen) => {
      const actor = roleScreen(run, loadRole)
      expect((await run.refusal(ids.send, { units: ['e1'], to: { taskId: 't9' } }, actor)).code).toBe('unit_not_authorized')
      expect((await run.refusal(ids.taskClose, { taskId: 't9' }, actor)).code).toBe('task_not_in_role_queue')
      await screen.mapTap('t1')
      await screen.click({ kind: 'commit' })
      expect(screen.calls.map(call => call.result)).toEqual([{ ok: true }])
      expect(run.unit('u1').lastAction?.by).toBe(roles.roles.find(role => role.id === loadRole)!.label)
    })
  })

  test('engage an enemy track: 2 taps, the armed asset then the track on the map (sided Run, the commander of the side\'s armed units)', async () => {
    const spot = (north: number): [number, number] => [...northEast(north).coordinates] as [number, number]
    const run = await openRun({ definition: borderWith([unitAt('bt', 'BT', combatTypes.blueGun, spot(0), { side: blue }), unitAt('rr', 'RR', combatTypes.redScout, spot(400), { side: red })]) })
    try {
      const commander = commanderOf(borderDefinitions.scripted, blue, 'effector').roles[0]!.id
      const screen = await openScreen(run, createWall(), { actor: roleScreen(run, commander) })
      const track = await identifiedTrack(run, blue, [screen])
      expect(await counted(screen, async () => {
        await screen.mapTap('bt')
        await screen.mapTap(track.id)
      })).toBe(2)
      expect(sentLast(screen)).toEqual({ units: ['bt'], to: { trackId: track.id } })
    } finally {
      await run.close()
    }
  }, 120_000)

  test('a recall of a free unit on a point move: 2 taps, and it returns', async () => {
    await withSeat(open, [unitAt('u1', 'U1', carrier, at(0))], async (run, screen) => {
      await accepted(run, ids.send, { units: ['u1'], to: { point: pointAt(at(3)) } })
      await runFor(run, 30_000, [screen])
      expect(await counted(screen, async () => {
        await screen.mapTap('u1')
        await screen.click({ kind: 'verb', verb: 'recall', id: 'u1' })
      })).toBe(2)
      expect(run.unit('u1').phase).toBe('returning')
    })
  })
})
