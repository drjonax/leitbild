import { describe, expect, test } from 'bun:test'
import { isMapSymbol } from '../../core/map-symbols/catalog.ts'
import atlas from '../../core/map-symbols/common.json'
import type { ScenarioRolePreset } from '../../core/model/index.ts'
import { compileScenarioDefinition } from '../../core/scenarios/compiler.ts'
import { scenarioDefinitionSchema, type ScenarioDefinition } from '../../core/scenarios/definition.ts'
import { createDirectRoutingAdapter } from '../../routing/direct-adapter.ts'
import emergencyJson from '../../scenarios/halden-emergency.scenario.json'
import supplyJson from '../../scenarios/supply-run.scenario.json'
import { startingZoomFor } from '../../ui/map/map-camera.ts'
import { einsatzCommandIds as ids, einsatzQueryIds } from './capabilities.ts'
import { createWall, openScreen, pastGuardMs, roleScreen, runFor } from './fixtures/board-harness.ts'
import { addToEndOfNearestBusy, chainViaNearestSite, configOf, metresBetween, playDemo, reachS, slowedRouting, type Beat, type CallLog, type PlayLog, type Policy } from './fixtures/demo-play.ts'
import { openRun, operator } from './fixtures/run-harness.ts'
import { groupRoleId } from './ids.ts'
import { einsatzPack } from './pack.ts'
import type { Recommendation } from './recommendation-schema.ts'
import { boardBottomClearancePx, boardLayoutFor, boardMapCover, boardTopClearancePx } from './ui/board-layout.ts'

/**
 * The demo Definitions every leitbild.app user can start, held to the demo
 * quality bar: words, pacing, the start view on an iPad, objectives that a
 * good dispatcher meets and a passive one does not, groups, icons and no call
 * that nobody but the Controller can close. Plays run headless on the direct
 * router, and again with travel twice as slow, as town roads make it.
 * Everything is found from the Definitions themselves: cues by id, calls by
 * when a cue made them, units and places by their records.
 */

type Definition = ScenarioDefinition & { readonly timeline: NonNullable<ScenarioDefinition['timeline']> }
const parse = (raw: unknown): Definition => scenarioDefinitionSchema.parse(raw) as Definition
const emergency = parse(emergencyJson)
const supply = parse(supplyJson)

const cueAt = (definition: Definition, cueId: string): number => {
  const cue = definition.timeline.cues.find(entry => entry.id === cueId)
  if (cue === undefined) throw new Error(`${definition.id} has no cue ${cueId}`)
  return cue.at.seconds
}
/** The Run second the exercise ends: the last cue, which shows its end. */
const endOf = (definition: Definition): number => Math.max(...definition.timeline.cues.map(cue => cue.at.seconds))
/** A number the objective's own words state, so the check and the text cannot drift apart. */
const stated = (definition: Definition, index: number, pattern: RegExp): number => {
  const match = pattern.exec(definition.objectives[index] ?? '')
  if (match === null) throw new Error(`${definition.id} objective ${index} does not state ${pattern}`)
  return Number(match[1])
}
const minutes = /within (\d+) minutes/
const byClock = /by (\d+):00/

interface Demo {
  readonly definition: Definition
  /** The good dispatcher's planned moves at the beats. */
  readonly beats: ReadonlyArray<Beat>
  /** Each objective, judged from a play. */
  readonly objectives: (log: PlayLog) => ReadonlyArray<boolean>
  /** The roles one dispatcher holds: the first preset in a Definition with groups. */
  readonly roleIds?: ReadonlyArray<string>
}

const topClass = (definition: Definition): string => configOf(definition).loadClasses[0]!.id
const closedBy = (calls: ReadonlyArray<CallLog>, seconds: number): boolean => calls.every(call => call.closedS !== undefined && call.closedS <= seconds)
const createdBy = (calls: ReadonlyArray<CallLog>, atS: number): CallLog => {
  const found = calls.filter(call => call.createdS === atS)
  if (found.length !== 1) throw new Error(`Expected one call created at ${atS} s, found ${found.length}`)
  return found[0]!
}

