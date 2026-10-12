import { describe, expect, test } from 'bun:test'
import { advanceTo, at, blue, config, cycles, fireOn, place, red, run, start, stateWith, trackOf, types, unit, withTypes } from '../fixtures/combat-harness.ts'
import { borderDefinitions, groupOf } from '../fixtures/border-harness.ts'
import { removeRecords } from '../runtime/removal.ts'
import { destroyedCode, underFireCode } from './combat.ts'
import { trackTimeoutMs } from './detection.ts'
import type { EngineState, Transition } from './model.ts'
import { sameValue } from './values.ts'

const hold = (unitId: string) => ({ kind: 'set-roe' as const, unitId, roe: 'hold' as const })
const free = (unitId: string) => ({ kind: 'set-roe' as const, unitId, roe: 'free' as const })

/** Fire-seconds a unit received at each boundary from `from` to `to` seconds. */
const fireTrace = async (state: EngineState, unitId: string, to: number): Promise<{ readonly state: EngineState; readonly trace: ReadonlyArray<readonly [number, number]> }> => {
  const trace: Array<readonly [number, number]> = []
  const stepped = await cycles(state, to, (step, seconds) => { trace.push([seconds, fireOn(step.state, unitId)]) })
  return { state: stepped.state, trace }
}

const increments = (trace: ReadonlyArray<readonly [number, number]>, from: number): ReadonlyArray<readonly [number, number]> =>
  trace.flatMap(([seconds, fire], index) => index === 0 || seconds < from ? [] : [[seconds, fire - trace[index - 1]![1]] as const])

