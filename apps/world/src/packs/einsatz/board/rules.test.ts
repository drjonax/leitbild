import { describe, expect, test } from 'bun:test'
import { dirname, join, relative } from 'node:path'
import { roleClassForRoleSet, scenarioRoleSchema, seesForRoleSet, type OperationalObject } from '../../../core/model/index.ts'
import { scenarioDefinitionSchema } from '../../../core/scenarios/definition.ts'
import { sideViewOfSnapshot } from '../../../core/simulation-runs/side-view.ts'
import { einsatzCommandIds } from '../capabilities.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { assignedTo, loadAllocation, residualNeed, roleViewFor } from '../engine/coverage.ts'
import { createCatalog, einsatzDataSchema, emptyEngineState, type EngineState, type TaskRecord, type UnitRecord } from '../engine/model.ts'
import { divertablePhases, hasLoad, isDestroyed, isFree } from '../engine/rules.ts'
import { createWall, follow, openScreen, roleScreen } from '../fixtures/board-harness.ts'
import { types as groupUnitTypes } from '../fixtures/engine-harness.ts'
import { groupConfig, groupDeclaration, groupItems } from '../fixtures/groups-run.ts'
import border from '../fixtures/halden-border.scenario.json'
import civil from '../fixtures/halden-civil.scenario.json'
import roles from '../fixtures/halden-civil-roles.scenario.json'
import { lonLat, openRun, screenOf } from '../fixtures/run-harness.ts'
import { groupRoleId } from '../ids.ts'
import { openModeViewer, type PictureViewer } from '../picture.ts'
import type { Recommendation } from '../recommendation-schema.ts'
import { commandsUnit, inPicture, openViewer, queuesTask, type EinsatzViewer } from '../viewer.ts'
import { boardQueryIds } from './calls.ts'
import { intentOf } from './keymap.ts'
import { readBoardRecords } from './records.ts'
import { boardGroupUnitTypes, createBoardRules, loadShareOf } from './rules.ts'
import { workEntries } from './work-list.ts'

/**
 * The Board restates a few engine rules because the engine cannot run in the
 * browser. These tests hold the restatement equal to the engine on real Runs,
 * and keep the engine out of the Board's import graph.
 */

const startMs = Date.parse(civil.world.startsAt)
const roleConfig = einsatzConfigSchema.parse(roles.packs[0]!.config)

const engineRecords = (objects: ReadonlyArray<OperationalObject>) => {
  const units: UnitRecord[] = []
  const tasks: TaskRecord[] = []
  for (const object of objects) {
    if (object.packId !== 'einsatz') continue
    // A side's tracks and the track indexes are no units or tasks.
    const type = (object.packData as { readonly type?: unknown }).type
    if (type === 'track' || type === 'track-index') continue
    const data = einsatzDataSchema.parse(object.packData)
    if (data.type === 'unit') units.push({ ...data, id: object.id, label: object.label })
    else tasks.push({ ...data, id: object.id, label: object.label })
  }
  return { units, tasks }
}

