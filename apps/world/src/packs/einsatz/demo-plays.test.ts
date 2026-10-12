import { describe, expect, test } from 'bun:test'
import { isMapSymbol } from '../../core/map-symbols/catalog.ts'
import atlas from '../../core/map-symbols/common.json'
import { runRolesOf, type ScenarioRolePreset } from '../../core/model/index.ts'
import { compileScenarioDefinition } from '../../core/scenarios/compiler.ts'
import { scenarioDefinitionSchema, type ScenarioDefinition } from '../../core/scenarios/definition.ts'
import { createDirectRoutingAdapter } from '../../routing/direct-adapter.ts'
import emergencyJson from '../../scenarios/halden-emergency.scenario.json'
import supplyJson from '../../scenarios/supply-run.scenario.json'
import { startingZoomFor } from '../../ui/map/map-camera.ts'
import { openRoleDialog, roleDialogModel, togglePreset } from '../../ui/roles/role-dialog.ts'
import { einsatzCommandIds as ids, einsatzQueryIds } from './capabilities.ts'
import { createWall, openScreen, pastGuardMs, roleScreen, runFor, type Screen } from './fixtures/board-harness.ts'
import { addToEndOfNearestBusy, chainBoth, configOf, metresBetween, playDemo, slowedRouting, type Beat, type CallLog, type PlayLog, type Policy } from './fixtures/demo-play.ts'
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
 * router, and again with travel twice and two and a half times as slow, as
 * town roads make it, by a dispatcher who reacts at once, after 30 s and
 * after 60 s. Objectives are judged when the exercise ends, from the Run's
 * state: a call still waiting then has waited until then. Everything is
 * found from the Definitions themselves: cues by id, calls by when a cue made
 * them, units and places by their records.
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
/** What the objective's own words state, so the check and the text cannot drift apart. */
const stated = (definition: Definition, index: number, pattern: RegExp): string => {
  const match = pattern.exec(definition.objectives[index] ?? '')
  if (match === null) throw new Error(`${definition.id} objective ${index} does not state ${pattern}`)
  return match[1]!
}
const statedS = (definition: Definition, index: number, pattern: RegExp): number => Number(stated(definition, index, pattern)) * 60
const minutes = /within (\d+) minutes of the (?:call|request)/
const waitsAtMost = /more than (\d+) minutes/
const classCode = /every (?:top-priority )?\(?(P\d)\)? call/

interface Demo {
  readonly definition: Definition
  /** The good dispatcher's planned moves at the beats. */
  readonly beats: ReadonlyArray<Beat>
  /** Each objective, judged from a play. */
  readonly objectives: (log: PlayLog) => ReadonlyArray<boolean>
  /** The least slack, in seconds, any call has against the objectives that set a response time for every call of a class. */
  readonly slack: (log: PlayLog) => number
  /** The roles one dispatcher holds: the first preset in a Definition with groups. */
  readonly roleIds?: ReadonlyArray<string>
}

const topClass = (definition: Definition): string => configOf(definition).loadClasses[0]!.id
/** The load class an objective names by its code. */
const classNamed = (definition: Definition, index: number): string => {
  const code = stated(definition, index, classCode)
  const found = configOf(definition).loadClasses.find(entry => entry.code === code)
  if (found === undefined) throw new Error(`${definition.id} has no class ${code}`)
  return found.id
}
/** How long a call waited for its first unit, as the Run stands when the exercise ends. */
const waitedS = (definition: Definition, call: CallLog): number => Math.min(call.firstOnSceneS ?? Number.POSITIVE_INFINITY, endOf(definition)) - call.createdS
/** The calls the exercise holds: those a cue made before it ended. */
const inExercise = (definition: Definition, calls: ReadonlyArray<CallLog>): ReadonlyArray<CallLog> => calls.filter(call => call.createdS <= endOf(definition))
const createdBy = (calls: ReadonlyArray<CallLog>, atS: number): CallLog => {
  const found = calls.filter(call => call.createdS === atS)
  if (found.length !== 1) throw new Error(`Expected one call created at ${atS} s, found ${found.length}`)
  return found[0]!
}

