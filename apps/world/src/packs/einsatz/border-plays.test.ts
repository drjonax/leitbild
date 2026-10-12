import { describe, expect, test } from 'bun:test'
import { einsatzCommandIds as ids } from './capabilities.ts'
import {
  borderConfig, borderDefinitions, borderStart, commanderOf, isScout, isShooter, playBorder, pointAt, stepsLost, timelineOf, unitsWhere,
  type Play, type PlayContext, type PlayLog, type TimedOrder,
} from './fixtures/border-harness.ts'
import { unitTypeOf } from './engine/model.ts'

/**
 * The halden-border acceptance plays, headless on the direct router. Blue
 * plays four ways against the scripted Red; the exchange ratio is Red steps
 * lost ÷ (Blue steps lost + 1). Positions below are Blue's choices of
 * ground, as a commander would click them.
 */

const definition = borderDefinitions.scripted
const [blue, red] = (definition.sides ?? []).map(side => side.id) as [string, string]
const start = borderStart(definition)
const commander = commanderOf(definition, blue, 'effector')
const scouts = unitsWhere(start, blue, isScout).map(unit => unit.id)
const guns = unitsWhere(start, blue, isShooter).map(unit => unit.id)
const scoutTypes = new Set(start.catalog.config.unitTypes.filter(isScout).map(type => type.label))
/** Blue's task that only its scout can serve: the screen. */
const screenTask = [...start.tasks.values()].find(task => task.side === blue
  && start.catalog.templates.get(task.template)!.requires.some(requirement => unitTypeOf(start.catalog, start.units.get(scouts[0]!)!).components.service?.provides.includes(requirement.provides)))!

const send = (atS: number, unitId: string, to: unknown): TimedOrder => ({ atS, capabilityId: ids.send, input: { units: [unitId], to } })
const toPoint = (lonLat: readonly [number, number]) => ({ point: pointAt(lonLat) })
const weaponsFree = (atS: number): TimedOrder[] => guns.map(unitId => ({ atS, capabilityId: ids.setRoe, input: { unitId, roe: 'free' } }))

/** Every gun takes the first identified enemy scout as its priority target, from Blue's own tracks. */
const huntScouts = ({ state }: PlayContext) => {
  const target = [...state.combat.tracks.values()]
    .filter(track => track.side === blue && track.tier === 'identified' && scoutTypes.has(track.identity!.typeLabel))
    .sort((a, b) => a.id < b.id ? -1 : 1)[0]
  if (target === undefined) return []
  return unitsWhere(state, blue, isShooter).filter(unit => unit.integrity !== 'destroyed' && unit.engage !== target.id)
    .map(unit => ({ capabilityId: ids.engage, input: { unitId: unit.id, trackId: target.id } }))
}

const overwatch: ReadonlyArray<readonly [number, number]> = [[11.50246, 59.13419], [11.50426, 59.13665], [11.50134, 59.132]]
const plays: Readonly<Record<'observationPostFirst' | 'unscoutedColumn' | 'naiveMovingScout' | 'passive', ReadonlyArray<Play>>> = {
  // The scout takes the screen post before Red moves; the guns take halted overwatch, weapons free, and hunt Red's scout first.
  observationPostFirst: [{
    side: blue, viewer: commander, react: huntScouts,
    orders: [send(0, scouts[0]!, { taskId: screenTask.id }), ...guns.map((unitId, index) => send(0, unitId, toPoint(overwatch[index]!))), ...weaponsFree(0)],
  }],
  // The guns drive up the road into the halted column with no scout ahead.
  unscoutedColumn: [{
    side: blue, viewer: commander,
    orders: [...guns.map((unitId, index) => send(570, unitId, toPoint(([[11.49441, 59.14819], [11.4920, 59.1468], [11.4968, 59.1496]] as const)[index]!))), ...weaponsFree(0)],
  }],
  // The scout drives on along the road without halting; the guns follow a kilometre behind.
  naiveMovingScout: [{
    side: blue, viewer: commander,
    orders: [
      send(570, scouts[0]!, toPoint([11.50814, 59.1538])),
      ...guns.map((unitId, index) => send(570, unitId, toPoint(([[11.47931, 59.14202], [11.4770, 59.1405], [11.4815, 59.1435]] as const)[index]!))),
      ...weaponsFree(0),
    ],
  }],
  passive: [],
}