describe('Einsatz engagement', () => {
  test('(a) three cycles after the last identifying detection no more fire lands, and the track stays until its timeout', async () => {
    let state = await stateWith([
      place('r1', types.redGun, red, at(0)),
      hold('r1'),
      place('s1', types.blueScout, blue, at(900)),
      place('b1', types.blueGun, blue, at(1_800)),
      free('b1'),
    ])
    state = (await advanceTo(state, 20)).state
    expect(fireOn(state, 'r1')).toBeGreaterThan(0)
    state = removeRecords(state, new Set(['s1'])).state
    const { state: after, trace } = await fireTrace(state, 'r1', 60)
    expect(increments(trace, 22).slice(0, 4)).toEqual([[24, 2], [26, 0], [28, 0], [30, 0]])
    expect(trace[0]).toEqual([22, fireOn(state, 'r1') + 2])
    expect(increments(trace, 26).every(([, received]) => received === 0)).toBe(true)
    expect(unit(after, 'b1').target).toBeUndefined()
    const track = trackOf(after, blue, 'r1')!
    expect(track).toMatchObject({ tier: 'identified', fix: false })
    expect((await advanceTo(after, 20 + trackTimeoutMs / 1_000 - 2)).state.combat.tracks.has(track.id)).toBe(true)
    expect((await advanceTo(after, 20 + trackTimeoutMs / 1_000)).state.combat.tracks.has(track.id)).toBe(false)
  })

  test('(b) when the scout is killed, a contact-only sensor in range keeps the track but no fire lands after three cycles', async () => {
    let state = await stateWith([
      place('r1', types.redGun, red, at(0)),
      hold('r1'),
      place('s1', types.blueScout, blue, at(900)),
      place('r2', types.redGun, red, at(1_150)),
      place('w1', types.watcher, blue, at(0, -400)),
      place('b1', types.blueGun, blue, at(0, 1_800)),
      free('b1'),
    ])
    const { state: after, trace } = await fireTrace(state, 'r1', 90)
    const killedAt = (unit(after, 's1').integritySinceMs! - start) / 1_000
    expect(unit(after, 's1').integrity).toBe('destroyed')
    // Fire lands at the kill boundary and two more, then stops.
    expect(increments(trace, killedAt).slice(0, 4).map(([, received]) => received)).toEqual([2, 2, 2, 0])
    expect(increments(trace, killedAt + 6).every(([, received]) => received === 0)).toBe(true)
    const track = trackOf(after, blue, 'r1')!
    expect(track).toMatchObject({ tier: 'identified', fix: false })
    expect(after.combat.sightings.get(track.id)!.observedAtMs).toBe(after.timeMs)
    expect(unit(after, 'b1').target).toBeUndefined()
    // The scout's loss is worded at its side's knowledge of the shooter.
    const shooterTrack = trackOf(after, blue, 'r2')!
    expect(unit(after, 's1').alerts.find(alert => alert.code === destroyedCode)?.message).toBe(`Destroyed: ${shooterTrack.label} (${shooterTrack.identity!.typeLabel})`)
    // The side that fired held a fix at the kill: its track turned destroyed.
    expect(trackOf(after, red, 's1')).toMatchObject({ tier: 'destroyed', fix: false })
  })

  test('(c) a kill watched under a fix turns the track destroyed and shooters retarget at the next boundary; an unobserved kill just ages', async () => {
    const third = 'green'
    // The third side's units form one group of their own.
    const configuration = { ...withTypes(type => type, { ...config.hostility, [third]: [red] }), groups: [...config.groups, { id: third, label: 'Green', category: 'Green', side: third }] }
    let state = await stateWith([
      place('g1', types.redGun, third, at(0), third),
      place('gs', types.blueScout, third, at(700), third),
      place('t1', types.redScout, red, at(800)),
      place('t2', types.redScout, red, at(1_200)),
      place('w1', types.watcher, blue, at(800, 150)),
    ], configuration, [blue, red, third])
    const targets: Array<readonly [number, string | undefined]> = []
    state = (await cycles(state, 60, (step, seconds) => { targets.push([seconds, step.state.units.get('g1')!.target]) })).state
    const killedAt = (unit(state, 't1').integritySinceMs! - start) / 1_000
    expect(unit(state, 't1').integrity).toBe('destroyed')
    const watched = trackOf(state, third, 't1')!
    const next = trackOf(state, third, 't2')!
    expect(watched).toMatchObject({ tier: 'destroyed', fix: false })
    expect(targets.find(([seconds]) => seconds === killedAt)?.[1]).toBe(watched.id)
    expect(targets.find(([seconds]) => seconds === killedAt + 2)?.[1]).toBe(next.id)
    // Blue saw t1 only as a contact without a fix: its track does not learn of the kill and just ages.
    const unobserved = trackOf(state, blue, 't1')!
    expect(unobserved).toMatchObject({ tier: 'contact', fix: false })
    expect(state.combat.sightings.get(unobserved.id)!.observedAtMs).toBe(start + killedAt * 1_000)
    const aged = (await advanceTo(state, killedAt + trackTimeoutMs / 1_000)).state
    expect(aged.combat.tracks.has(unobserved.id)).toBe(false)
    expect(aged.combat.tracks.has(watched.id)).toBe(false)
  })

  test('(d) a five-minute static engagement journals only transitions while fire accumulates every cycle', async () => {
    const lasting = withTypes(type => type.components.durability === undefined ? type : { ...type, components: { ...type.components, durability: { stepFireS: 86_400 } } })
    let state = await stateWith([
      place('s1', types.blueScout, blue, at(0)),
      place('b1', types.blueGun, blue, at(0, 300)),
      place('r1', types.redGun, red, at(1_500)),
      place('rs', types.redScout, red, at(1_300)),
      free('b1'),
    ], lasting)
    const transitions: Transition[] = []
    const fire: number[] = []
    state = (await cycles(state, 300, step => {
      transitions.push(...step.transitions)
      fire.push(fireOn(step.state, 'b1') + fireOn(step.state, 'r1'))
    })).state
    expect(unit(state, 'b1').target).toBeDefined()
    expect(unit(state, 'r1').target).toBeDefined()
    // Both sides fire every cycle once engaged...
    const engagedFrom = fire.findIndex(total => total >= 4)
    expect(fire.slice(engagedFrom + 1).every((total, index) => total - fire[engagedFrom + index]! === 4)).toBe(true)
    // ...while nothing is journaled after the first minute, and every journaled change changes the record.
    expect(transitions.filter(transition => transition.atMs > start + 60_000)).toEqual([])
    const last = new Map<string, unknown>()
    for (const transition of transitions) {
      const key = `${transition.kind}:${transition.record.id}`
      expect(sameValue(last.get(key), transition.record)).toBe(false)
      last.set(key, transition.record)
    }
    expect(transitions.length).toBeLessThan(40)
  })

  test('four shooters destroy a shooter in 23 volleys (46 s) and a scout in 5 (10 s); attrition has no randomness', async () => {
    const volleysToDestroy = async (target: string): Promise<number> => {
      let state = await stateWith([
        place('t', target, red, at(1_000)),
        ...(target === types.redGun ? [hold('t')] : []),
        place('s1', types.blueScout, blue, at(0, 200)),
        ...[1, 2, 3, 4].flatMap(index => [place(`b${index}`, types.blueGun, blue, at(0, index * 50)), free(`b${index}`)]),
      ])
      let volleys = 0
      state = (await cycles(state, 120, step => { if (step.state.units.get('t')!.integrity !== 'destroyed' && fireOn(step.state, 't') > 0) volleys = fireOn(step.state, 't') / 8 })).state
      expect(unit(state, 't').integrity).toBe('destroyed')
      return volleys + 1
    }
    // One volley per 2 s engagement step.
    expect(await volleysToDestroy(types.redGun)).toBe(23)
    expect(await volleysToDestroy(types.redScout)).toBe(5)
  })

  test('the fire gate: weapons hold never fires, return-fire answers only units that fired, and only hostile, targetable tracks in range are engaged', async () => {
    let state = await stateWith([
      place('s1', types.blueScout, blue, at(0)),
      place('b1', types.blueGun, blue, at(0, 100)),
      place('w2', types.watcher, red, at(500), groupOf(borderDefinitions.scripted, red, types.redScout)),
      place('far', types.redGun, red, at(2_300)),
      place('r1', types.redGun, red, at(1_500)),
      hold('r1'),
      hold('far'),
      { kind: 'set-roe', unitId: 'b1', roe: 'return-fire' },
    ])
    // Blue returns fire only; nothing red fired, so nothing is engaged, though r1 is identified with a fix and in range.
    state = (await advanceTo(state, 20)).state
    expect(trackOf(state, blue, 'r1')).toMatchObject({ tier: 'identified', fix: true })
    expect(unit(state, 'b1').target).toBeUndefined()
    // Weapons free: the watcher is identified but not a target of the effector, and the far unit is out of range.
    state = await run(state, free('b1'))
    state = (await advanceTo(state, 22)).state
    expect(trackOf(state, blue, 'w2')).toMatchObject({ tier: 'identified' })
    expect(unit(state, 'b1').target).toBe(trackOf(state, blue, 'r1')!.id)
    expect(fireOn(state, 'w2')).toBe(0)
    expect(fireOn(state, 'far')).toBe(0)
    // r1 holds fire although it is hit; once allowed to answer only fire, it does, since b1 fired.
    expect(unit(state, 'r1').target).toBeUndefined()
    state = await run(state, { kind: 'set-roe', unitId: 'r1', roe: 'return-fire' })
    state = (await advanceTo(state, 30)).state
    expect(fireOn(state, 'b1')).toBeGreaterThan(0)
    expect(unit(state, 'b1').alerts.find(alert => alert.code === underFireCode)?.message).toContain('Under fire: ')
    // Hostility gates fire, not detection: a side hostile to nobody never fires.
    const peaceful = withTypes(type => type, {})
    let calm = await stateWith([place('s1', types.blueScout, blue, at(0)), place('b1', types.blueGun, blue, at(0, 100)), place('r1', types.redGun, red, at(1_000)), free('b1')], peaceful)
    calm = (await advanceTo(calm, 20)).state
    expect(trackOf(calm, blue, 'r1')).toMatchObject({ tier: 'identified', fix: true })
    expect(fireOn(calm, 'r1') + fireOn(calm, 'b1')).toBe(0)
  })

  test('target selection: a priority target first, then the current target, then the nearest', async () => {
    let state = await stateWith([
      place('s1', types.blueScout, blue, at(0)),
      place('b1', types.blueGun, blue, at(0, 100)),
      free('b1'),
      place('near', types.redGun, red, at(1_200)),
      place('far', types.redGun, red, at(1_600)),
      hold('near'),
      hold('far'),
    ])
    state = (await advanceTo(state, 4)).state
    const near = trackOf(state, blue, 'near')!
    const far = trackOf(state, blue, 'far')!
    expect(unit(state, 'b1').target).toBe(near.id)
    state = await run(state, { kind: 'engage', unitId: 'b1', trackId: far.id })
    state = (await advanceTo(state, 6)).state
    expect(unit(state, 'b1')).toMatchObject({ engage: far.id, target: far.id })
    expect(unit(state, 'b1').lastAction).toMatchObject({ verb: 'engage', target: far.id })
  })

  test('standing orders: a damaged unit withdraws through recall unless moved since, and each step lost creates a task on its side', async () => {
    let state = await stateWith([
      place('s1', types.blueScout, blue, at(0)),
      place('r1', types.redGun, red, at(1_000)),
      place('b1', types.blueGun, blue, at(-3_000)),
    ])
    state = await run(state, { kind: 'send', units: ['b1'], to: { point: at(300) } })
    const seen: Transition[] = []
    let damagedAt: number | undefined
    for (let seconds = 2; damagedAt === undefined; seconds += 2) {
      if (seconds > 900) throw new Error('b1 was never damaged')
      const step = await advanceTo(state, seconds)
      state = step.state
      seen.push(...step.transitions)
      if (unit(state, 'b1').integrity === 'damaged') damagedAt = state.timeMs
    }
    const record = unit(state, 'b1')
    expect(record).toMatchObject({ phase: 'returning', integritySinceMs: damagedAt, lastAction: { verb: 'recall', by: 'standing-order:withdraw', atMs: damagedAt } })
    const order = config.unitTypes.find(type => type.id === types.blueGun)!.standingOrders!.onStepLost!
    const created = seen.flatMap(transition => transition.kind === 'task' && transition.record.id.startsWith('b1:') ? [{ atMs: transition.atMs, record: transition.record }] : [])
    expect(created.map(transition => transition.atMs)).toEqual([damagedAt])
    expect(created[0]!.record).toMatchObject({ template: order.createTask, side: blue, loads: order.perStep, lastAction: { verb: 'create', by: 'standing-order:onStepLost' } })
    const lostAt = [...seen].reverse().find(transition => transition.kind === 'unit' && transition.record.id === 'b1' && transition.record.integrity === 'damaged')
    if (lostAt?.kind !== 'unit') throw new Error('b1 has no step-loss transition')
    expect(created[0]!.record.point).toEqual(lostAt.point)
    // A movement order given after the step loss stands in for withdrawing.
    state = removeRecords(state, new Set(['r1'])).state
    state = await run(state, { kind: 'send', units: ['b1'], to: { point: at(200) } })
    state = (await advanceTo(state, (state.timeMs - start) / 1_000 + 120)).state
    expect(unit(state, 'b1')).toMatchObject({ phase: 'holding', integrity: 'damaged', lastAction: { verb: 'move', by: 'Controller' } })
  })

  test('the same engagement played twice, or in large and small steps, journals the same transitions', async () => {
    const setup = () => stateWith([
      place('s1', types.blueScout, blue, at(0)),
      place('b1', types.blueGun, blue, at(0, 100)),
      place('b2', types.blueGun, blue, at(0, 200)),
      place('r1', types.redGun, red, at(1_400)),
      place('rs', types.redScout, red, at(2_200)),
      free('b1'),
    ])
    const once = await advanceTo(await setup(), 240)
    const twice = await advanceTo(await setup(), 240)
    const stepped = await cycles(await setup(), 240)
    let odd = await setup()
    const oddTransitions: Transition[] = []
    for (const seconds of [0.7, 13, 13.001, 59, 121.5, 240]) {
      const step = await advanceTo(odd, seconds)
      odd = step.state
      oddTransitions.push(...step.transitions)
    }
    expect(JSON.stringify(twice.transitions)).toBe(JSON.stringify(once.transitions))
    expect(JSON.stringify(stepped.transitions)).toBe(JSON.stringify(once.transitions))
    expect(JSON.stringify(oddTransitions)).toBe(JSON.stringify(once.transitions))
    expect(once.transitions.some(transition => transition.kind === 'track')).toBe(true)
  })
})
