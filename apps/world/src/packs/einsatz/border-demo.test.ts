import { describe, expect, test } from 'bun:test'
import type { ScenarioDefinition } from '../../core/scenarios/definition.ts'
import { startingZoomFor } from '../../ui/map/map-camera.ts'
import { borderConfig, borderDefinitions, borderStart, groupOf, isScout, isShooter, sideTypes, timelineOf, unitsWhere } from './fixtures/border-harness.ts'
import { addToEnd, askThenAddToEnd, commandIds, playDemo, slowedRouting, unitVerb, type Beat, type DemoContext, type DemoOutcome, type RedOrder } from './fixtures/border-demo.ts'
import { unitTypeOf } from './engine/model.ts'
import { boardBottomClearancePx, boardEdgeGapPx, boardLayoutFor, boardTopClearancePx } from './ui/board-layout.ts'

/**
 * halden-border as a demo, played headless on a real Run with every Blue
 * order tapped on the Board of the first preset's screen. The good
 * dispatcher sends each call's first recommendation as it arrives and gives
 * the three orders the beats call for; a Blue that does nothing taps nothing.
 * The objectives are judged from the Run's state, on the direct router and
 * on slowed routers standing in for road timings.
 */

const definition = borderDefinitions.scripted
const [blue, red] = (definition.sides ?? []).map(side => side.id) as [string, string]
const start = borderStart(definition)
const cue = (id: string) => definition.timeline!.cues.find(entry => entry.id === id)!
const cueInput = (id: string) => cue(id).actions[0]!.type === 'invoke_capability' ? (cue(id).actions[0] as { readonly input: { readonly label?: string; readonly template?: string; readonly loads?: Readonly<Record<string, number>>; readonly at?: { readonly coordinates: readonly [number, number] } } }).input : {}
const cueLabel = (id: string): string => cueInput(id).label!
const cueS = (id: string): number => cue(id).at.seconds
const [scout] = unitsWhere(start, blue, isScout)
/** The run second by which the first objective wants every call closed: the end of the exercise. */
const deadlineS = 30 * 60
/** A Blue group whose units serve the template a cue's call names. */
const groupServing = (cueId: string): string => {
  const template = start.catalog.templates.get(cueInput(cueId).template!)!
  const type = borderConfig(definition).unitTypes.find(entry => sideTypes(definition, blue).has(entry.id)
    && template.requires.some(requirement => entry.components.service?.provides.includes(requirement.provides) === true))!
  return groupOf(definition, blue, type.id)
}

/** The busy unit that provides what a call requires and is furthest on with its task: on scene before under way. */
const busyServer = (context: DemoContext, taskId: string): string => {
  const task = context.tasks().find(entry => entry.id === taskId)!
  const needed = start.catalog.templates.get(task.template)!.requires.map(requirement => requirement.provides)
  const candidates = context.units().filter(unit => unit.side === blue && unit.taskId !== undefined
    && unitTypeOf(start.catalog, unit).components.service?.provides.some(service => needed.includes(service)) === true)
  const onScene = candidates.find(unit => unit.phase === 'on-task') ?? candidates[0]
  if (onScene === undefined) throw new Error(`No busy unit can take ${task.label} next`)
  return onScene.id
}

/** The beats a good Blue plays besides the recommendations. */
const goodBeats: ReadonlyArray<Beat> = [
  // Red pushes onto the screen post: pull the scout back before it is overrun (2 taps).
  { atS: cueS('red-push-1'), name: 'pull the scout back', group: groupOf(definition, blue, scout!.unitType), act: async ({ screen, units }) => {
    if (units().find(unit => unit.id === scout!.id)?.integrity !== 'destroyed') await unitVerb(screen, scout!.id, 'recall')
  } },
  // Two calls, no free unit: the second waits at the end of the busy unit's chain (2 taps).
  { atS: cueS('call-11'), name: 'add to the end of a chain', group: groupServing('call-11'), act: async context => {
    const taskId = context.cueTask('call-11').id
    await addToEnd(context.screen, busyServer(context, taskId), taskId)
  } },
  // The only unit that serves the call is on scene elsewhere: Add to end, not Do now (3 taps).
  { atS: cueS('call-12'), name: 'do now or add to end', group: groupServing('call-12'), act: async context => {
    const taskId = context.cueTask('call-12').id
    await askThenAddToEnd(context.screen, busyServer(context, taskId), taskId)
  } },
]