interface Outcome { readonly red: number; readonly blue: number; readonly ratio: number; readonly log: PlayLog }
const outcomes = new Map<string, Outcome>()
const outcomeOf = async (name: keyof typeof plays): Promise<Outcome> => {
  const known = outcomes.get(name)
  if (known !== undefined) return known
  const log = await playBorder({ definition, plays: plays[name], untilS: 1_800, start })
  const outcome = { red: stepsLost(log.state, red), blue: stepsLost(log.state, blue), ratio: stepsLost(log.state, red) / (stepsLost(log.state, blue) + 1), log }
  outcomes.set(name, outcome)
  return outcome
}
const minutes = (ms: number): number => (ms - start.timeMs) / 60_000

describe('halden-border plays', () => {
  test('the fixture Definitions declare the six roles on two sides, and human Red differs only by Red\'s scripted moves', () => {
    expect((definition.roles ?? []).map(role => [role.class, role.sees === 'all' ? 'all' : role.sees!.join(',')])).toEqual([
      ['operator', blue], ['operator', blue], ['operator', blue], ['operator', blue], ['operator', red], ['controller', 'all'],
    ])
    expect(borderConfig(definition).authority.map(entry => entry.roleId)).toEqual((definition.roles ?? []).filter(role => role.class === 'operator').map(role => role.id))
    expect(definition.rolePresets?.[0]?.roles).toEqual((definition.roles ?? []).filter(role => role.sees !== 'all' && role.sees?.includes(blue)).map(role => role.id))
    const human = borderDefinitions.humanRed
    const redUnits = new Set(unitsWhere(start, red, () => true).map(unit => unit.id))
    const movesRed = (order: TimedOrder): boolean => order.capabilityId === ids.send && (order.input as { readonly units: ReadonlyArray<string> }).units.every(unitId => redUnits.has(unitId))
    expect(timelineOf(human)).toEqual(timelineOf(definition).filter(order => !movesRed(order)))
    expect(timelineOf(definition).filter(movesRed).length).toBe(2 * redUnits.size)
    const { id: _humanId, title: _humanTitle, description: _humanDescription, timeline: _humanTimeline, ...humanRest } = human
    const { id: _id, title: _title, description: _description, timeline: _timeline, ...scriptedRest } = definition
    expect(humanRest).toEqual(scriptedRest)
  })

  test('only Blue\'s types report step losses as tasks, and every military type withdraws when damaged', () => {
    const config = borderConfig(definition)
    for (const type of config.unitTypes.filter(entry => entry.components.durability !== undefined)) {
      expect(type.standingOrders?.withdraw?.whenDamaged).toBe(true)
    }
    const sideTypes = (side: string) => new Set(unitsWhere(start, side, type => type.components.durability !== undefined).map(unit => unit.unitType))
    for (const typeId of sideTypes(blue)) expect(config.unitTypes.find(type => type.id === typeId)!.standingOrders?.onStepLost).toBeDefined()
    for (const typeId of sideTypes(red)) expect(config.unitTypes.find(type => type.id === typeId)!.standingOrders?.onStepLost).toBeUndefined()
  })

  test('observation post first with overwatch costs Red at least two steps and trades strictly better than the unscouted column and the naive moving scout', async () => {
    const best = await outcomeOf('observationPostFirst')
    const column = await outcomeOf('unscoutedColumn')
    const scout = await outcomeOf('naiveMovingScout')
    const table = Object.fromEntries([...outcomes].map(([name, outcome]) => [name, { red: outcome.red, blue: outcome.blue, ratio: Number(outcome.ratio.toFixed(2)) }]))
    expect(best.red, JSON.stringify(table)).toBeGreaterThanOrEqual(2)
    expect(best.ratio, JSON.stringify(table)).toBeGreaterThan(column.ratio)
    expect(best.ratio, JSON.stringify(table)).toBeGreaterThan(scout.ratio)
    // Blue's orders all went through; the only refusals are scripted Red cues for units already lost.
    expect(best.log.refusals.filter(refusal => !refusal.reason.startsWith('unit_unavailable'))).toEqual([])
  })

  test('passive Blue sees an engagement and a step-loss task between 12 and 16 minutes', async () => {
    const { log } = await outcomeOf('passive')
    const firstFire = log.transitions.find(transition => transition.kind === 'unit' && transition.record.target !== undefined)
    const firstLoss = [...log.state.tasks.values()].filter(task => task.lastAction?.by === 'standing-order:onStepLost').sort((a, b) => a.createdAtMs - b.createdAtMs)[0]
    expect(firstFire).toBeDefined()
    expect(firstLoss).toBeDefined()
    for (const at of [firstFire!.atMs, firstLoss!.createdAtMs]) {
      expect(minutes(at)).toBeGreaterThanOrEqual(12)
      expect(minutes(at)).toBeLessThanOrEqual(16)
    }
    expect(firstLoss!.side).toBe(blue)
  })
})
