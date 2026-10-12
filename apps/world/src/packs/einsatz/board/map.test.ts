import { describe, expect, test } from 'bun:test'
import type { ObjectId, OperationalObject } from '../../../core/model/index.ts'
import { scenarioRoleSchema } from '../../../core/model/index.ts'
import type { PackTargetingContribution } from '../../../core/packs/protocol.ts'
import { routeObjectClick, type MapClickContext, type MapTargetPanel } from '../../../ui/map-target-routing.ts'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { civilConfig, civilKinds, civilRolesWith, civilWith, createWall, onGround, onObject, openScreen, pastGuardMs, roleScreen, taskAt, unitAt, type Screen } from '../fixtures/board-harness.ts'
import roles from '../fixtures/halden-civil-roles.scenario.json'
import { openRun, type OpenRun } from '../fixtures/run-harness.ts'
import { einsatzPackId } from '../ids.ts'
import { openModeViewer } from '../picture.ts'
import { readBoardRecords } from './records.ts'
import { createBoardRules } from './rules.ts'
import type { BoardEffect } from './types.ts'

/**
 * The Board and the map share one selection and one order path. The map's
 * echo of the Board's own selection is no operator input; a map target click
 * names an object or a point, which the Board classifies against the records
 * it holds; and the hover preview says what that click would do.
 */

const kinds = civilKinds(civilConfig)
const { carrier, pairServer, conditionedServer, site } = kinds.types
const [top, middle, low] = kinds.classes as [string, string, string]
const word = (key: keyof NonNullable<typeof civilConfig.lexicon>) => civilConfig.lexicon[key]!
const code = (classId: string) => civilConfig.loadClasses.find(entry => entry.id === classId)!.code
const noun = (classId: string) => civilConfig.loadClasses.find(entry => entry.id === classId)!.noun.one
const condition = civilConfig.taskTemplates.find(entry => entry.id === kinds.templates.conditioned)!.requires[0]!.where[0]!
const at = (eastKm: number, northKm = 0): [number, number] => [11.38 + eastKm / 57.12, 59.12 + northKm / 110.54]
const modalities = ['keys', 'pointer'] as const
type Modality = typeof modalities[number]

const withScene = async (items: ReadonlyArray<Record<string, unknown>>, body: (run: OpenRun) => Promise<void>, definition: (items: ReadonlyArray<Record<string, unknown>>) => unknown = civilWith): Promise<void> => {
  const run = await openRun({ definition: definition(items) })
  try { await body(run) } finally { await run.close() }
}
const accepted = async (run: OpenRun, capabilityId: string, input: unknown): Promise<void> => {
  const result = await run.invoke(capabilityId, input)
  if (!result.ok) throw new Error(`${capabilityId} refused: ${result.reason}`)
}
const commit = async (screen: Screen, modality: Modality): Promise<void> =>
  modality === 'keys' ? await screen.key('Enter') : await screen.click({ kind: 'commit' })
const etaPattern = '≈?\\d+:\\d\\d'

describe('Board and map share one selection', () => {
  for (const modality of modalities) {
    test(`the map echoing the auto-advance keeps the guard armed, and the commit waits for it (${modality})`, async () => {
      const items = [unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [top]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(1, 1), { [middle]: 1 })]
      await withScene(items, async run => {
        const screen = await openScreen(run, createWall())
        if (modality === 'keys') await screen.key('n')
        else await screen.click({ kind: 'row', list: 'work', id: 't1' })
        await commit(screen, modality)
        expect([screen.view().selected?.id, screen.mapSelection()]).toEqual(['t2', 't2'])
        expect(screen.view().commit).toMatchObject({ enabled: false, hint: 'Confirm next: T2' })
        await screen.mapSelect(screen.mapSelection())
        expect(screen.view().commit).toMatchObject({ enabled: false, hint: 'Confirm next: T2' })
        await commit(screen, modality)
        expect([screen.calls.length, screen.view().feedback?.text]).toEqual([1, 'Not sent: the list changed · Confirm next: T2'])
        await screen.wait(pastGuardMs)
        await commit(screen, modality)
        expect(screen.calls.at(-1)).toMatchObject({ input: { units: ['u2'], to: { taskId: 't2' } }, result: { ok: true } })
      })
    })

    test(`the map echoing the row selection keeps a chosen alternative (${modality})`, async () => {
      const items = [unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(3)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 1 })]
      await withScene(items, async run => {
        const screen = await openScreen(run, createWall())
        if (modality === 'keys') {
          await screen.key('n')
          await screen.key('1')
        } else {
          await screen.click({ kind: 'row', list: 'work', id: 't1' })
          await screen.click({ kind: 'alternative', number: 1 })
        }
        const chosen = screen.view().commit
        expect(chosen.text).toStartWith(`⏎ ${word('send')} U2 → T1`)
        await screen.mapSelect(screen.mapSelection())
        expect(screen.view().commit).toEqual(chosen)
        await commit(screen, modality)
        expect(screen.calls.at(-1)).toMatchObject({ input: { units: ['u2'], to: { taskId: 't1' } }, result: { ok: true } })
      })
    })
  }
})