const untilS = deadlineS + 60
const blueWatchers = ['civil-desks', 'blue-military']
type PlayName = 'good' | 'again' | 'idle' | 'recommendations' | 'road-1.4' | 'road-1.5'
const plays = new Map<string, Promise<DemoOutcome>>()
const played = (name: PlayName): Promise<DemoOutcome> => {
  const known = plays.get(name)
  if (known !== undefined) return known
  const factor = name === 'road-1.4' ? 1.4 : name === 'road-1.5' ? 1.5 : undefined
  const outcome = playDemo({
    definition, untilS,
    dispatch: name !== 'idle',
    beats: name === 'idle' || name === 'recommendations' ? [] : goodBeats,
    watchers: name === 'idle' ? [] : blueWatchers,
    ...(factor === undefined ? {} : { routing: slowedRouting(factor) }),
  })
  plays.set(name, outcome)
  return outcome
}

/** The four objectives, each judged from the play's record of the Run. */
const objectives = (outcome: DemoOutcome) => {
  const blueCalls = [...outcome.sides].filter(([, side]) => side === blue).map(([label]) => label)
  const late = cueLabel('call-17')
  return {
    everyCallClosed: blueCalls.every(label => (outcome.closedAtS.get(label) ?? Number.POSITIVE_INFINITY) <= deadlineS),
    lateCallReached: (outcome.closedAtS.get(late) ?? Number.POSITIVE_INFINITY) <= cueS('call-17') + 6 * 60,
    identifiedBeforePush: (outcome.firstShooterIdentifiedS ?? Number.POSITIVE_INFINITY) < cueS('red-push-1'),
    heldObjective: outcome.stepsLost[red]! >= 4 && outcome.stepsLost[blue]! < 2,
  }
}

/** The longest stretch, in Run seconds, in which a preset had nothing new to decide, from the start to the deadline. */
const longestWait = (times: ReadonlyArray<number>): { readonly seconds: number; readonly from: number } => {
  const seen = [...new Set([0, ...times.filter(atS => atS <= deadlineS), deadlineS])].sort((a, b) => a - b)
  return seen.slice(1).map((atS, index) => ({ seconds: atS - seen[index]!, from: seen[index]! })).sort((a, b) => b.seconds - a.seconds)[0]!
}

/** Every task a play left open, with no non-destroyed unit of its side that serves it. */
const deadTasks = (outcome: DemoOutcome) => outcome.openAtEnd.filter(task => task.servers === 0)