const demos: Readonly<Record<'emergency' | 'supply', Demo>> = {
  emergency: {
    definition: emergency,
    beats: [addToEndOfNearestBusy('second fire beside the first', cueAt(emergency, 'harbour-car-fire'))],
    objectives: ({ calls }) => {
      const held = inExercise(emergency, calls)
      return [
        held.filter(call => call.rank === classNamed(emergency, 0)).every(call => waitedS(emergency, call) <= statedS(emergency, 0, minutes)),
        waitedS(emergency, createdBy(held, cueAt(emergency, 'harbour-car-fire'))) <= statedS(emergency, 1, minutes),
        held.filter(call => call.rank === classNamed(emergency, 2)).every(call => waitedS(emergency, call) <= statedS(emergency, 2, minutes)),
      ]
    },
    slack: ({ calls }) => Math.min(...[0, 2].flatMap(index => inExercise(emergency, calls)
      .filter(call => call.rank === classNamed(emergency, index))
      .map(call => statedS(emergency, index, minutes) - waitedS(emergency, call)))),
    roleIds: emergency.rolePresets![0]!.roles,
  },
  supply: {
    definition: supply,
    beats: [
      chainBoth('two requests side by side', cueAt(supply, 'scout-camp-request')),
      addToEndOfNearestBusy('the heavy unit stays home', cueAt(supply, 'harbour-request')),
    ],
    objectives: ({ calls }) => {
      const held = inExercise(supply, calls)
      return [
        held.filter(call => call.rank === topClass(supply)).every(call => waitedS(supply, call) <= statedS(supply, 0, minutes)),
        held.every(call => waitedS(supply, call) <= statedS(supply, 1, waitsAtMost)),
      ]
    },
    slack: ({ calls }) => Math.min(...inExercise(supply, calls).map(call => statedS(supply, 1, waitsAtMost) - waitedS(supply, call))),
  },
}

interface Pace {
  /** Travel this many times as slow as the direct model's straight lines. */
  readonly factor: number
  /** The dispatcher acts this long after each call or beat. */
  readonly reactS: number
}
const play = async (demo: Demo, policy: Policy, pace: Pace = { factor: 1, reactS: 0 }, untilS = endOf(demo.definition)): Promise<PlayLog> => await playDemo({
  definition: demo.definition,
  screens: [{ name: 'dispatcher', ...(demo.roleIds === undefined ? {} : { roleIds: demo.roleIds }), policy }],
  untilS,
  reactS: pace.reactS,
  ...(pace.factor === 1 ? {} : { routing: slowedRouting(pace.factor) }),
})
const good = (demo: Demo): Policy => ({ kind: 'recommendations', beats: demo.beats })
/**
 * Production routes on town roads are unmeasured here: about twice as slow as
 * a straight line at the direct model's speed, so every play also runs at
 * twice and at two and a half times, with a dispatcher who reacts at once,
 * after 30 s and after 60 s, as a person at an iPad does.
 */