describe('Board rules agree with the engine', () => {
  test('need and rank of every queued task, and each assigned unit\'s share of its load, match the engine all through a followed civil Run', async () => {
    const run = await openRun({ definition: civil })
    try {
      const screen = await openScreen(run, createWall())
      const config = einsatzConfigSchema.parse(civil.packs[0]!.config)
      const rules = createBoardRules(config, openModeViewer, () => [])
      const catalog = createCatalog(config)
      let compared = 0
      const shares = { all: 0, multiClass: 0, twoLoads: 0 }
      for (let step = 1; step <= 26 * 6; step++) {
        await follow(run, screen, { untilMs: startMs + step * 10_000, stepMs: 10_000 })
        const objects = run.run.snapshot().objects
        const records = readBoardRecords(objects)
        if (step % 6 === 0) {
          for (const entry of workEntries(rules, records)) {
            const answer = await run.query<Recommendation>(boardQueryIds.recommend, { taskId: entry.task.id })
            expect([entry.task.id, entry.need ?? null, entry.task.rank]).toEqual([entry.task.id, answer.need?.id ?? null, answer.rank.id])
            compared += 1
          }
        }
        const engine = engineRecords(objects)
        for (const task of engine.tasks.filter(entry => entry.closedAtMs === undefined)) {
          const assigned = assignedTo(engine.units, task)
          const allocation = loadAllocation(catalog, task, assigned)
          for (const unit of assigned) {
            const share = loadShareOf(rules, records, records.tasks.get(task.id)!, unit.id)
            expect([task.id, unit.id, share]).toEqual([task.id, unit.id, allocation.get(unit.id) ?? {}])
            if (Object.keys(share).length === 0) continue
            shares.all += 1
            if (Object.keys(task.loads).length > 1) shares.multiClass += 1
            if (Object.values(share).reduce((sum, count) => sum + count, 0) > 1) shares.twoLoads += 1
          }
        }
      }
      expect(compared).toBeGreaterThan(50)
      // A carrier holding part of a multi-class task's load, and the two-load carrier holding two, were both compared.
      expect([shares.multiClass > 0, shares.twoLoads > 0]).toEqual([true, true])
    } finally {
      await run.close()
    }
  }, 90_000)

  test('picture, commandable set and queue match the engine\'s for every role of the role Definition, and for a side picture', async () => {
    const run = await openRun({ definition: civil, paused: true })
    try {
      const objects = run.run.snapshot().objects
      const engine = engineRecords(objects)
      const board = readBoardRecords(objects)
      const catalog = createCatalog(roleConfig)
      const declared = roles.roles.map(role => scenarioRoleSchema.parse(role))
      const operators = declared.filter(role => role.class === 'operator')
      // One viewer per role set: the engine reads it over its records, the Board over the records it parsed from the same objects.
      const seats: ReadonlyArray<readonly [EinsatzViewer, PictureViewer]> = [
        [openViewer, openModeViewer],
        ...declared.map(role => { const viewer: EinsatzViewer = { class: role.class, sees: 'all', roles: [role] }; return [viewer, viewer] as const }),
        ...[{ class: 'operator', sees: 'all', roles: operators } as const, { class: 'operator', sees: ['north'], roles: [operators[0]!] } as const].map(viewer => [viewer, viewer] as const),
      ]
      for (const [viewer, seat] of seats) {
        const rules = createBoardRules(roleConfig, seat, boardGroupUnitTypes(() => board))
        for (const unit of engine.units) {
          const mine = board.units.get(unit.id)!
          expect([unit.id, rules.inPicture(mine), rules.commands(mine)]).toEqual([unit.id, inPicture(catalog, viewer, unit), commandsUnit(catalog, viewer, unit)])
        }
        for (const task of engine.tasks) {
          const mine = board.tasks.get(task.id)!
          expect([task.id, rules.inPicture(mine), rules.queues(mine)]).toEqual([task.id, inPicture(catalog, viewer, task), queuesTask({ catalog, units: new Map(engine.units.map(unit => [unit.id, unit])) }, viewer, task)])
        }
      }
    } finally {
      await run.close()
    }
  })

  test('on halden-border in play, each side role, a set of two roles of one side, one of opposing sides and the Controller view, need, queue and class units for dispatch as the engine does', async () => {
    const run = await openRun({ definition: border })
    try {
      const declaration = run.run.roles()!
      const config = einsatzConfigSchema.parse(border.packs[0]!.config)
      const catalog = createCatalog(config)
      const [first, second] = declaration.sides!.map(side => side.id) as [string, string]
      const sideRoles = (side: string) => declaration.roles.filter(role => role.class === 'operator' && role.sees !== 'all' && role.sees?.includes(side) === true)
      const controller = declaration.roles.find(role => role.class === 'controller')!
      const seats: ReadonlyArray<ReadonlyArray<string>> = [
        ...[...sideRoles(first), ...sideRoles(second)].map(role => [role.id]),
        sideRoles(first).slice(0, 2).map(role => role.id),
        [sideRoles(first)[0]!.id, sideRoles(second)[0]!.id],
        [controller.id],
      ]
      const viewerOf = (roleIds: ReadonlyArray<string>): EinsatzViewer => ({
        class: roleClassForRoleSet(declaration, roleIds),
        sees: seesForRoleSet(declaration, roleIds),
        roles: declaration.roles.filter(role => roleIds.includes(role.id)),
      })
      // The first side's whole screen follows the recommendations, so units turn out, travel, serve and carry while the other side moves on its cues.
      const screen = await openScreen(run, createWall(), { actor: roleScreen(run, ...sideRoles(first).map(role => role.id)) })
      /** How the engine's own predicates class a unit for dispatch: the states a recommendation depends on besides positions. */
      const engineClass = (state: EngineState, unit: UnitRecord): string => {
        if (isDestroyed(unit)) return 'destroyed'
        if (hasLoad(unit)) return 'loaded'
        if (isFree(unit)) return 'free'
        if (!divertablePhases.includes(unit.phase)) return `busy:${unit.taskId}`
        return `divertable:${unit.taskId}:${state.tasks.get(unit.taskId!)!.rank}`
      }
      const sorted = (values: ReadonlySet<string>): string[] => [...values].sort()
      const classes = new Set<string>()
      let needs = 0
      for (let minute = 1; minute <= 16; minute++) {
        await follow(run, screen, { untilMs: Date.parse(border.world.startsAt) + minute * 60_000, stepMs: 10_000 })
        const snapshot = run.run.snapshot()
        const engine = engineRecords(snapshot.objects)
        const state: EngineState = {
          ...emptyEngineState({ config, sides: [first, second], timeMs: run.nowMs() }),
          units: new Map(engine.units.map(unit => [unit.id, unit])),
          tasks: new Map(engine.tasks.map(task => [task.id, task])),
        }
        for (const roleIds of seats) {
          const viewer = viewerOf(roleIds)
          // The Board reads only what the seat's screen holds.
          const board = readBoardRecords(viewer.sees === 'all' ? snapshot.objects : sideViewOfSnapshot(snapshot, viewer.sees).objects)
          const rules = createBoardRules(config, viewer, boardGroupUnitTypes(() => board))
          const seat = roleIds.join('+')
          for (const task of board.tasks.values()) {
            const truth = state.tasks.get(task.id)!
            expect([seat, task.id, rules.inPicture(task), rules.queues(task)]).toEqual([seat, task.id, inPicture(catalog, viewer, truth), queuesTask(state, viewer, truth)])
            if (!rules.queues(task) || task.closedAtMs !== undefined) continue
            const view = rules.roleView(board, task)
            const engineView = roleViewFor(state, unit => commandsUnit(catalog, viewer, unit), truth)
            expect([seat, task.id, sorted(view.provides), sorted(view.carries)]).toEqual([seat, task.id, sorted(engineView.provides), sorted(engineView.carries)])
            expect([seat, task.id, rules.needFor(task, view) ?? null]).toEqual([seat, task.id, residualNeed(state, truth, engineView, []) ?? null])
            needs += 1
          }
          for (const unit of board.units.values()) {
            const truth = state.units.get(unit.id)!
            expect([seat, unit.id, rules.inPicture(unit), rules.commands(unit)]).toEqual([seat, unit.id, inPicture(catalog, viewer, truth), commandsUnit(catalog, viewer, truth)])
            if (!rules.commands(unit)) continue
            const shown = rules.dispatchClass(board, unit)
            expect([seat, unit.id, shown]).toEqual([seat, unit.id, engineClass(state, truth)])
            classes.add(shown.split(':')[0]!)
          }
        }
      }
      expect(needs).toBeGreaterThan(100)
      expect([...classes].sort()).toEqual(expect.arrayContaining(['busy', 'divertable', 'free', 'loaded']))
    } finally {
      await run.close()
    }
  }, 120_000)
})

