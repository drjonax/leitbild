import { describe, expect, test } from 'bun:test'
import type { OperationalObject } from '../../../core/model/index.ts'
import type { Actor } from '../../../core/simulation-runs/actors.ts'
import { einsatzDataSchema, type LastAction, type TaskData, type UnitData } from '../engine/model.ts'
import { createWall, follow, openScreen, roleScreen, type Screen } from '../fixtures/board-harness.ts'
import { groupDeclaration, groupItems, groups } from '../fixtures/groups-run.ts'
import civil from '../fixtures/halden-civil.scenario.json'
import { renameDefinition, type Namespace, type Renaming } from '../fixtures/renaming.ts'
import { definitionOf, openRun, type OpenRun } from '../fixtures/run-harness.ts'
import supplyRun from '../fixtures/supply-run.scenario.json'
import { groupRoleId } from '../ids.ts'
import { refusalCode } from '../refusal.ts'

/**
 * The recommendation follower presses N, then Enter (and Enter again to
 * confirm), on every unserved row as it appears, on a running Run. On civil
 * Halden the late top-priority call must divert the unit on its way to the
 * minor call. The renaming generality test runs the follower on each shipped
 * Definition and on a copy whose every type, tag, template, class, property,
 * label and word is an opaque token: both Runs must journal the same
 * transitions, modulo the renaming, with the same Board actions and results.
 */

const cue = (id: string) => civil.timeline.cues.find(entry => entry.id === id)!

interface Followed {
  readonly journal: ReadonlyArray<OperationalObject>
  readonly actions: number
  readonly results: ReadonlyArray<readonly [string, unknown, string]>
}

const followed = async (definition: unknown, untilS: number, inspect?: (run: OpenRun, screen: Screen) => void, actor?: (run: OpenRun) => Actor): Promise<Followed> => {
  const run = await openRun({ definition })
  try {
    const screen = await openScreen(run, createWall(), actor === undefined ? {} : { actor: actor(run) })
    const startMs = run.nowMs()
    await follow(run, screen, { untilMs: startMs + untilS * 1_000, stepMs: 5_000 })
    inspect?.(run, screen)
    return {
      journal: run.journal.flatMap(event => event.type === 'object.upserted' ? [event.object] : []),
      actions: screen.actions(),
      results: screen.calls.map(call => [call.capabilityId, call.input, call.result.ok ? 'ok' : refusalCode(call.result.reason)] as const),
    }
  } finally {
    await run.close()
  }
}

describe('Recommendation follower', () => {
  test('on civil Halden the late top-priority call, with every carrier busy, diverts the unit on its way to the minor call', async () => {
    const minor = cue('minor-call').actions[0]!.input
    const late = cue('late-top-priority').actions[0]!.input
    await followed(civil, cue('late-top-priority').at.seconds + 30, (run, screen) => {
      const tasks = new Map(run.run.snapshot().objects.filter(object => object.kind === 'incident').map(object => [object.label, object.id]))
      const divert = screen.calls.find(call => (call.input as { divert?: unknown }).divert !== undefined)
      expect(divert).toMatchObject({
        input: { to: { taskId: tasks.get(late.label) }, divert: [{ fromTaskId: tasks.get(minor.label) }] },
        result: { ok: true },
      })
      const diverted = (divert!.input as { units: string[] }).units[0]!
      expect(run.unit(diverted)).toMatchObject({ taskId: tasks.get(late.label), lastAction: { verb: 'divert' } })
      const minorRow = screen.view().workList.rows.find(row => row.label === minor.label)!
      expect([minorRow.served, minorRow.alerts.length]).toEqual([false, 1])
      expect(screen.calls.every(call => call.result.ok)).toBe(true)
    })
  }, 60_000)
})

const mapKeys = (record: Readonly<Record<string, number>> | undefined, rename: (key: string) => string) =>
  record === undefined ? undefined : Object.fromEntries(Object.entries(record).map(([key, value]) => [rename(key), value]))

