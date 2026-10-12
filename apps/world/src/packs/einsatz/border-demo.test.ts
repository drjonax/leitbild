import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat } from '../../core/model/index.ts'
import type { ScenarioDefinition } from '../../core/scenarios/definition.ts'
import { startingZoomFor } from '../../ui/map/map-camera.ts'
import { borderConfig, borderDefinitions, borderRoles, borderStart, isScout, isShooter, ports, sideTypes, timelineOf, unitsWhere } from './fixtures/border-harness.ts'
import { addToEnd, askThenAddToEnd, commandIds, playDemo, unitVerb, type Beat, type DemoContext, type DemoOutcome, type RedOrder } from './fixtures/border-demo.ts'
import { unitTypeOf } from './engine/model.ts'
import { boardBottomClearancePx, boardEdgeGapPx, boardLayoutFor, boardTopClearancePx } from './ui/board-layout.ts'

/**
 * halden-border as a demo, played headless on a real Run with every Blue
 * order tapped on the Board of the first preset's screen. The good
 * dispatcher sends each call's first recommendation as it arrives and gives
 * the three orders the beats call for; a Blue that does nothing taps nothing.
 * The objectives are judged from the Run's state.
 */

const definition = borderDefinitions.scripted
const [blue, red] = (definition.sides ?? []).map(side => side.id) as [string, string]
const start = borderStart(definition)
const cue = (id: string) => definition.timeline!.cues.find(entry => entry.id === id)!
const cueLabel = (id: string): string => (cue(id).actions[0] as { readonly input: { readonly label: string } }).input.label
const cueS = (id: string): number => cue(id).at.seconds
const [scout] = unitsWhere(start, blue, isScout)

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
  { atS: cueS('red-push-1'), name: 'pull the scout back', act: async ({ screen, units }) => {
    if (units().find(unit => unit.id === scout!.id)?.integrity !== 'destroyed') await unitVerb(screen, scout!.id, 'recall')
  } },
  // Two calls, one free unit: the second waits at the end of the busy unit's chain (2 taps).
  { atS: cueS('call-11'), name: 'add to the end of a chain', act: async context => {
    const taskId = context.cueTask('call-11').id
    await addToEnd(context.screen, busyServer(context, taskId), taskId)
  } },
  // The only unit that serves the call is on scene elsewhere: Add to end, not Do now (3 taps).
  { atS: cueS('call-12'), name: 'do now or add to end', act: async context => {
    const taskId = context.cueTask('call-12').id
    await askThenAddToEnd(context.screen, busyServer(context, taskId), taskId)
  } },
]

const untilS = 36 * 60
const plays = new Map<string, Promise<DemoOutcome>>()
const played = (name: 'good' | 'again' | 'idle'): Promise<DemoOutcome> => {
  const known = plays.get(name)
  if (known !== undefined) return known
  const outcome = playDemo({ definition, untilS, dispatch: name !== 'idle', beats: name === 'idle' ? [] : goodBeats, watchers: name === 'good' ? ['civil-desks', 'blue-military'] : [] })
  plays.set(name, outcome)
  return outcome
}

/** The four objectives, each judged from the play's record of the Run. */
const objectives = (outcome: DemoOutcome) => {
  const blueCalls = [...outcome.sides].filter(([, side]) => side === blue).map(([label]) => label)
  const late = cueLabel('call-19')
  return {
    everyCallClosed: blueCalls.every(label => (outcome.closedAtS.get(label) ?? Number.POSITIVE_INFINITY) <= 35 * 60),
    lateCallReached: (outcome.closedAtS.get(late) ?? Number.POSITIVE_INFINITY) <= cueS('call-19') + 6 * 60,
    identifiedBeforePush: (outcome.firstShooterIdentifiedS ?? Number.POSITIVE_INFINITY) < cueS('red-push-1'),
    heldObjective: outcome.stepsLost[red]! >= 4 && outcome.stepsLost[blue]! < 2,
  }
}