describe('Board rules agree with the engine for group roles', () => {
  test('seats holding one group role, two of one side, groups of both sides, and a group role beside a declared role picture, command and queue as the engine does while the groups\' units change', async () => {
    const run = await openRun({ items: groupItems, declared: groupDeclaration })
    try {
      const declaration = run.run.roles()!
      const config = einsatzConfigSchema.parse(groupConfig)
      const catalog = createCatalog(config)
      const control = screenOf(groupDeclaration, 'control')
      const seats: ReadonlyArray<ReadonlyArray<string>> = [
        [groupRoleId('haul-a')],
        [groupRoleId('guards')],
        [groupRoleId('raid')],
        [groupRoleId('haul-a'), groupRoleId('haul-b')],
        [groupRoleId('haul-a'), groupRoleId('raid')],
        ['north-desk', groupRoleId('haul-b')],
        ['north-desk', groupRoleId('guards')],
      ]
      const viewerOf = (roleIds: ReadonlyArray<string>): EinsatzViewer => ({
        class: roleClassForRoleSet(declaration, roleIds),
        sees: seesForRoleSet(declaration, roleIds),
        roles: declaration.roles.filter(role => roleIds.includes(role.id)),
      })
      const queued = new Set<string>()
      const compare = (): void => {
        const snapshot = run.run.snapshot()
        const engine = engineRecords(snapshot.objects)
        const state: EngineState = {
          ...emptyEngineState({ config, sides: declaration.sides!.map(side => side.id), timeMs: run.nowMs() }),
          units: new Map(engine.units.map(unit => [unit.id, unit])),
          tasks: new Map(engine.tasks.map(task => [task.id, task])),
        }
        for (const roleIds of seats) {
          const viewer = viewerOf(roleIds)
          const seat = roleIds.join('+')
          // The Board reads only what the seat's screen holds, and counts its groups' unit types from those records.
          const board = readBoardRecords(viewer.sees === 'all' ? snapshot.objects : sideViewOfSnapshot(snapshot, viewer.sees).objects)
          const rules = createBoardRules(config, viewer, boardGroupUnitTypes(() => board))
          for (const unit of board.units.values()) {
            const truth = state.units.get(unit.id)!
            expect([seat, unit.id, rules.inPicture(unit), rules.commands(unit)]).toEqual([seat, unit.id, inPicture(catalog, viewer, truth), commandsUnit(catalog, viewer, truth)])
          }
          for (const task of board.tasks.values()) {
            const truth = state.tasks.get(task.id)!
            expect([seat, task.id, rules.inPicture(task), rules.queues(task)]).toEqual([seat, task.id, inPicture(catalog, viewer, truth), queuesTask(state, viewer, truth)])
            if (!rules.queues(task) || task.closedAtMs !== undefined) continue
            queued.add(`${seat}:${task.id}`)
            const view = rules.roleView(board, task)
            const engineView = roleViewFor(state, unit => commandsUnit(catalog, viewer, unit), truth)
            expect([seat, task.id, [...view.provides].sort(), [...view.carries].sort()]).toEqual([seat, task.id, [...engineView.provides].sort(), [...engineView.carries].sort()])
            expect([seat, task.id, rules.needFor(task, view) ?? null]).toEqual([seat, task.id, residualNeed(state, truth, engineView, []) ?? null])
          }
        }
      }
      compare()
      expect(await run.invoke(einsatzCommandIds.send, { units: ['a1'], to: { taskId: 'load' } }, control)).toMatchObject({ ok: true })
      expect(await run.invoke(einsatzCommandIds.send, { units: ['g1'], to: { taskId: 'pair' } }, control)).toMatchObject({ ok: true })
      // A carrier joins the guards, whose queue then holds the carriage task too.
      expect(await run.invoke(einsatzCommandIds.unitCreate, { type: groupUnitTypes.roadCarrier, side: 'north', group: 'guards', at: { type: 'Point', coordinates: lonLat(0.005) }, label: 'Spare' }, control)).toMatchObject({ ok: true })
      for (let minute = 0; minute < 6; minute++) {
        compare()
        run.forward(60_000)
        await run.settle()
      }
      compare()
      // Each group's own queue was compared: carriers queue the carriage task, the guards the pairing, and then the carriage task as well.
      expect([...queued].filter(entry => ['group:haul-a:load', 'group:guards:pair', 'group:guards:load', 'north-desk+group:haul-b:note'].includes(entry)).sort())
        .toEqual(['group:guards:load', 'group:guards:pair', 'group:haul-a:load', 'north-desk+group:haul-b:note'])
    } finally {
      await run.close()
    }
  })
})

