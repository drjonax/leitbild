import { describe, expect, test } from 'bun:test'
import { scenarioRoleSchema } from '../../../core/model/index.ts'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { civilConfig, civilKinds, civilRolesWith, civilWith, createWall, onObject, openScreen, pastGuardMs, pointAt, roleScreen, runFor, setupActor, taskAt, unitAt, type Screen } from '../fixtures/board-harness.ts'
import roles from '../fixtures/halden-civil-roles.scenario.json'
import { openRun, type OpenRun } from '../fixtures/run-harness.ts'

/**
 * The dispatcher's action budgets (§9.2), counted by keyboard and by pointer
 * against the real runtime on a running clock. Waiting out a guard is not an
 * action. Budgets run in open mode and in the role that queues the load
 * template, dispatch and alternative also as Controller. A role's Board
 * runs on a real role Run of the civil role Definition with the same items:
 * its screen holds the role, so core's gates and the Einsatz adapter enforce
 * the role's authority on every call it makes.
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
const modalities = ['keys', 'pointer'] as const
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
/** Counts the actions a flow takes from a settled Board, and checks every command it sent was accepted. */
const counted = async (screen: Screen, flow: () => Promise<void>): Promise<number> => {
  await screen.wait(pastGuardMs)
  screen.resetActions()
  const before = screen.calls.length
  await flow()
  expect(screen.calls.slice(before).every(call => call.result.ok)).toBe(true)
  return screen.actions()
}
const row = (screen: Screen, id: string) => screen.click({ kind: 'row', list: 'work', id })
const commit = async (screen: Screen, modality: Modality): Promise<void> =>
  modality === 'keys' ? await screen.key('Enter') : await screen.click({ kind: 'commit' })
const confirm = async (screen: Screen, modality: Modality): Promise<void> => {
  expect(screen.view().commit.state).toBe('confirm')
  await screen.wait(pastGuardMs)
  await commit(screen, modality)
}
const sentLast = (screen: Screen) => screen.calls.at(-1)!.input

/** A scene with another role's more urgent work and unit beside the load template's, so a role's Board must skip them. */
const dispatchScene = [
  unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(3)), unitAt('e1', 'E1', conditionedServer, at(10)),
  taskAt('t1', 'T1', kinds.templates.load, at(1), { [top]: 1 }), taskAt('t9', 'T9', kinds.templates.conditioned, at(11)),
]