/** What a Run of the original wrote, in the renamed copy's words. */
const renamedObject = (renaming: Renaming, object: OperationalObject): OperationalObject => {
  const id = (namespace: Namespace) => (value: string) => renaming.id(namespace, value)
  // In a role Run an order names the roles that gave it by their labels, which the copy renames.
  const action = (last: LastAction | undefined) => last === undefined ? {} : { lastAction: { ...last, by: renaming.text(last.by), ...(last.cause === undefined ? {} : { cause: renaming.text(last.cause) }) } }
  const alerts = <T extends { readonly message: string }>(list: ReadonlyArray<T>): T[] => list.map(alert => ({ ...alert, message: renaming.text(alert.message) }))
  const data = einsatzDataSchema.parse(object.packData)
  const packData: UnitData | TaskData = data.type === 'unit'
    ? {
      ...data,
      unitType: renaming.id('type', data.unitType),
      ...(data.side === undefined ? {} : { side: renaming.id('side', data.side) }),
      ...(data.group === undefined ? {} : { group: renaming.id('group', data.group) }),
      presentation: { ...data.presentation, typeLabel: renaming.text(data.presentation.typeLabel) },
      properties: Object.fromEntries(Object.entries(data.properties).map(([key, value]) => [renaming.id('property', key), value])),
      load: mapKeys(data.load, id('class'))!,
      ...(data.received === undefined ? {} : { received: mapKeys(data.received, id('class'))! }),
      // A job-chain step names who gave it as an order does.
      orders: data.orders.map(step => ({ ...step, by: renaming.text(step.by) })),
      ...action(data.lastAction),
      alerts: alerts(data.alerts),
    }
    : {
      ...data,
      template: renaming.id('template', data.template),
      ...(data.side === undefined ? {} : { side: renaming.id('side', data.side) }),
      presentation: { ...data.presentation, typeLabel: renaming.text(data.presentation.typeLabel) },
      loads: mapKeys(data.loads, id('class'))!,
      pickedUp: mapKeys(data.pickedUp, id('class'))!,
      served: mapKeys(data.served, id('service'))!,
      rank: renaming.id('class', data.rank),
      coverage: {
        requirements: data.coverage.requirements.map(entry => ({ ...entry, provides: renaming.id('service', entry.provides) })),
        loads: data.coverage.loads.map(entry => ({ ...entry, classId: renaming.id('class', entry.classId) })),
      },
      ...action(data.lastAction),
      alerts: alerts(data.alerts),
    }
  return { ...object, label: renaming.text(object.label), packData, alerts: object.alerts.map(alert => ({ ...alert, kind: alert.kind, message: renaming.text(alert.message) })) }
}

/** The part of a journaled record that must agree: identity, words, record and position; never wall-clock stamps or command ids. */
const comparable = (object: OperationalObject) => ({
  id: object.id,
  label: object.label,
  lifecycle: object.lifecycle,
  status: object.operational.status,
  point: object.spatial.position?.point,
  packData: object.packData,
  alerts: object.alerts.map(alert => [alert.kind, alert.message]),
})

describe('Renaming generality', () => {
  for (const [name, definition, untilS] of [['civil Halden', civil, cue('late-top-priority').at.seconds + 60], ['supply-run', supplyRun, 720]] as const) {
    test(`${name} and its fully renamed copy journal the same transitions, with the same Board actions and results`, async () => {
      const renaming = renameDefinition(definition)
      const [original, renamed] = [await followed(definition, untilS), await followed(renaming.definition, untilS)]
      expect(JSON.stringify(renaming.definition)).not.toContain((definition.packs[0]!.config.unitTypes[1] as { id: string }).id)
      expect(renamed.journal.length).toBe(original.journal.length)
      expect(renamed.journal.map(comparable)).toEqual(original.journal.map(object => comparable(renamedObject(renaming, object))))
      expect(renamed.actions).toBe(original.actions)
      expect(renamed.results).toEqual(original.results)
      expect(original.results.length).toBeGreaterThan(1)
    }, 60_000)
  }

  test('a sided Run with groups, played by a screen holding its North groups, and its renamed copy journal the same transitions', async () => {
    const definition = definitionOf(groupItems, undefined, groupDeclaration)
    const renaming = renameDefinition(definition)
    const northGroups = groups.filter(group => group.side === 'north').map(group => group.id)
    const [original, renamed] = [
      await followed(definition, 600, undefined, run => roleScreen(run, ...northGroups.map(groupRoleId))),
      await followed(renaming.definition, 600, undefined, run => roleScreen(run, ...northGroups.map(group => groupRoleId(renaming.id('group', group))))),
    ]
    expect(JSON.stringify(renaming.definition)).not.toMatch(/haul|guard|raid|north|south/)
    expect(renamed.journal.map(comparable)).toEqual(original.journal.map(object => comparable(renamedObject(renaming, object))))
    // Each journaled unit names its group and side, renamed in the copy, and the screen's groups gave orders.
    expect(original.journal.some(object => (object.packData as { readonly group?: unknown }).group === 'haul-a')).toBe(true)
    expect(original.journal.some(object => (object.packData as { readonly lastAction?: { readonly by?: unknown } }).lastAction?.by === 'Haulers A, Haulers B and Guards')).toBe(true)
    expect(renamed.actions).toBe(original.actions)
    expect(renamed.results).toEqual(original.results)
    expect(original.results.length).toBeGreaterThan(1)
  }, 60_000)
})