describe('halden-border demo plays', () => {
  test('the objectives say what the plays judge: every call closed by 30:00, C-17 reached within six minutes', () => {
    expect(definition.objectives[0]).toContain('30:00')
    expect(definition.objectives[1]).toContain(cueLabel('call-17').split(' ').slice(0, 2).join(' '))
    expect(definition.objectives[1]).toContain('six minutes')
    expect(cueInput('call-17').loads).toEqual({ P1: 1 })
  })

  test('the good dispatcher meets every objective, and no recommended action or beat is ever refused', async () => {
    const outcome = await played('good')
    expect(objectives(outcome)).toEqual({ everyCallClosed: true, lateCallReached: true, identifiedBeforePush: true, heldObjective: true })
    expect(outcome.calls.filter(call => !call.result.ok)).toEqual([])
  }, 120_000)

  for (const name of ['road-1.4', 'road-1.5'] as const) {
    test(`on a router ${name.slice(5)} times as long and slow as the straight line, as roads are, the good dispatcher still meets every objective`, async () => {
      const outcome = await played(name)
      expect(objectives(outcome)).toEqual({ everyCallClosed: true, lateCallReached: true, identifiedBeforePush: true, heldObjective: true })
      expect(outcome.calls.filter(call => !call.result.ok)).toEqual([])
    }, 120_000)
  }

  test('a Blue that does nothing fails objectives: the decisions matter', async () => {
    const outcome = await played('idle')
    const met = objectives(outcome)
    expect(met.everyCallClosed).toBe(false)
    expect(met.identifiedBeforePush).toBe(false)
    expect(met.heldObjective).toBe(false)
  }, 120_000)

  test('plays are deterministic', async () => {
    expect((await played('again')).digest).toBe((await played('good')).digest)
  }, 240_000)

  test('the first contact comes within a minute and the first call within one, and every task of the good play is closed by its end', async () => {
    const outcome = await played('good')
    expect(outcome.firstTrackS).toBeLessThanOrEqual(60)
    expect(Math.min(...[...outcome.createdAtS].filter(([label]) => outcome.sides.get(label) === blue && label.startsWith('C-')).map(([, atS]) => atS))).toBeLessThanOrEqual(60)
    expect([...outcome.createdAtS.keys()].filter(label => !outcome.closedAtS.has(label))).toEqual([])
  }, 120_000)

  test('a dispatcher who only follows the recommendations leaves no task that no unit of its side could serve', async () => {
    const outcome = await played('recommendations')
    expect(deadTasks(outcome)).toEqual([])
  }, 120_000)

  test('the good play has its pressure moments: an Add to end for two calls and no free car, a Do now or Add to end, and the civil and military halves busy at once', async () => {
    const outcome = await played('good')
    const queued = outcome.calls.filter(call => call.capabilityId.endsWith('.unit.queue'))
    expect(queued.map(call => call.atS)).toEqual([cueS('call-11'), cueS('call-12')])
    // Between Red's push and the end of the burst, both halves of the one-person screen act.
    const window = outcome.calls.filter(call => call.atS >= cueS('red-push-1') && call.atS <= cueS('call-12'))
    expect(window.some(call => call.capabilityId.endsWith('.unit.recall'))).toBe(true)
    expect(window.filter(call => call.capabilityId.endsWith('.unit.send')).length).toBeGreaterThanOrEqual(4)
  }, 120_000)

  test('the fighting reaches the civil desks: a top-priority call beside Objective KNUT arrives in the burst, as Red attacks, and a carrier reaches it', async () => {
    const outcome = await played('good')
    const farm = cueInput('call-9')
    const knut = (definition.packs[0]!.items.find(item => item.id === 'site:knut') as unknown as { readonly position: readonly [number, number] }).position
    const [east, north] = farm.at!.coordinates
    const distanceM = Math.hypot((east - knut[0]) * 111_320 * Math.cos(north * Math.PI / 180), (north - knut[1]) * 110_540)
    expect(distanceM).toBeLessThan(1_000)
    expect(farm.loads).toEqual({ P1: 1 })
    expect(cueS('call-9')).toBeGreaterThanOrEqual(cueS('red-attack-1'))
    expect(cueS('call-9')).toBeLessThan(cueS('call-12'))
    expect(outcome.closedAtS.get(cueLabel('call-9'))).toBeLessThanOrEqual(deadlineS)
  }, 120_000)

  test('each Blue unit that arrives by cue is the first recommendation for the call that comes with it, and serves it', async () => {
    const outcome = await played('good')
    const arrivals = timelineOf(definition).filter(order => order.capabilityId === commandIds.unitCreate && (order.input as { readonly side: string }).side === blue)
    const serves = (typeId: string, templateId: string) => start.catalog.templates.get(templateId)!.requires
      .some(requirement => borderConfig(definition).unitTypes.find(type => type.id === typeId)!.components.service?.provides.includes(requirement.provides) === true)
    // A call that comes with an arrival: one its type serves, in the same half minute.
    const withCall = arrivals.flatMap(arrival => {
      const call = timelineOf(definition).find(order => order.capabilityId === commandIds.taskCreate && order.atS >= arrival.atS && order.atS <= arrival.atS + 30
        && (order.input as { readonly side: string }).side === blue && serves((arrival.input as { readonly type: string }).type, (order.input as { readonly template: string }).template))
      return call === undefined ? [] : [{ unit: (arrival.input as { readonly label: string }).label, call: (call.input as { readonly label: string }).label }]
    })
    expect(withCall.length).toBeGreaterThanOrEqual(2)
    for (const { unit, call } of withCall) {
      const sent = outcome.calls.find(entry => entry.capabilityId === commandIds.send && (entry.input as { readonly to?: { readonly taskId?: string } }).to?.taskId === outcome.taskIds.get(call))
      expect([call, (sent?.input as { readonly units?: ReadonlyArray<string> } | undefined)?.units]).toEqual([call, [outcome.unitIds.get(unit)!]])
      expect(outcome.closedAtS.has(call)).toBe(true)
    }
  }, 120_000)

  test('each preset has something new to decide at least every three and a half minutes until the deadline: a newly unserved call, or a beat for one of its groups', async () => {
    for (const name of ['good', 'road-1.5'] as const) {
      const outcome = await played(name)
      expect(Object.keys(outcome.decisions).sort()).toEqual([definition.rolePresets![0]!.id, ...blueWatchers].sort())
      for (const [preset, times] of Object.entries(outcome.decisions)) {
        const wait = longestWait(times)
        expect([name, preset, wait.seconds <= 210 ? 'ok' : `waits ${wait.seconds} s from ${wait.from} s`]).toEqual([name, preset, 'ok'])
      }
    }
  }, 120_000)

  test('a unit that serves each call can reach it within eight minutes from where the units stand when it comes in, and Blue\'s within five', async () => {
    const outcome = await played('good')
    for (const [label, seconds] of outcome.reachS) expect([label, seconds <= 5 * 60 ? 'ok' : `${seconds} s`]).toEqual([label, 'ok'])
  }, 120_000)
})