describe('halden-border demo plays', () => {
  test('the good dispatcher meets every objective, and no recommended action or beat is ever refused', async () => {
    const outcome = await played('good')
    expect(objectives(outcome)).toEqual({ everyCallClosed: true, lateCallReached: true, identifiedBeforePush: true, heldObjective: true })
    expect(outcome.calls.filter(call => !call.result.ok)).toEqual([])
  }, 120_000)

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

  test('the good play has its pressure moments: diverts in the burst and at 25:00, a chain step, an Add to end, and the civil and military halves busy at once', async () => {
    const outcome = await played('good')
    const diverts = outcome.calls.filter(call => (call.input as { readonly divert?: unknown }).divert !== undefined)
    // One divert in the burst, between its first call and the grass fire, and one for the 25:00 top-priority call, within a minute.
    expect(diverts.some(call => call.atS >= cueS('call-7') && call.atS < cueS('call-12'))).toBe(true)
    expect(diverts.some(call => call.atS >= cueS('call-19') && call.atS < cueS('call-19') + 60)).toBe(true)
    const queued = outcome.calls.filter(call => call.capabilityId.endsWith('.unit.queue'))
    expect(queued.map(call => call.atS)).toEqual([cueS('call-11'), cueS('call-12')])
    // Between Red's push and the end of the burst, both halves of the one-person screen act.
    const window = outcome.calls.filter(call => call.atS >= cueS('red-push-1') && call.atS <= cueS('call-12'))
    expect(window.some(call => call.capabilityId.endsWith('.unit.recall'))).toBe(true)
    expect(window.filter(call => call.capabilityId.endsWith('.unit.send')).length).toBeGreaterThanOrEqual(4)
  }, 120_000)

  test('each preset\'s screen has something new at least every three and a half minutes until the last call', async () => {
    const outcome = await played('good')
    const lastCallS = cueS('call-19')
    for (const [preset, times] of Object.entries(outcome.logTimes)) {
      const seen = [0, ...times.filter(atS => atS <= lastCallS), lastCallS]
      const gaps = seen.slice(1).map((atS, index) => atS - seen[index]!)
      expect(Math.max(...gaps), `${preset}: ${JSON.stringify(seen)}`).toBeLessThanOrEqual(210)
    }
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
      expect(source.objectives.length).toBeGreaterThanOrEqual(3)
    }
  })

  test('the presets after the one-person bundle split Blue by the categories its groups read under in the groups dialog', () => {
    for (const source of definitions) {
      const roles = borderRoles(source)
      const groupsOf = (category: string) => configOf(source).groups.filter(group => group.side === blue && group.category === category).map(group => `group:${group.id}`)
      const categories = [...new Set(configOf(source).groups.filter(group => group.side === blue).map(group => group.category))]
      expect(categories.length).toBe(2)
      const [, first, second] = source.rolePresets!
      expect([first!.roles, second!.roles]).toEqual(categories.map(groupsOf))
      expect(roles.filter(role => role.class === 'controller').length).toBe(1)
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

  test('a unit that can serve each of Blue\'s calls reaches it within eight minutes from where the units start, on the headless router', async () => {
    for (const source of definitions) {
      const state = borderStart(source)
      const config = configOf(source)
      const tasks = [
        ...source.packs[0]!.items.flatMap(item => (item as { readonly type: string; readonly side?: string }).type === 'task' && (item as { readonly side?: string }).side === blue
          ? [item as unknown as { readonly template: string; readonly loads?: Readonly<Record<string, number>>; readonly position: readonly [number, number]; readonly label: string }] : []),
        ...timelineOf(source).flatMap(order => {
          const input = order.input as { readonly side?: string; readonly template?: string; readonly loads?: Readonly<Record<string, number>>; readonly at?: { readonly coordinates: [number, number] }; readonly label?: string }
          return order.capabilityId === commandIds.taskCreate && input.side === blue ? [{ template: input.template!, loads: input.loads, position: input.at!.coordinates, label: input.label! }] : []
        }),
      ]
      for (const task of tasks) {
        const template = config.taskTemplates.find(entry => entry.id === task.template)!
        const servers = unitsWhere(state, blue, type => template.requires.some(requirement => type.components.service?.provides.includes(requirement.provides) === true)
          || type.components.carry?.classes.some(carried => Object.keys(task.loads ?? {}).includes(carried)) === true)
        const minutes = await Promise.all(servers.map(async unit => {
          const mobility = unitTypeOf(state.catalog, unit).components.mobility!
          const route = await ports.routing.route({ from: state.motion.get(unit.id)!.point, to: geoPointFromLonLat(task.position[0], task.position[1]) })
          const travelS = mobility.mode === 'direct' ? route.distanceM / mobility.speedMps : route.durationSeconds / mobility.speedFactor
          return (mobility.mobilizeS + travelS) / 60
        }))
        expect([source.id, task.label, Math.min(...minutes) <= 8]).toEqual([source.id, task.label, true])
      }
    }
  })
})

/** Red's cautious plan, given on Red's own roles: scout and ambush at 5:00, onto the screen post at 11:00, the attack at 13:00, the reserve at 22:00. */
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

  /** The cautious plan: the scripted column's moves, with the attack given as Red's own call. */
  const cautious: ReadonlyArray<RedOrder> = [
    ...scriptedRedMoves().filter(order => order.atS < cueS('red-attack-1')),
    send(cueS('red-attack-1'), shooters.slice(0, 2), { taskId: attack.id }),
  ]
  /** All in at once: the scout to its call, two shooters to the attack and two beside KNUT, and the fourth onto the attack at 10:00. */
  const rush: ReadonlyArray<RedOrder> = [
    send(30, scouts, { taskId: scouting.id }),
    send(30, shooters.slice(0, 2), { taskId: attack.id }),
    send(30, [shooters[2]!], besideKnut(0.0006)),
    send(30, [shooters[3]!], besideKnut(0.004)),
    send(600, [shooters[3]!], { taskId: attack.id }),
  ]
  const blueBeats = goodBeats
  const humanPlays = new Map<string, Promise<DemoOutcome>>()
  const humanPlay = (name: 'cautious' | 'rush'): Promise<DemoOutcome> => {
    const known = humanPlays.get(name)
    if (known !== undefined) return known
    const outcome = playDemo({ definition: human, untilS: 30 * 60, dispatch: true, beats: blueBeats, red: name === 'cautious' ? cautious : rush })
    humanPlays.set(name, outcome)
    return outcome
  }

  test('a cautious Red that waits in ambush and then attacks loses its column to Blue\'s good play, and KNUT holds', async () => {
    const outcome = await humanPlay('cautious')
    expect(outcome.closedAtS.has(attack.label)).toBe(false)
    expect(outcome.stepsLost[red]!).toBeGreaterThan(outcome.stepsLost[blue]!)
    // The plan's later orders to a unit Blue has destroyed are refused as such, as the scripted column's are.
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
})