const demos: Readonly<Record<'emergency' | 'supply', Demo>> = {
  emergency: {
    definition: emergency,
    beats: [addToEndOfNearestBusy('second fire beside the first', cueAt(emergency, 'harbour-car-fire'))],
    objectives: ({ calls }) => [
      calls.filter(call => call.rank === topClass(emergency)).every(call => reachS(call) <= stated(emergency, 0, minutes) * 60),
      reachS(createdBy(calls, cueAt(emergency, 'harbour-car-fire'))) <= stated(emergency, 1, minutes) * 60,
      closedBy(calls, stated(emergency, 2, byClock) * 60),
    ],
    roleIds: emergency.rolePresets![0]!.roles,
  },
  supply: {
    definition: supply,
    beats: [chainViaNearestSite('two requests side by side', cueAt(supply, 'scout-camp-request'))],
    objectives: ({ calls }) => [
      calls.filter(call => call.rank === topClass(supply)).every(call => reachS(call) <= stated(supply, 0, minutes) * 60),
      closedBy(calls, stated(supply, 1, byClock) * 60),
    ],
  },
}

const play = async (demo: Demo, policy: Policy, factor = 1): Promise<PlayLog> => await playDemo({
  definition: demo.definition,
  screens: [{ name: 'dispatcher', ...(demo.roleIds === undefined ? {} : { roleIds: demo.roleIds }), policy }],
  untilS: endOf(demo.definition),
  ...(factor === 1 ? {} : { routing: slowedRouting(factor) }),
})
const good = (demo: Demo): Policy => ({ kind: 'recommendations', beats: demo.beats })
/** Production routes on town roads: about twice as slow as a straight line at the direct model's speed. */
const roadFactor = 2

const describeLog = (log: PlayLog): string => JSON.stringify({
  orders: log.orders.map(order => [order.atS, order.capabilityId, order.input, order.ok ? 'ok' : order.reason]),
  calls: log.calls.map(call => [call.label, call.createdS, call.firstOnSceneS, call.closedS]),
})