describe('Board selection echoes', () => {
  test('a late echo of an earlier selection is no map click, and a later click on that object is', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [top]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(1, 1), { [middle]: 1 })]
    await withScene(items, async run => {
      const screen = await openScreen(run, createWall())
      const selects = (effects: ReadonlyArray<BoardEffect>): ReadonlyArray<string | null> => effects.flatMap(effect => effect.kind === 'select' ? [effect.objectId] : [])
      // The Board selects T1, then T2, before the map has echoed either.
      expect(selects(screen.raw({ kind: 'key', key: 'n', code: 'KeyN', shift: false }))).toEqual(['t1'])
      expect(selects(screen.raw({ kind: 'key', key: 'ArrowDown', code: 'ArrowDown', shift: false }))).toEqual(['t2'])
      // The echoes arrive late and in order: neither moves the Board.
      for (const echo of ['t1', 't2']) {
        expect(screen.raw({ kind: 'selection', objectId: echo as ObjectId })).toEqual([])
        expect(screen.view().selected?.id).toBe('t2')
      }
      // The operator then clicks T1 on the map: that selects it.
      screen.raw({ kind: 'selection', objectId: 't1' as ObjectId })
      expect(screen.view().selected?.id).toBe('t1')
    })
  })
})

describe('Board map targets and previews', () => {
  const scene = [
    unitAt('u1', 'U1', carrier, at(0)), unitAt('p1', 'P1', pairServer, at(5)),
    unitAt('e2', 'E2', conditionedServer, at(2), { properties: { [condition.property]: 1_000 } }),
    unitAt('h1', 'H1', site, at(1, 1)),
    taskAt('top', 'TOP', kinds.templates.load, at(1), { [top]: 1 }), taskAt('fire', 'FIRE', kinds.templates.conditioned, at(3)),
  ]

  test('a task, a receiving site or the armed ground; any other unit says it is no target, and an object outside the records shows no preview', async () => {
    await withScene(scene, async run => {
      const screen = await openScreen(run, createWall())
      expect(screen.preview('u1', onObject('top'))).toMatchObject({ refused: false, text: expect.stringMatching(new RegExp(`^${word('send')} U1 → TOP · ${etaPattern}$`)) })
      const ineligible = screen.preview('e2', onObject('fire'))
      expect(ineligible).toMatchObject({ refused: true, text: expect.stringContaining('E2') })
      expect(screen.preview('u1', onGround(at(0, 3)))).toEqual({ text: 'M, then click the map to move U1', refused: true })
      expect(screen.preview('u1', onObject('h1'))).toEqual({ text: 'Move U1 → H1', refused: false })
      expect(screen.preview('u1', onObject('p1'))).toEqual({ text: 'P1 is not a target for U1', refused: true })
      expect(screen.preview('u1', onObject('weather:front'))).toBeNull()

      await screen.mapSelect('u1')
      await screen.mapTarget('u1', onObject('p1'))
      expect([screen.calls.length, screen.view().feedback?.text]).toEqual([0, 'P1 is not a target for U1'])
      await screen.mapTarget('u1', onObject('weather:front'))
      expect([screen.calls.length, screen.view().feedback?.text]).toEqual([0, 'Not a target for U1'])
      await screen.mapTarget('u1', onGround(at(0, 3)))
      expect([screen.calls.length, screen.view().feedback?.text]).toEqual([0, 'M, then click the map to move U1'])
      await screen.mapTarget('u1', onObject('h1'))
      expect(screen.calls.at(-1)).toMatchObject({ input: { units: ['u1'], to: { siteId: 'h1' } }, result: { ok: true } })

      await screen.key('m')
      expect(screen.preview('u1', onGround(at(0, 3)))).toEqual({ text: 'Move U1 → the map point', refused: false })
      await screen.mapTarget('u1', onGround(at(0, 3)))
      expect(screen.calls.at(-1)).toMatchObject({ input: { units: ['u1'], to: { point: { type: 'Point' } } }, result: { ok: true } })
      expect(screen.calls.every(call => call.result.ok)).toBe(true)
    })
  })

  test('a committed unit previews its divert with the confirmation it asks for; during a confirmation every target says to confirm first', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), taskAt('low', 'LOW', kinds.templates.load, at(25), { [low]: 1 }), taskAt('top', 'TOP', kinds.templates.load, at(2), { [top]: 1 })], async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 'low' } })
      const screen = await openScreen(run, createWall())
      const divert = `Divert U1 → TOP · ${etaPattern} · confirm: LOW \\(${code(low)}\\) · 1 ${noun(low)} returns to the queue`
      expect(screen.preview('u1', onObject('top'))).toMatchObject({ refused: false, text: expect.stringMatching(new RegExp(`^${divert}$`)) })
      await screen.mapSelect('u1')
      await screen.mapTarget('u1', onObject('top'))
      expect(screen.view().commit.state).toBe('confirm')
      expect(screen.preview('u1', onObject('low'))).toEqual({ text: 'Confirm ⏎ or Esc first', refused: true })
    })
  })

  test('a unit the screen\'s roles do not command previews and answers the refusal, and sends nothing', async () => {
    const roleConfig = einsatzConfigSchema.parse(roles.packs[0]!.config)
    const loadRole = scenarioRoleSchema.parse(roles.roles.find(role => roleConfig.authority.some(entry => entry.roleId === role.id && entry.taskTemplates.includes(kinds.templates.load)))!)
    await withScene([unitAt('u1', 'U1', carrier, at(0)), unitAt('p1', 'P1', pairServer, at(1)), taskAt('top', 'TOP', kinds.templates.load, at(2), { [top]: 1 })], async run => {
      // A real role Run: the screen holds the role, so the adapter would refuse what the Board did send.
      const screen = await openScreen(run, createWall(), { actor: roleScreen(run, loadRole.id) })
      expect(screen.preview('p1', onObject('top'))).toEqual({ text: 'P1 is not commanded by your roles', refused: true })
      await screen.mapTarget('p1', onObject('top'))
      expect([screen.calls.length, screen.view().feedback?.text]).toEqual([0, 'P1 is not commanded by your roles'])
      expect(screen.preview('u1', onObject('top'))).toMatchObject({ refused: false })
    }, civilRolesWith)
  })

  test('with the Board open, a click on a receiving site while a carrier is selected reaches the Board through the World\'s map routing as the carrier\'s target, and sends it there', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), unitAt('h1', 'H1', site, at(1, 1))], async run => {
      const screen = await openScreen(run, createWall())
      const rules = createBoardRules(civilConfig, openModeViewer)
      const objects = run.run.snapshot().objects
      const object = (id: string): OperationalObject => objects.find(entry => entry.id === id)!
      const record = (id: string) => readBoardRecords([object(id)]).units.get(id)!
      // Open mode commands the site too; only a unit that can move is a map controller.
      expect([rules.commands(record('h1')), rules.ordersOnMap(record('h1')), rules.ordersOnMap(record('u1'))]).toEqual([true, false, true])
      // Einsatz-like targeting as the Board's contract states it; while the Board takes map targets, the generic send is never reached.
      const generic = (): never => { throw new Error('The open Board takes every map target of its own Pack\'s controllers') }
      const targeting: PackTargetingContribution = {
        isController: candidate => {
          const unit = readBoardRecords([candidate]).units.get(candidate.id)
          return unit !== undefined && rules.ordersOnMap(unit)
        },
        isTarget: generic,
        buildSetTargetCommand: generic,
        buildCancelTargetCommand: generic,
      }
      const targets: Array<Parameters<NonNullable<MapTargetPanel['onMapTarget']>>> = []
      const panel: MapTargetPanel = { label: 'Board', packId: einsatzPackId, onMapTarget: (controllerId, target) => { targets.push([controllerId, target]) }, previewMapTarget: (controllerId, target) => screen.preview(controllerId, target) }
      const click = (controller: string | null): MapClickContext => ({ controller: controller === null ? null : object(controller), targeting, context: { objects }, panel })

      // With nothing selected, a click selects what it hits, the carrier quietly as a controller.
      expect(routeObjectClick(object('u1'), click(null))).toEqual({ kind: 'select', objectId: 'u1' as ObjectId, note: null })
      await screen.mapSelect('u1')
      const route = routeObjectClick(object('h1'), click('u1'))
      expect(route).toEqual({ kind: 'panel', controllerId: 'u1' as ObjectId, target: onObject('h1') })
      if (route.kind !== 'panel') throw new Error('expected the site click to reach the Board')
      panel.onMapTarget!(route.controllerId, route.target)
      expect(panel.previewMapTarget!(route.controllerId, route.target)).toEqual({ text: 'Move U1 → H1', refused: false })
      for (const [controllerId, target] of targets) await screen.mapTarget(controllerId, target)
      expect(screen.calls.at(-1)).toMatchObject({ input: { units: ['u1'], to: { siteId: 'h1' } }, result: { ok: true } })
      // Nor does the Board itself take map orders for a site.
      expect(screen.preview('h1', onObject('u1'))).toEqual({ text: 'H1 cannot move', refused: true })
    })
  })
})