describe('Board budgets', () => {
  for (const seat of [open, operatorSeat(loadRole), controller]) {
    for (const modality of modalities) {
      test(`dispatch the recommendation: 2 actions (${seat.name}, ${modality})`, async () => {
        await withSeat(seat, dispatchScene, async (_run, screen) => {
          const commandable = screen.view().unitBoard.rows.map(entry => entry.id)
          expect(commandable).toEqual(seat === open || seat === controller ? ['e1', 'u1', 'u2'] : ['u1', 'u2'])
          const actions = await counted(screen, async () => {
            if (modality === 'keys') await screen.key('n')
            else await row(screen, 't1')
            await commit(screen, modality)
          })
          expect(actions).toBe(2)
          expect(sentLast(screen)).toEqual({ units: ['u1'], to: { taskId: 't1' } })
        })
      })

      test(`choose an alternative: 3 actions (${seat.name}, ${modality})`, async () => {
        await withSeat(seat, dispatchScene, async (_run, screen) => {
          const actions = await counted(screen, async () => {
            if (modality === 'keys') {
              await screen.key('n')
              await screen.key('1')
            } else {
              await row(screen, 't1')
              await screen.click({ kind: 'alternative', number: 1 })
            }
            await commit(screen, modality)
          })
          expect(actions).toBe(3)
          expect(sentLast(screen)).toEqual({ units: ['u2'], to: { taskId: 't1' } })
        })
      })
    }
  }

  for (const seat of [open, operatorSeat(loadRole)]) {
    for (const modality of modalities) {
      test(`backlog after an own dispatch: 1 action per task (${seat.name}, ${modality})`, async () => {
        const items = [
          unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)), unitAt('u3', 'U3', carrier, at(0, 2)),
          taskAt('t1', 'T1', kinds.templates.load, at(1), { [top]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(1, 1), { [kinds.classes[1]!]: 1 }),
          taskAt('t3', 'T3', kinds.templates.load, at(1, 2), { [low]: 1 }),
        ]
        await withSeat(seat, items, async (_run, screen) => {
          await screen.key('n')
          await commit(screen, modality)
          for (const [unit, task] of [['u2', 't2'], ['u3', 't3']]) {
            expect(await counted(screen, async () => { await commit(screen, modality) })).toBe(1)
            expect(sentLast(screen)).toEqual({ units: [unit], to: { taskId: task } })
          }
        })
      })

      test(`a late top-priority task with no free unit, divert and confirm: 3 actions (${seat.name}, ${modality})`, async () => {
        const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('low', 'LOW', kinds.templates.load, at(25), { [low]: 1 }), taskAt('top', 'TOP', kinds.templates.load, at(2), { [top]: 1 })]
        await withSeat(seat, items, async (run, screen) => {
          await accepted(run, ids.send, { units: ['u1'], to: { taskId: 'low' } })
          await screen.sync()
          const actions = await counted(screen, async () => {
            if (modality === 'keys') await screen.key('n')
            else await row(screen, 'top')
            await commit(screen, modality)
            await confirm(screen, modality)
          })
          expect(actions).toBe(3)
          expect(sentLast(screen)).toEqual({ units: ['u1'], to: { taskId: 'top' }, divert: [{ unitId: 'u1', fromTaskId: 'low' }] })
        })
      })

      test(`choose a divert alternative: 4 actions (${seat.name}, ${modality})`, async () => {
        const items = [
          unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 3)),
          taskAt('low1', 'LOW1', kinds.templates.load, at(25), { [low]: 1 }), taskAt('low2', 'LOW2', kinds.templates.load, at(25, 3), { [low]: 1 }),
          taskAt('top', 'TOP', kinds.templates.load, at(1), { [top]: 1 }),
        ]
        await withSeat(seat, items, async (run, screen) => {
          await accepted(run, ids.send, { units: ['u1'], to: { taskId: 'low1' } })
          await accepted(run, ids.send, { units: ['u2'], to: { taskId: 'low2' } })
          await screen.sync()
          const actions = await counted(screen, async () => {
            if (modality === 'keys') {
              await screen.key('n')
              await screen.key('1')
            } else {
              await row(screen, 'top')
              await screen.click({ kind: 'alternative', number: 1 })
            }
            await commit(screen, modality)
            await confirm(screen, modality)
          })
          expect(actions).toBe(4)
          expect(sentLast(screen)).toEqual({ units: ['u2'], to: { taskId: 'top' }, divert: [{ unitId: 'u2', fromTaskId: 'low2' }] })
        })
      })

      test(`recall: 2 actions (${seat.name}, ${modality})`, async () => {
        await withSeat(seat, [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 })], async (_run, screen) => {
          await screen.key('n')
          await screen.key('Enter')
          const actions = await counted(screen, async () => {
            if (modality === 'keys') {
              await screen.key(']')
              await screen.key('r')
            } else {
              await screen.click({ kind: 'row', list: 'units', id: 'u1' })
              await screen.click({ kind: 'verb', verb: 'recall', id: 'u1' })
            }
          })
          expect(actions).toBe(2)
          expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.recall, input: { unitId: 'u1', fromTaskId: 't1' } })
        })
      })
    }
  }

  for (const [seat, modality] of [open, operatorSeat(loadRole)].flatMap(entry => modalities.map(mode => [entry, mode] as const))) {
    test(`from the map: a free unit in 2 actions, a committed one in 3 with its confirmation (${seat.name}, ${modality === 'keys' ? 'pointer, confirmed by key' : 'pointer'})`, async () => {
      const items = [
        unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)),
        taskAt('low', 'LOW', kinds.templates.load, at(25), { [low]: 1 }), taskAt('top', 'TOP', kinds.templates.load, at(2), { [top]: 1 }),
        taskAt('mid', 'MID', kinds.templates.load, at(3, 1), { [kinds.classes[1]!]: 1 }),
      ]
      await withSeat(seat, items, async (run, screen) => {
        await accepted(run, ids.send, { units: ['u1'], to: { taskId: 'low' } })
        await screen.sync()
        expect(await counted(screen, async () => {
          await screen.mapSelect('u2')
          await screen.mapTarget('u2', onObject('mid'))
        })).toBe(2)
        expect(sentLast(screen)).toEqual({ units: ['u2'], to: { taskId: 'mid' } })
        expect(await counted(screen, async () => {
          await screen.mapSelect('u1')
          await screen.mapTarget('u1', onObject('top'))
          await confirm(screen, modality)
        })).toBe(3)
        expect(sentLast(screen)).toEqual({ units: ['u1'], to: { taskId: 'top' }, divert: [{ unitId: 'u1', fromTaskId: 'low' }] })
      })
    })
  }

  for (const seat of [open, operatorSeat(pairRole)]) {
    for (const modality of modalities) {
      test(`acknowledge a report: 2 actions (${seat.name}, ${modality})`, async () => {
        await withSeat(seat, [unitAt('p1', 'P1', pairServer, at(0)), taskAt('r1', 'R1', kinds.templates.report, at(1))], async (run, screen) => {
          const actions = await counted(screen, async () => {
            if (modality === 'keys') {
              await screen.key('n')
              await screen.key('c')
            } else {
              await row(screen, 'r1')
              await screen.click({ kind: 'verb', verb: 'close', id: 'r1' })
            }
          })
          expect(actions).toBe(2)
          expect(run.task('r1').closedAtMs).toBeDefined()
        })
      })

      test(`a task needing two units: 2 actions, sent at once (${seat.name}, ${modality})`, async () => {
        const items = [unitAt('p1', 'P1', pairServer, at(0)), unitAt('p2', 'P2', pairServer, at(0, 1)), unitAt('p3', 'P3', pairServer, at(20)), taskAt('o1', 'O1', kinds.templates.pair, at(1))]
        await withSeat(seat, items, async (run, screen) => {
          const actions = await counted(screen, async () => {
            if (modality === 'keys') await screen.key('n')
            else await row(screen, 'o1')
            await commit(screen, modality)
          })
          expect(actions).toBe(2)
          expect(screen.calls).toHaveLength(1)
          expect(sentLast(screen)).toEqual({ units: ['p1', 'p2'], to: { taskId: 'o1' } })
          expect(['p1', 'p2', 'p3'].map(id => run.unit(id).taskId)).toEqual(['o1', 'o1', undefined])
        })
      })
    }
  }

  test('recall a free unit on a point move: 2 actions, and it returns', async () => {
    await withSeat(open, [unitAt('u1', 'U1', carrier, at(0))], async (run, screen) => {
      await accepted(run, ids.send, { units: ['u1'], to: { point: pointAt(at(3)) } })
      await runFor(run, 30_000, [screen])
      expect(await counted(screen, async () => {
        await screen.click({ kind: 'row', list: 'units', id: 'u1' })
        await screen.key('r')
      })).toBe(2)
      expect(run.unit('u1').phase).toBe('returning')
    })
  })

  test('a role seat calls as its role: the adapter refuses it another role\'s unit and task, and lastAction names the role', async () => {
    await withSeat(operatorSeat(loadRole), dispatchScene, async (run, screen) => {
      const actor = roleScreen(run, loadRole)
      expect((await run.refusal(ids.send, { units: ['e1'], to: { taskId: 't9' } }, actor)).code).toBe('unit_not_authorized')
      expect((await run.refusal(ids.taskClose, { taskId: 't9' }, actor)).code).toBe('task_not_in_role_queue')
      await screen.key('n')
      await screen.key('Enter')
      expect(screen.calls.map(call => call.result)).toEqual([{ ok: true }])
      expect(run.unit('u1').lastAction?.by).toBe(roles.roles.find(role => role.id === loadRole)!.label)
    })
  })
})