for (const demo of Object.values(demos)) {
  const { definition } = demo
  const config = configOf(definition)
  const items = definition.packs[0]!.items as unknown as ReadonlyArray<{ readonly type: string; readonly id: string; readonly label: string; readonly position: readonly [number, number]; readonly unitType?: string; readonly template?: string; readonly group?: string }>
  const created = definition.timeline.cues.flatMap(cue => cue.actions.flatMap(action =>
    action.type === 'invoke_capability' && (action.capabilityId === ids.taskCreate || action.capabilityId === ids.unitCreate)
      ? [{ atS: cue.at.seconds, capabilityId: action.capabilityId, input: action.input as { readonly template?: string; readonly type?: string; readonly at: { readonly coordinates: readonly [number, number] }; readonly loads?: Record<string, number> } }]
      : []))
  const callTimes = [...items.filter(item => item.type === 'task').map(() => 0), ...created.filter(entry => entry.capabilityId === ids.taskCreate).map(entry => entry.atS)].sort((a, b) => a - b)

  describe(`${definition.id} as a demo`, () => {
    test('its title and description say what it is: fictional, without national markings, ending in a short How to play in the touch idiom', () => {
      expect(definition.title.length).toBeLessThanOrEqual(40)
      expect(definition.description).toMatch(/\bfictional\b/)
      expect(`${definition.title} ${definition.description}`).not.toMatch(/Norw|Swed|Danish|NATO|Politi|Sykehus|\b11[023]\b/)
      const [, howTo] = definition.description!.split('How to play: ')
      expect(howTo).toBeDefined()
      const sentences = howTo!.split(/(?<=\.) /)
      expect(sentences.length).toBeGreaterThanOrEqual(2)
      expect(sentences.length).toBeLessThanOrEqual(4)
      for (const idiom of ['tap', 'Do now or Add to end', 'The + on']) expect(howTo).toContain(idiom)
      if (config.groups.length > 0) expect(howTo).toMatch(/groups dialog from the role chip/)
      expect(definition.objectives.length).toBeGreaterThanOrEqual(2)
    })

    test('a call is waiting within a minute, calls keep coming, and it ends between 25 and 35 minutes', () => {
      expect(callTimes[0]).toBeLessThanOrEqual(60)
      expect(callTimes.length).toBeGreaterThanOrEqual(12)
      expect(endOf(definition)).toBeGreaterThanOrEqual(25 * 60)
      expect(endOf(definition)).toBeLessThanOrEqual(35 * 60)
      expect(endOf(definition) - callTimes.at(-1)!).toBeLessThanOrEqual(11 * 60)
    })

    test('on a 1024 × 768 iPad in landscape every object stands in the map the Board leaves clear at the starting fit, and units start a short drive from every call', () => {
      // The browser and World chrome take about 120 px of the screen's height; the Board takes its width on the right.
      const surface = { width: 1024, height: 768 - 120 }
      const cover = boardMapCover(boardLayoutFor(surface.width, 'work-list').widthPx)
      const zoom = startingZoomFor(definition.view.map.zoom, surface, cover)
      const worldPx = 512 * 2 ** zoom
      const project = ([lon, lat]: readonly [number, number]): [number, number] => [
        (lon + 180) / 360 * worldPx,
        (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2 * worldPx,
      ]
      const clearWidth = surface.width - cover.right
      const [centreX, centreY] = project(definition.view.map.center)
      const positions = [...items.map(item => item.position), ...created.map(entry => entry.input.at.coordinates)]
      for (const position of positions) {
        const [x, y] = project(position)
        const left = x - (centreX - clearWidth / 2)
        const top = y - (centreY - surface.height / 2)
        // An icon is 23 px; keep it whole and clear of the role bar and the status line.
        expect(Math.min(left, clearWidth - left)).toBeGreaterThanOrEqual(24)
        expect(Math.min(top - boardTopClearancePx, surface.height - boardBottomClearancePx - top)).toBeGreaterThanOrEqual(24)
      }
      const mobile = new Set(config.unitTypes.filter(type => type.components.mobility !== undefined).map(type => type.id))
      const starts = [...items.filter(item => item.type === 'unit' && mobile.has(item.unitType!)).map(item => item.position), ...created.filter(entry => entry.capabilityId === ids.unitCreate).map(entry => entry.input.at.coordinates)]
      const calls = [...items.filter(item => item.type === 'task').map(item => item.position), ...created.filter(entry => entry.capabilityId === ids.taskCreate).map(entry => entry.input.at.coordinates)]
      for (const call of calls) expect(Math.min(...starts.map(start => metresBetween(start, call)))).toBeLessThanOrEqual(3_000)
    })

    test('its icons are catalogue symbols and no call is one that only the Controller could close', async () => {
      for (const entry of [...config.unitTypes, ...config.taskTemplates]) expect(isMapSymbol(entry.icon)).toBe(true)
      const compiled = await compileScenarioDefinition(definition, [einsatzPack], { routing: createDirectRoutingAdapter() })
      expect(compiled.id).toBe(definition.id)
      // Every call's template needs a service a unit provides, or the call holds load a unit carries: never a report.
      const tasks = [...items.filter(item => item.type === 'task').map(item => ({ template: item.template!, loads: (item as { readonly loads?: Record<string, number> }).loads })), ...created.filter(entry => entry.capabilityId === ids.taskCreate).map(entry => ({ template: entry.input.template!, loads: entry.input.loads }))]
      for (const task of tasks) {
        const template = config.taskTemplates.find(entry => entry.id === task.template)!
        const served = template.requires.length > 0 || Object.keys(task.loads ?? {}).length > 0
        expect([task.template, served]).toEqual([task.template, true])
        const able = config.unitTypes.filter(type => template.requires.every(requirement => type.components.service?.provides.includes(requirement.provides) === true)
          || Object.keys(task.loads ?? {}).every(classId => type.components.carry?.classes.includes(classId) === true))
        // In a Definition with groups, a unit of that type sits in a group, so a group's role queues the call.
        const grouped = config.groups.length === 0 || items.some(item => item.type === 'unit' && able.some(type => type.id === item.unitType) && item.group !== undefined)
        expect([task.template, able.length > 0, grouped]).toEqual([task.template, true, true])
      }
    })

    test('a good dispatcher meets every objective, on straight lines and on roads twice as slow, and no order it gives is refused', async () => {
      for (const factor of [1, roadFactor]) {
        const log = await play(demo, good(demo), factor)
        try {
          expect([factor, ...demo.objectives(log)], describeLog(log)).toEqual([factor, ...demo.objectives(log).map(() => true)])
          expect(log.orders.filter(order => !order.ok)).toEqual([])
          expect(log.orders.some(order => order.beat !== undefined)).toBe(true)
          // Something to do at least every 3 minutes until the last call: a new call, or an order the dispatcher gives.
          const moments = [...new Set([...log.calls.map(call => call.createdS), ...log.orders.map(order => order.atS)])].sort((a, b) => a - b)
            .filter(at => at <= callTimes.at(-1)!)
          expect([factor, Math.max(...moments.slice(1).map((at, index) => at - moments[index]!)) <= 180]).toEqual([factor, true])
          // Every call closes: none is left to the Controller.
          expect(log.calls.every(call => call.closedS !== undefined)).toBe(true)
        } finally {
          await log.run.close()
        }
      }
    }, 60_000)

    test('a dispatcher who does nothing fails an objective, and one who only follows recommendations without the beat\'s move fails one too', async () => {
      for (const policy of [{ kind: 'nothing' } as const, { kind: 'recommendations', beats: [] } as const]) {
        const log = await play(demo, policy)
        try {
          expect([policy.kind, demo.objectives(log).every(Boolean)]).toEqual([policy.kind, false])
          expect(log.orders.filter(order => !order.ok)).toEqual([])
        } finally {
          await log.run.close()
        }
      }
    }, 60_000)

    test('plays are deterministic: the same policy gives the same orders and the same call times', async () => {
      const [first, second] = [await play(demo, good(demo)), await play(demo, good(demo))]
      try {
        expect(describeLog(second)).toBe(describeLog(first))
      } finally {
        await first.run.close()
        await second.run.close()
      }
    }, 60_000)
  })
}

describe('halden-emergency pressure moments and desks', () => {
  test('the good play diverts the unit on its way to the fallen tree to the fight, and adds the car fire to the end of the chain of the unit busy at the first fire', async () => {
    const log = await play(demos.emergency, good(demos.emergency))
    try {
      const fight = createdBy(log.calls, cueAt(emergency, 'torget-fight'))
      const tree = createdBy(log.calls, cueAt(emergency, 'tree-on-road'))
      const divert = log.orders.find(order => order.capabilityId === ids.send && (order.input as { readonly divert?: ReadonlyArray<{ readonly fromTaskId: string }> }).divert !== undefined)
      expect(divert?.input).toMatchObject({ to: { taskId: fight.id }, divert: [{ fromTaskId: tree.id }] })
      expect(divert?.atS).toBe(fight.createdS)
      const carFire = createdBy(log.calls, cueAt(emergency, 'harbour-car-fire'))
      const queued = log.orders.filter(order => order.beat !== undefined)
      expect(queued.map(order => [order.capabilityId, (order.input as { readonly to: unknown }).to])).toEqual([[ids.queue, { taskId: carFire.id }]])
      // The unit it was added to stood on scene at the first fire, then at the car fire.
      const unitId = (queued[0]!.input as { readonly unitId: string }).unitId
      expect(createdBy(log.calls, cueAt(emergency, 'guest-harbour-fire')).onScene.has(unitId)).toBe(true)
      expect(carFire.onScene.has(unitId)).toBe(true)
    } finally {
      await log.run.close()
    }
  }, 60_000)

  test('the groups replace operator roles: a Controller, one role per group with a category, the whole side first among the presets, then a two-desk split', async () => {
    const compiled = await compileScenarioDefinition(emergency, [einsatzPack], { routing: createDirectRoutingAdapter() })
    const groups = configOf(emergency).groups
    expect((emergency.roles ?? []).map(role => role.class)).toEqual(['controller'])
    expect(compiled.roles?.filter(role => role.class === 'operator').map(role => [role.id, role.category !== undefined])).toEqual(groups.map(group => [groupRoleId(group.id), true]))
    const presets: ReadonlyArray<ScenarioRolePreset> = compiled.rolePresets ?? []
    const all = groups.map(group => groupRoleId(group.id))
    expect(presets[0]?.roles).toEqual(all)
    expect(presets[0]?.label).toMatch(/one dispatcher/)
    const [desk, other] = [presets[1]!.roles, presets[2]!.roles]
    expect([...desk, ...other].sort()).toEqual([...all].sort())
    expect(desk.filter(roleId => other.includes(roleId))).toEqual([])
    expect(new Set(groups.map(group => group.category)).size).toBeGreaterThan(1)
    // Every unit that is not a public place is in exactly one group.
    const publicTypes = new Set(configOf(emergency).unitTypes.filter(type => type.public).map(type => type.id))
    for (const item of emergency.packs[0]!.items as ReadonlyArray<{ readonly type: string; readonly unitType?: string; readonly group?: string }>) {
      if (item.type === 'unit') expect([item.unitType, item.group !== undefined]).toEqual([item.unitType, !publicTypes.has(item.unitType!)])
    }
  })

  test('two dispatchers, one at each desk, also meet every objective, each ordering only its own groups\' units', async () => {
    const [desk, other] = [emergency.rolePresets![1]!, emergency.rolePresets![2]!]
    const log = await playDemo({
      definition: emergency,
      screens: [
        { name: desk.id, roleIds: desk.roles, policy: { kind: 'recommendations', beats: [] } },
        // The second desk commands the unit busy at the first fire, so it takes the beat.
        { name: other.id, roleIds: other.roles, policy: good(demos.emergency) },
      ],
      untilS: endOf(emergency),
    })
    try {
      expect(demos.emergency.objectives(log)).toEqual(demos.emergency.objectives(log).map(() => true))
      expect(log.orders.filter(order => !order.ok)).toEqual([])
      expect(new Set(log.orders.map(order => order.screen))).toEqual(new Set([desk.id, other.id]))
    } finally {
      await log.run.close()
    }
  }, 60_000)

  test('a desk is refused another desk\'s unit, naming the group that commands it, and queues only the calls its units serve', async () => {
    const run = await openRun({ definition: emergency, paused: true })
    try {
      const [desk, other] = [emergency.rolePresets![1]!, emergency.rolePresets![2]!]
      const deskScreen = roleScreen(run, ...desk.roles)
      const otherScreen = roleScreen(run, ...other.roles)
      const groups = configOf(emergency).groups
      const firstCall = (emergency.packs[0]!.items as ReadonlyArray<{ readonly type: string; readonly id: string }>).find(item => item.type === 'task')!
      // The call waiting at the start holds load only the first desk's units carry.
      const answer = await run.query<Recommendation>(einsatzQueryIds.recommend, { taskId: firstCall.id }, deskScreen)
      expect(answer.proposal.units.length).toBe(1)
      const refused = await run.refusal(ids.send, { units: [answer.proposal.units[0]!.unitId], to: { taskId: firstCall.id } }, otherScreen)
      const owner = groups.find(group => desk.roles.includes(groupRoleId(group.id)) && refused.reason.includes(group.label))
      expect([refused.code, owner !== undefined]).toEqual(['unit_not_authorized', true])
      const queued = await run.query(einsatzQueryIds.recommend, { taskId: firstCall.id }, otherScreen).then(() => 'answered', (error: Error) => error.message)
      expect(queued).toStartWith('task_not_in_role_queue')
    } finally {
      await run.close()
    }
  })
})

describe('supply-run pressure moments', () => {
  test('the good play diverts the heavy unit to the urgent bulk request, and chains a place and the two side-by-side requests on one unit', async () => {
    const log = await play(demos.supply, good(demos.supply))
    try {
      const bulk = createdBy(log.calls, cueAt(supply, 'pumping-station-bulk'))
      const divert = log.orders.find(order => (order.input as { readonly divert?: unknown }).divert !== undefined)
      expect(divert).toMatchObject({ atS: bulk.createdS, input: { to: { taskId: bulk.id } }, ok: true })
      const chain = log.orders.filter(order => order.beat !== undefined)
      const pair = log.calls.filter(call => call.createdS === cueAt(supply, 'scout-camp-request')).map(call => call.id)
      expect(chain.map(order => [order.capabilityId, Object.keys((order.input as { readonly to: object }).to)[0], order.ok])).toEqual([[ids.queue, 'siteId', true], [ids.queue, 'taskId', true], [ids.queue, 'taskId', true]])
      expect(chain.slice(1).map(order => (order.input as { readonly to: { readonly taskId: string } }).to.taskId)).toEqual(pair)
      const unitId = (chain[0]!.input as { readonly unitId: string }).unitId
      expect(chain.every(order => (order.input as { readonly unitId: string }).unitId === unitId)).toBe(true)
      for (const call of log.calls.filter(entry => pair.includes(entry.id))) expect([...call.onScene]).toEqual([unitId])
    } finally {
      await log.run.close()
    }
  }, 60_000)

  test('the one moving type and the request icons are ones the operational atlas has never drawn: the openness the description claims', () => {
    const config = configOf(supply)
    const mobile = config.unitTypes.filter(type => type.components.mobility !== undefined)
    expect(mobile.length).toBe(1)
    for (const icon of [...mobile.map(type => type.icon), ...config.taskTemplates.map(template => template.icon)]) expect(Object.keys(atlas)).not.toContain(icon)
  })
})

describe('the first two minutes on the Board, by taps', () => {
  /** Taps a call's row, waits out the guard, then taps the action button: the call-first idiom, 2 taps. */
  const dispatchByTaps = async (definition: Definition, roleIds: ReadonlyArray<string> | undefined, script: ReadonlyArray<number>) => {
    const run = await openRun({ definition })
    try {
      const actor = roleIds === undefined ? operator : roleScreen(run, ...roleIds)
      const screen = await openScreen(run, createWall(), { actor })
      const startMs = run.nowMs()
      for (const atS of script) {
        await runFor(run, startMs + atS * 1_000 - run.nowMs(), [screen])
        await screen.wait(pastGuardMs)
        // The top unserved call: the one the Board lists first.
        const row = screen.view().workList.rows.find(entry => !entry.served)
        expect(row).toBeDefined()
        const expected = await run.query<Recommendation>(einsatzQueryIds.recommend, { taskId: row!.id }, actor)
        screen.resetActions()
        await screen.click({ kind: 'row', list: 'work', id: row!.id })
        await screen.wait(pastGuardMs)
        await screen.click({ kind: 'commit' })
        expect(screen.actions()).toBe(2)
        expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.send, input: { units: expected.proposal.units.map(unit => unit.unitId), to: { taskId: row!.id } }, result: { ok: true } })
      }
      expect(screen.calls.every(call => call.result.ok)).toBe(true)
      return screen.calls.length
    } finally {
      await run.close()
    }
  }

  test('halden-emergency, all desks: the call waiting at the start and the crash at 0:40 are each dispatched in 2 taps', async () => {
    expect(await dispatchByTaps(emergency, emergency.rolePresets![0]!.roles, [0, cueAt(emergency, 'busterud-crash')])).toBe(2)
  })

  test('supply-run: the two requests waiting at the start are each sent in 2 taps', async () => {
    expect(await dispatchByTaps(supply, undefined, [0, 1])).toBe(2)
  })
})