const paces: ReadonlyArray<Pace> = [
  ...[1, 2].flatMap(factor => [0, 30, 60].map(reactS => ({ factor, reactS }))),
  { factor: 2.5, reactS: 30 },
]
/** Every call's slack against a per-call objective is at least this in every play. */
const slackS = 3 * 60

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
      const words = [
        definition.title, definition.description, ...definition.objectives, ...items.map(item => item.label),
        ...definition.timeline.cues.flatMap(cue => [cue.title, ...cue.actions.map(action => action.type === 'invoke_capability' ? (action.input as { readonly label?: string }).label ?? '' : action.type === 'show_guidance' ? action.guidance.message : '')]),
      ].join(' ')
      expect(words).not.toMatch(/Norw|Swed|Danish|NATO|Politi|Sykehus|\b11[023]\b|\b[RE]v ?\d|\bE ?\d{1,2}\b/)
      const [, howTo] = definition.description!.split('How to play: ')
      expect(howTo).toBeDefined()
      const sentences = howTo!.split(/(?<=\.) /)
      expect(sentences.length).toBeGreaterThanOrEqual(2)
      expect(sentences.length).toBeLessThanOrEqual(4)
      for (const idiom of [/\btap\b/, /Do now or Add to end/, /\bthe \+ on\b/i]) expect(howTo).toMatch(idiom)
      if (config.groups.length > 0) expect(howTo).toMatch(/groups dialog from the role chip/)
      expect(definition.objectives.length).toBeGreaterThanOrEqual(2)
    })

    test('a call is waiting within a minute, calls keep coming until a few minutes before the end, and it ends between 25 and 35 minutes', () => {
      expect(callTimes[0]).toBeLessThanOrEqual(60)
      expect(callTimes.length).toBeGreaterThanOrEqual(12)
      expect(endOf(definition)).toBeGreaterThanOrEqual(25 * 60)
      expect(endOf(definition)).toBeLessThanOrEqual(35 * 60)
      expect(endOf(definition) - callTimes.at(-1)!).toBeLessThanOrEqual(3 * 60)
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
      // Every call needs a service, or holds load, or both: never a report, which only the Controller could close.
      // Each part must be served by a unit some role holds: in a Definition with groups, by a grouped unit, and
      // under each preset split by a unit of a group one desk of the split holds.
      const tasks = [...items.filter(item => item.type === 'task').map(item => ({ template: item.template!, loads: (item as { readonly loads?: Record<string, number> }).loads })), ...created.filter(entry => entry.capabilityId === ids.taskCreate).map(entry => ({ template: entry.input.template!, loads: entry.input.loads }))]
      const typeOf = (id: string) => config.unitTypes.find(type => type.id === id)!
      const unitsIn = (groups: ReadonlySet<string> | null) => [
        ...items.filter(item => item.type === 'unit' && (groups === null || (item.group !== undefined && groups.has(item.group)))).map(item => typeOf(item.unitType!)),
        // A unit a cue creates joins no group; it counts only in a Definition without groups.
        ...(groups === null ? created.filter(entry => entry.capabilityId === ids.unitCreate).map(entry => typeOf(entry.input.type!)) : []),
      ]
      const servedBy = (task: typeof tasks[number], units: ReturnType<typeof unitsIn>): ReadonlyArray<string> => {
        const template = config.taskTemplates.find(entry => entry.id === task.template)!
        const loads = Object.keys(task.loads ?? {}).filter(classId => (task.loads![classId] ?? 0) > 0)
        return [
          ...(template.requires.length === 0 && loads.length === 0 ? ['a report'] : []),
          ...template.requires.filter(requirement => !units.some(type => type.components.service?.provides.includes(requirement.provides) === true)).map(requirement => requirement.provides),
          ...loads.filter(classId => !units.some(type => type.components.carry?.classes.includes(classId) === true)),
        ]
      }
      const presetGroups = (definition.rolePresets ?? []).map(preset => new Set(preset.roles.flatMap(roleId => config.groups.filter(group => groupRoleId(group.id) === roleId).map(group => group.id))))
      const splits = presetGroups.length < 2 ? [] : presetGroups.slice(1)
      for (const task of tasks) {
        expect([task.template, servedBy(task, unitsIn(config.groups.length === 0 ? null : new Set(config.groups.map(group => group.id))))]).toEqual([task.template, []])
        // Under a split, each part the task needs is served by a group some desk of the split holds.
        if (splits.length > 0) {
          const missing = servedBy(task, unitsIn(new Set(splits.flatMap(groups => [...groups]))))
          expect([task.template, missing]).toEqual([task.template, []])
        }
      }
    })

    for (const pace of paces) {
      test(`a good dispatcher meets every objective with travel ${pace.factor}× as slow, reacting after ${pace.reactS} s, with something to do every 3 minutes until the end and no order refused`, async () => {
        const log = await play(demo, good(demo), pace)
        try {
          expect(demo.objectives(log), describeLog(log)).toEqual(demo.objectives(log).map(() => true))
          if (pace.factor <= 2) expect(demo.slack(log)).toBeGreaterThanOrEqual(slackS)
          expect(log.orders.filter(order => !order.ok)).toEqual([])
          expect(new Set(log.orders.flatMap(order => order.beat === undefined ? [] : [order.beat]))).toEqual(new Set(demo.beats.map(beat => beat.name)))
          // Something to do at least every 3 minutes over the whole exercise: a new call, or an order the dispatcher gives.
          const moments = [...new Set([...log.calls.map(call => call.createdS), ...log.orders.map(order => order.atS), endOf(definition)])].sort((a, b) => a - b)
          expect(Math.max(...moments.slice(1).map((at, index) => at - moments[index]!))).toBeLessThanOrEqual(180)
        } finally {
          await log.run.close()
        }
      }, 60_000)
    }

    test('in a good play every call is served in the end: none is left for the Controller to close', async () => {
      const log = await play(demo, good(demo), { factor: 1, reactS: 0 }, endOf(definition) + 15 * 60)
      try {
        expect(log.calls.filter(call => call.closedS === undefined).map(call => call.label)).toEqual([])
        expect(log.orders.filter(order => !order.ok)).toEqual([])
      } finally {
        await log.run.close()
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
  test('the good play reaches the chest pain before the ankle that arrives with it, diverts the unit on its way to the fallen tree to the fight, and adds the car fire to the end of the chain of the unit busy at the first fire', async () => {
    const log = await play(demos.emergency, good(demos.emergency))
    try {
      // Two calls arrive together; the top-priority one is reached first.
      expect(cueAt(emergency, 'rodsberg-ankle')).toBe(cueAt(emergency, 'fortress-chest-pain'))
      const together = log.calls.filter(call => call.createdS === cueAt(emergency, 'fortress-chest-pain'))
      const [top, other] = [together.filter(call => call.rank === topClass(emergency)), together.filter(call => call.rank !== topClass(emergency))]
      expect([top.length, other.length]).toEqual([1, 1])
      expect(top[0]!.firstOnSceneS!).toBeLessThan(other[0]!.firstOnSceneS!)
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

  test('the groups dialog reads as the Definition\'s categories, each listing its groups, under the presets and the Controller; the first preset ticks every group', async () => {
    const declaration = runRolesOf(await compileScenarioDefinition(emergency, [einsatzPack], { routing: createDirectRoutingAdapter() }))
    if (declaration === null) throw new Error('halden-emergency declares roles')
    const groups = configOf(emergency).groups
    const joining = openRoleDialog(declaration, [], [])
    const model = roleDialogModel(declaration, joining, { mode: 'join', held: [], holders: null })
    const categories = [...new Set(groups.map(group => group.category))]
    expect(model.categories.map(category => [category.label, category.rows.map(row => row.label)]))
      .toEqual(categories.map(category => [category, groups.filter(group => group.category === category).map(group => group.label)]))
    expect(model.presets.map(row => [row.kind, row.label])).toEqual([
      ...emergency.rolePresets!.map(preset => ['preset', preset.label]),
      ['role', emergency.roles![0]!.label],
    ])
    const everything = roleDialogModel(declaration, togglePreset(declaration, joining, emergency.rolePresets![0]!.id), { mode: 'join', held: [], holders: null })
    expect(everything.categories.flatMap(category => category.rows.map(row => row.control))).toEqual(groups.map(() => true))
    expect(everything.canApply).toBe(true)
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
  test('the good play diverts a heavy unit to the first urgent bulk request, gives the two side-by-side requests to one unit in one chain, and adds the guest harbour to the end of a busy unit\'s chain', async () => {
    const log = await play(demos.supply, good(demos.supply))
    try {
      const bulk = createdBy(log.calls, cueAt(supply, 'pumping-station-bulk'))
      const divert = log.orders.find(order => (order.input as { readonly divert?: unknown }).divert !== undefined)
      expect(divert).toMatchObject({ atS: bulk.createdS, input: { to: { taskId: bulk.id } }, ok: true })
      const [chainBeat, homeBeat] = demos.supply.beats
      const chain = log.orders.filter(order => order.beat === chainBeat!.name)
      const pair = log.calls.filter(call => call.createdS === cueAt(supply, 'scout-camp-request')).map(call => call.id)
      expect(pair.length).toBe(2)
      expect(chain.map(order => [order.capabilityId, (order.input as { readonly to: { readonly taskId: string } }).to.taskId, order.ok])).toEqual([[ids.send, pair[0]!, true], [ids.queue, pair[1]!, true]])
      const unitId = (chain[1]!.input as { readonly unitId: string }).unitId
      expect((chain[0]!.input as { readonly units: ReadonlyArray<string> }).units).toEqual([unitId])
      for (const call of log.calls.filter(entry => pair.includes(entry.id))) expect([...call.onScene]).toEqual([unitId])
      // The guest harbour goes to the end of a busy unit's chain, so the free heavy unit stays home.
      const harbour = createdBy(log.calls, cueAt(supply, 'harbour-request'))
      const home = log.orders.filter(order => order.beat === homeBeat!.name)
      expect(home.map(order => [order.capabilityId, (order.input as { readonly to: { readonly taskId: string } }).to.taskId, order.ok])).toEqual([[ids.queue, harbour.id, true]])
    } finally {
      await log.run.close()
    }
  }, 60_000)

  test('a dispatcher who sends the free heavy unit to the guest harbour instead, reacting after a minute, misses the last urgent bulk request', async () => {
    const [chainBeat, homeBeat] = demos.supply.beats
    const log = await play({ ...demos.supply, beats: [chainBeat!] }, { kind: 'recommendations', beats: [chainBeat!] }, { factor: 1, reactS: 60 })
    try {
      expect(log.orders.some(order => order.beat === homeBeat!.name)).toBe(false)
      expect(demos.supply.objectives(log)[0]).toBe(false)
      expect(waitedS(supply, createdBy(log.calls, cueAt(supply, 'community-centre-bulk')))).toBeGreaterThan(statedS(supply, 0, minutes))
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

describe('the pressure moments by Board taps', () => {
  /**
   * Plays the good dispatcher up to a beat, without the beat's own move, then
   * opens a Board on the Run as that dispatcher: the Run as a person would
   * find it when the beat's call arrives.
   */
  const boardAt = async (demo: Demo, atS: number): Promise<{ readonly log: PlayLog; readonly screen: Screen }> => {
    const log = await play(demo, { kind: 'recommendations', beats: demo.beats.filter(beat => beat.atS < atS) }, { factor: 1, reactS: 0 }, atS)
    const actor = demo.roleIds === undefined ? operator : roleScreen(log.run, ...demo.roleIds)
    const screen = await openScreen(log.run, createWall(), { actor })
    await screen.wait(pastGuardMs)
    return { log, screen }
  }
  const optionsOf = (screen: Screen) => screen.view().commit.options.map(entry => entry.option)

  test('halden-emergency car fire, unit first: the engine on scene at the first fire offers only Add to end for the car fire, and Add to end is accepted', async () => {
    const atS = cueAt(emergency, 'harbour-car-fire')
    const firstFire = (log: PlayLog) => createdBy(log.calls, cueAt(emergency, 'guest-harbour-fire'))
    const tap = async (log: PlayLog, screen: Screen): Promise<string> => {
      const [engine] = [...firstFire(log).onScene]
      expect(engine).toBeDefined()
      await screen.mapTap(engine!)
      await screen.mapTap(createdBy(log.calls, atS).id)
      return engine!
    }
    const first = await boardAt(demos.emergency, atS)
    let offered: ReadonlyArray<string>
    try {
      const engine = await tap(first.log, first.screen)
      expect(first.log.run.unit(engine).phase).toBe('on-task')
      expect(emergency.description).toContain(`${first.log.run.object(engine)!.label} is about to finish`)
      expect(first.screen.view().commit).toMatchObject({ state: 'choice', detail: expect.stringContaining(firstFire(first.log).label) })
      offered = optionsOf(first.screen)
      expect(offered).toEqual(['add-to-end'])
    } finally {
      await first.log.run.close()
    }
    // Every option offered is accepted: each is tried on its own replay of the same deterministic play.
    for (const option of offered) {
      const { log, screen } = await boardAt(demos.emergency, atS)
      try {
        const engine = await tap(log, screen)
        await screen.wait(pastGuardMs)
        await screen.click({ kind: 'option', option: option as 'do-now' | 'add-to-end' })
        expect(screen.calls.map(call => [call.capabilityId, call.result])).toEqual([[option === 'add-to-end' ? ids.queue : ids.send, { ok: true }]])
        expect(log.run.unit(engine).orders.map(step => step.state)).toEqual(['active', 'queued'])
      } finally {
        await log.run.close()
      }
    }
  }, 60_000)

  test('supply-run chain, as the description teaches it: tap the unit, then the first request, then the + on the unit and the second; every tap is accepted', async () => {
    const atS = cueAt(supply, 'scout-camp-request')
    const { log, screen } = await boardAt(demos.supply, atS)
    try {
      const [first, second] = log.calls.filter(call => call.createdS === atS)
      const unitId = (await log.run.query<Recommendation>(einsatzQueryIds.recommend, { taskId: first!.id }, operator)).proposal.units[0]!.unitId
      const chosen = log.run.unit(unitId)
      const label = log.run.object(unitId)!.label
      const code = (callLabel: string) => callLabel.split(' ')[0]!
      expect(supply.description).toContain(`tap ${label}, then ${code(first!.label)}, then the + on ${label} and ${code(second!.label)}`)
      // The unit stands free, so the first tap sends it at once.
      expect([chosen.phase, chosen.taskId, chosen.orders.length]).toEqual(['available', undefined, 0])
      await screen.mapTap(unitId)
      await screen.mapTap(first!.id)
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'verb', verb: 'add', id: unitId })
      await screen.mapTap(second!.id)
      expect(screen.calls.map(call => [call.capabilityId, call.input, call.result])).toEqual([
        [ids.send, { units: [unitId], to: { taskId: first!.id } }, { ok: true }],
        [ids.queue, { unitId, to: { taskId: second!.id } }, { ok: true }],
      ])
      expect(log.run.unit(unitId).orders.map(step => step.state)).toEqual(['active', 'queued'])
    } finally {
      await log.run.close()
    }
  }, 60_000)
})