describe('Board module boundary', () => {
  const boardDir = import.meta.dir
  const valueImports = (source: string): string[] =>
    [...source.matchAll(/^import\s+(?!type\s)[^'"]*?from\s+'([^']+)'|^import\s+'([^']+)'/gm)].map(match => match[1] ?? match[2]!)

  test('the Board controller reaches no engine module, no Capability module and no icon catalogue, so the browser never loads them', async () => {
    const seen = new Set<string>()
    const visit = async (file: string): Promise<void> => {
      if (seen.has(file)) return
      seen.add(file)
      const source = await Bun.file(file).text()
      for (const specifier of valueImports(source)) {
        if (!specifier.startsWith('.')) continue
        await visit(join(dirname(file), specifier))
      }
    }
    await visit(join(boardDir, 'controller.ts'))
    const reached = [...seen].map(file => relative(join(boardDir, '..'), file)).sort()
    expect(reached.filter(file => /^engine\/|^capabilities\.ts$|^config-validation\.ts$|^config-references\.ts$|map-symbols\/catalog/.test(file))).toEqual([])
    expect(reached).toContain('board/records.ts')
  })
})

describe('Board keymap', () => {
  test('every key of the dispatcher keymap maps to its intent, letters with or without Caps Lock', () => {
    const expected: ReadonlyArray<readonly [string, Exclude<NonNullable<ReturnType<typeof intentOf>>['kind'], 'alternative'>]> = [
      ['ArrowUp', 'up'], ['k', 'up'], ['K', 'up'], ['ArrowDown', 'down'], ['j', 'down'], ['J', 'down'],
      ['n', 'urgent'], ['N', 'urgent'], ['Home', 'urgent'], ['[', 'switch'], [']', 'switch'], ['F6', 'switch'],
      ['Enter', 'commit'], ['r', 'recall'], ['R', 'recall'], ['h', 'hold'], ['H', 'hold'], ['m', 'move'], ['M', 'move'],
      ['c', 'close'], ['C', 'close'], ['Escape', 'cancel'],
    ]
    for (const [key, kind] of expected) expect([key, intentOf(key, false)]).toEqual([key, { kind }])
    for (let number = 1; number <= 9; number++) expect(intentOf(String(number), false)).toEqual({ kind: 'alternative', number })
    for (const key of ['x', 'Tab', 'constructor', '0']) expect(intentOf(key, false)).toBeUndefined()
  })

  test('Shift keeps a letter apart from its plain meaning; digits and named keys ignore Shift', () => {
    for (const key of ['N', 'n', 'E', 'R']) expect([key, intentOf(key, true)]).toEqual([key, undefined])
    expect([intentOf('1', true), intentOf('Enter', true), intentOf('ArrowDown', true)]).toEqual([{ kind: 'alternative', number: 1 }, { kind: 'commit' }, { kind: 'down' }])
  })
})

describe('Board role Definition', () => {
  test('is the civil Definition with roles and authority added, and every authority names a declared operator role', () => {
    const parsed = scenarioDefinitionSchema.parse(roles)
    const { roles: declared, packs, id: _id, title: _title, description: _description, ...rest } = roles
    const { packs: civilPacks, id: _civilId, title: _civilTitle, description: _civilDescription, ...civilRest } = civil
    expect(rest).toEqual(civilRest)
    const { authority, ...config } = packs[0]!.config
    expect([{ ...packs[0]!, config }]).toEqual(civilPacks)
    expect(new Set(authority.map(entry => entry.roleId))).toEqual(new Set(declared.filter(role => role.class === 'operator').map(role => role.id)))
    expect(parsed.sides).toBeUndefined()
  })
})

describe('Board arrangement', () => {
  test('roles with a queue lead with the work list; roles commanding only sensing units lead with the map; mixed roles show both; sensing roles get Contacts', () => {
    const config = einsatzConfigSchema.parse({
      loadClasses: [{ id: 'c1', label: 'One', code: 'C1', noun: { one: 'item', other: 'items' } }],
      unitTypes: [
        { id: 'watcher', label: 'Watcher', icon: 'eye', components: { mobility: { mode: 'road' }, sensor: { detectM: 1_000, identifyM: 500 } } },
        { id: 'mover', label: 'Mover', icon: 'car', components: { mobility: { mode: 'road' }, carry: { capacity: 1, classes: ['c1'] } } },
      ],
      taskTemplates: [{ id: 'job', label: 'Job', icon: 'package' }],
      authority: [
        { roleId: 'watch', units: { types: ['watcher'] }, taskTemplates: [] },
        { roleId: 'haul', units: { types: ['mover'] }, taskTemplates: ['job'] },
        { roleId: 'both', units: { all: true }, taskTemplates: ['job'] },
      ],
    })
    const arrangement = (viewer: PictureViewer) => createBoardRules(config, viewer, () => []).arrangement
    const operator = (roleId: string): PictureViewer => ({ class: 'operator', sees: 'all', roles: [{ id: roleId, class: 'operator' }] })
    expect(arrangement(operator('watch'))).toEqual({ lead: 'map', workList: false, unitBoard: true, contacts: true })
    expect(arrangement(operator('haul'))).toEqual({ lead: 'work-list', workList: true, unitBoard: true, contacts: false })
    expect(arrangement(operator('both'))).toEqual({ lead: 'work-list', workList: true, unitBoard: true, contacts: true })
    expect(arrangement({ class: 'operator', sees: 'all', roles: [{ id: 'watch', class: 'operator' }, { id: 'haul', class: 'operator' }] })).toEqual({ lead: 'work-list', workList: true, unitBoard: true, contacts: true })
    expect(arrangement(openModeViewer)).toEqual({ lead: 'work-list', workList: true, unitBoard: true, contacts: true })
    expect(createBoardRules(einsatzConfigSchema.parse(civil.packs[0]!.config), openModeViewer, () => []).arrangement).toEqual({ lead: 'work-list', workList: true, unitBoard: true, contacts: false })
  })
})