const definitions = [borderDefinitions.scripted, borderDefinitions.humanRed] as const
const configOf = (source: ScenarioDefinition) => borderConfig(source)

/** Every point a Definition places or names: its items' positions and every point its cues name. */
const pointsOf = (source: ScenarioDefinition): ReadonlyArray<{ readonly name: string; readonly lonLat: readonly [number, number] }> => {
  const found: Array<{ name: string; lonLat: readonly [number, number] }> = []
  const walk = (value: unknown, name: string): void => {
    if (Array.isArray(value)) return value.forEach(entry => walk(entry, name))
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (record.type === 'Point' && Array.isArray(record.coordinates)) found.push({ name, lonLat: record.coordinates as [number, number] })
    for (const entry of Object.values(record)) walk(entry, name)
  }
  for (const item of source.packs[0]!.items) {
    const placed = item as unknown as { readonly id: string; readonly position: readonly [number, number] }
    found.push({ name: placed.id, lonLat: placed.position })
  }
  for (const entry of source.timeline?.cues ?? []) walk(entry.actions, entry.id)
  return found
}

/** Web Mercator pixels at a zoom, as MapLibre lays out its 512 px tiles. */
const project = (lonLat: readonly [number, number], zoom: number): readonly [number, number] => {
  const size = 512 * 2 ** zoom
  const latitude = lonLat[1] * Math.PI / 180
  return [(lonLat[0] + 180) / 360 * size, (1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2 * size]
}

/** The tasks a side can be given: placed, created by a cue, or created by a standing order of a type its groups hold. */
const sideTasks = (source: ScenarioDefinition, side: string): ReadonlyArray<{ readonly template: string; readonly classes: ReadonlyArray<string>; readonly name: string }> => {
  const config = configOf(source)
  const placed = source.packs[0]!.items.flatMap(item => {
    const task = item as { readonly type: string; readonly id: string; readonly side?: string; readonly template?: string; readonly loads?: Readonly<Record<string, number>> }
    return task.type === 'task' && task.side === side ? [{ template: task.template!, classes: Object.keys(task.loads ?? {}), name: task.id }] : []
  })
  const cued = timelineOf(source).flatMap(order => {
    const input = order.input as { readonly side?: string; readonly template?: string; readonly loads?: Readonly<Record<string, number>>; readonly label?: string }
    return order.capabilityId === commandIds.taskCreate && input.side === side ? [{ template: input.template!, classes: Object.keys(input.loads ?? {}), name: input.label! }] : []
  })
  const reported = config.unitTypes.filter(type => sideTypes(source, side).has(type.id) && type.standingOrders?.onStepLost !== undefined)
    .map(type => ({ template: type.standingOrders!.onStepLost!.createTask, classes: Object.keys(type.standingOrders!.onStepLost!.perStep), name: `${type.label} step lost` }))
  return [...placed, ...cued, ...reported]
}

describe('halden-border Definitions as demos', () => {
  test('each says what it is, that it is fictional, and ends with a short How to play in the touch idiom that names its presets', () => {
    for (const source of definitions) {
      expect(source.title.length).toBeGreaterThan(0)
      const description = source.description!
      expect(description).toMatch(/fictional/i)
      expect(description).toMatch(/no national markings/i)
      const how = description.slice(description.indexOf('How to play:'))
      expect(how.length).toBeGreaterThan('How to play:'.length)
      const sentences = how.split(/(?<=\.)\s+/)
      expect(sentences.length).toBeGreaterThanOrEqual(2)
      expect(sentences.length).toBeLessThanOrEqual(4)
      for (const preset of source.rolePresets ?? []) expect(how).toContain(`"${preset.label}"`)
      expect(how).toContain('role chip')
      expect(how).toMatch(/\bTap\b/)
      expect(how).toContain('+ on')
      expect(how).toContain(configOf(source).lexicon.send!)
      expect(source.objectives.length).toBeGreaterThanOrEqual(3)
    }
  })

  test('the scripted exercise says Red is not for players there, and its Red groups say they are scripted', () => {
    const description = definition.description!
    expect(description).toContain('Red is scripted here')
    expect(description).toContain(`"${borderDefinitions.humanRed.title}"`)
    expect(configOf(definition).groups.filter(group => group.side === red).every(group => group.label.endsWith('(scripted)'))).toBe(true)
    expect(configOf(borderDefinitions.humanRed).groups.some(group => group.label.includes('scripted'))).toBe(false)
  })

  test('no two units and no two calls of a Definition share a label, so each side names its own', () => {
    for (const source of definitions) {
      for (const [kind, create] of [['unit', commandIds.unitCreate], ['task', commandIds.taskCreate]] as const) {
        const labels = [
          ...source.packs[0]!.items.filter(item => (item as { readonly type: string }).type === kind).map(item => item.label),
          ...timelineOf(source).filter(order => order.capabilityId === create).map(order => (order.input as { readonly label: string }).label),
        ]
        expect([source.id, kind, labels.filter((label, index) => labels.indexOf(label) !== index)]).toEqual([source.id, kind, []])
      }
    }
  })

  test('the presets after the one-person bundle split Blue by the categories its groups read under in the groups dialog', () => {
    for (const source of definitions) {
      const groupsOf = (category: string) => configOf(source).groups.filter(group => group.side === blue && group.category === category).map(group => `group:${group.id}`)
      const categories = [...new Set(configOf(source).groups.filter(group => group.side === blue).map(group => group.category))]
      expect(categories.length).toBe(2)
      const [, first, second] = source.rolePresets!
      expect([first!.roles, second!.roles]).toEqual(categories.map(groupsOf))
      expect((source.roles ?? []).filter(role => role.class === 'controller').length).toBe(1)
    }
  })

  test('no task, placed, cued or reported, is one that no group of its side can serve', () => {
    for (const source of definitions) {
      const config = configOf(source)
      for (const side of [blue, red]) {
        const held = config.unitTypes.filter(type => sideTypes(source, side).has(type.id))
        for (const task of sideTasks(source, side)) {
          const template = config.taskTemplates.find(entry => entry.id === task.template)!
          const served = held.some(type => template.requires.some(requirement => type.components.service?.provides.includes(requirement.provides) === true)
            || type.components.carry?.classes.some(carried => task.classes.includes(carried)) === true)
          expect([source.id, side, task.name, served]).toEqual([source.id, side, task.name, true])
        }
      }
    }
  })

  test('at the starting camera every object and every place a cue names lies beside the Board on an iPad in landscape', () => {
    // 1024 × 768 less the Host's workspace bar and the browser's own bars; the role bar and status line lie over the map's top and bottom.
    const surface = { width: 1024, height: 640 }
    const margin = 16
    for (const source of definitions) {
      for (const lead of ['work-list', 'map'] as const) {
        const board = boardLayoutFor(surface.width, lead)
        const padding = { top: 0, right: board.widthPx + boardEdgeGapPx, bottom: 0, left: 0 }
        const zoom = startingZoomFor(source.view.map.zoom, surface, padding)
        const centre = project(source.view.map.center, zoom)
        for (const point of pointsOf(source)) {
          const [x, y] = project(point.lonLat, zoom)
          const left = board.mapWidthPx / 2 + x - centre[0]
          const top = surface.height / 2 + y - centre[1]
          const inside = left >= margin && left <= board.mapWidthPx - margin && top >= boardTopClearancePx + margin && top <= surface.height - boardBottomClearancePx - margin
          expect([source.id, lead, point.name, inside]).toEqual([source.id, lead, point.name, true])
        }
      }
    }
  })
})

/** Red's cautious plan, given on Red's own roles: the scripted column's moves to its ambush and onto the heights. */
const scriptedRedMoves = (): ReadonlyArray<RedOrder> => timelineOf(definition)
  .filter(order => order.capabilityId === commandIds.send && (order.input as { readonly units: ReadonlyArray<string> }).units.every(unitId => start.units.get(unitId)?.side === red))
  .map(order => ({ atS: order.atS, capabilityId: order.capabilityId, input: order.input }))

describe('halden-border with Red played by a person', () => {
  const human = borderDefinitions.humanRed
  const humanStart = borderStart(human)
  const redTask = (template: (requirement: string) => boolean) => [...humanStart.tasks.values()].find(task => task.side === red
    && humanStart.catalog.templates.get(task.template)!.requires.some(requirement => template(requirement.provides)))!
  const shooters = unitsWhere(humanStart, red, isShooter).map(unit => unit.id)
  const scouts = unitsWhere(humanStart, red, isScout).map(unit => unit.id)
  const shooterService = unitTypeOf(humanStart.catalog, humanStart.units.get(shooters[0]!)!).components.service!.provides[0]!
  const attack = redTask(provides => provides === shooterService)
  const scouting = redTask(provides => provides !== shooterService)
  const knut = attack.point.coordinates
  const send = (atS: number, units: ReadonlyArray<string>, to: unknown): RedOrder => ({ atS, capabilityId: commandIds.send, input: { units, to } })
  const besideKnut = (east: number) => ({ point: { type: 'Point', coordinates: [knut[0] + east, knut[1] - 0.001] } })
  const attackers = humanStart.catalog.templates.get(attack.template)!.requires[0]!.count

  /** The cautious plan: the scripted column's moves to its ambush and the heights, then the attack as Red's own call. */
  const cautious: ReadonlyArray<RedOrder> = [
    ...scriptedRedMoves().filter(order => order.atS < cueS('red-attack-1')),
    send(cueS('red-attack-1'), shooters.slice(0, attackers), { taskId: attack.id }),
  ]
  /** All in at once: the scout to its call, a shooter to the attack and the rest beside KNUT; at 9:00 a healthy free shooter joins the attack. */
  const rush: ReadonlyArray<RedOrder> = [
    send(30, scouts, { taskId: scouting.id }),
    send(30, shooters.slice(0, attackers), { taskId: attack.id }),
    ...shooters.slice(attackers, 4).map((unitId, index) => send(30, [unitId], besideKnut([-0.0006, 0.0006, 0.004][index]!))),
    { atS: 540, capabilityId: commandIds.send, input: ({ units }: DemoContext) => ({
      units: units().filter(unit => shooters.includes(unit.id) && unit.integrity === 'healthy' && unit.taskId === undefined).map(unit => unit.id).slice(0, attackers),
      to: { taskId: attack.id },
    }) },
  ]
  const humanPlays = new Map<string, Promise<DemoOutcome>>()
  const humanPlay = (name: 'cautious' | 'rush' | 'calls'): Promise<DemoOutcome> => {
    const known = humanPlays.get(name)
    if (known !== undefined) return known
    const outcome = playDemo({
      definition: human, untilS: deadlineS, dispatch: true, beats: goodBeats,
      red: name === 'cautious' ? cautious : name === 'rush' ? rush : [],
      redDispatch: name === 'calls',
      watchers: [...blueWatchers, human.rolePresets!.at(-1)!.id],
    })
    humanPlays.set(name, outcome)
    return outcome
  }

  test('Red\'s calls start close enough to reach in a few minutes: Red begins on the border road and its attack is a call from the start', () => {
    expect(human.rolePresets!.at(-1)!.roles.every(role => configOf(human).groups.some(group => `group:${group.id}` === role && group.side === red))).toBe(true)
    expect(attack.closedAtMs).toBeUndefined()
    expect(attackers).toBe(1)
  })

  test('a cautious Red that waits in ambush and then attacks loses its column to Blue\'s good play, and KNUT holds', async () => {
    const outcome = await humanPlay('cautious')
    expect(outcome.closedAtS.has(attack.label)).toBe(false)
    expect(outcome.stepsLost[red]!).toBeGreaterThan(outcome.stepsLost[blue]!)
    // The plan's later orders to a unit Blue has destroyed are refused as such.
    expect(outcome.redRefusals.filter(reason => !reason.includes('unit_unavailable'))).toEqual([])
    expect(outcome.calls.filter(call => !call.result.ok)).toEqual([])
  }, 120_000)

  test('a Red that goes all in at once catches Blue moving up, takes KNUT and loses fewer steps: Red\'s choices decide', async () => {
    const outcome = await humanPlay('rush')
    expect(outcome.closedAtS.get(attack.label)).toBeLessThan(20 * 60)
    expect(outcome.stepsLost[red]!).toBeLessThan(outcome.stepsLost[blue]!)
    expect(outcome.redRefusals).toEqual([])
    expect(outcome.calls.filter(call => !call.result.ok)).toEqual([])
  }, 120_000)

  test('a Red that sends each call\'s first recommendation as it comes is never refused, and loses more steps than Blue', async () => {
    const outcome = await humanPlay('calls')
    expect(outcome.redCalls.length).toBeGreaterThan(5)
    expect(outcome.redCalls.filter(call => !call.result.ok)).toEqual([])
    expect(outcome.calls.filter(call => !call.result.ok)).toEqual([])
    expect(outcome.stepsLost[red]!).toBeGreaterThan(outcome.stepsLost[blue]!)
  }, 120_000)

  test('no Blue task is left open without a non-destroyed unit of its side to serve it, and a side that keeps its force can serve every call it gets', async () => {
    for (const name of ['cautious', 'rush', 'calls'] as const) expect([name, deadTasks(await humanPlay(name)).filter(task => task.side === blue)]).toEqual([name, []])
    // Both sides keep a force against a cautious Red: every call of either side comes in with a unit to serve it, and none is left without one.
    const cautiousPlay = await humanPlay('cautious')
    expect([...cautiousPlay.reachS].filter(([, seconds]) => !Number.isFinite(seconds)).map(([label]) => label)).toEqual([])
    expect(deadTasks(cautiousPlay)).toEqual([])
    // A side wiped out of a kind of unit has lost: the rush leaves Blue's military calls waiting for the reinforcement at 24:00, the Red that follows every call loses its shooters with their calls open.
    expect(deadTasks(await humanPlay('rush'))).toEqual([])
  }, 240_000)

  test('Red has something new to decide at least every three and a half minutes until the deadline, and every Red call can be reached within eight minutes', async () => {
    const redPreset = human.rolePresets!.at(-1)!.id
    for (const name of ['cautious', 'rush', 'calls'] as const) {
      const wait = longestWait((await humanPlay(name)).decisions[redPreset]!)
      expect([name, wait.seconds <= 210 ? 'ok' : `waits ${wait.seconds} s from ${wait.from} s`]).toEqual([name, 'ok'])
    }
    const outcome = await humanPlay('calls')
    const redCalls = [...outcome.reachS].filter(([label]) => outcome.sides.get(label) === red)
    expect(redCalls.length).toBeGreaterThan(8)
    for (const [label, seconds] of redCalls) expect([label, seconds <= 8 * 60 ? 'ok' : `${seconds} s`]).toEqual([label, 'ok'])
  }, 240_000)
})
