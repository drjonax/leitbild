import { describe, expect, test } from 'bun:test'
import { createDirectRoutingAdapter } from '../../../routing/direct-adapter.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import { advance, at, controller, emptyState, low, newTask, newUnit, run, runAll, send, start, taskOf, templates, top, types, unitOf } from '../fixtures/engine-harness.ts'
import { advanceEngine, executeIntent } from './engine.ts'
import type { EngineState, Transition } from './model.ts'
import { nextBoundaryMs } from './reflexes.ts'

/** A test router that can be taken offline; it counts every route asked of it. */
const switchableRouter = () => {
  const direct = createDirectRoutingAdapter()
  const control = { online: true, calls: 0 }
  const routing: RoutingAdapter = {
    id: 'switchable',
    route: async request => {
      control.calls += 1
      if (!control.online) throw new Error('Router offline')
      return await direct.route(request)
    },
  }
  return { control, ports: { routing } }
}

const unitTransitions = (transitions: ReadonlyArray<Transition>, id: string) =>
  transitions.flatMap(entry => entry.kind === 'unit' && entry.record.id === id ? [entry] : [])

describe('Einsatz standing orders', () => {
  test('a return whose routing fails raises an alert, holds the unit and is retried at each 2 s boundary, never failing the run', async () => {
    const { control, ports } = switchableRouter()
    let state = await runAll(emptyState(), [
      newUnit('g1', types.pairServer, at(0)),
      newUnit('g2', types.pairServer, at(0)),
      newTask('pair', templates.pair, at(0.01)),
      send(['g1', 'g2'], { taskId: 'pair' }),
    ])
    state = (await advanceEngine(state, start + 60_000, ports)).state
    const idleSince = unitOf(state, 'g1').phaseSinceMs
    expect(taskOf(state, 'pair').closedAtMs).toBe(idleSince)
    expect(unitOf(state, 'g1')).toMatchObject({ phase: 'available', atBase: false })
    const due = idleSince + 30_000

    control.online = false
    control.calls = 0
    const failing = await advanceEngine(state, due + 5_000, ports)
    let attempts = 1
    for (let boundary = nextBoundaryMs(due); boundary <= due + 5_000; boundary = nextBoundaryMs(boundary)) attempts += 1
    expect(control.calls).toBe(2 * attempts)
    expect(unitOf(failing.state, 'g1')).toMatchObject({ phase: 'available', alerts: [{ code: 'return_failed', message: 'Return failed: No route for G1: Router offline', sinceMs: due }] })
    expect(unitTransitions(failing.transitions, 'g1')).toHaveLength(1)

    control.online = true
    const retry = nextBoundaryMs(due + 5_000)
    const recovered = await advanceEngine(failing.state, retry, ports)
    expect(unitTransitions(recovered.transitions, 'g1').map(entry => [entry.atMs, entry.record.phase])).toEqual([[retry, 'returning']])
    expect(unitOf(recovered.state, 'g1').alerts).toEqual([])
    expect(unitOf(recovered.state, 'g1').lastAction).toMatchObject({ verb: 'recall', by: 'standing-order:return' })
  })

  test('a delivery with no accepting site holds the load under an alert until a site can take it', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newTask('t1', templates.load, at(0), { [top]: 1 }),
      send(['c1'], { taskId: 't1' }),
    ])
    state = await advance(state, start + 6_000)
    expect(unitOf(state, 'c1')).toMatchObject({ phase: 'holding', load: { [top]: 1 }, alerts: [{ code: 'deliver_failed', message: 'Deliver failed: No site accepts 1 person', sinceMs: start + 5_000 }] })
    state = await run(state, newUnit('site', types.publicSite, at(0.01)))
    expect(unitOf(state, 'c1').phase).toBe('holding')
    state = await advance(state, start + 8_000)
    expect(unitOf(state, 'c1')).toMatchObject({ phase: 'transporting', siteId: 'site', lastAction: { verb: 'deliver', by: 'standing-order:deliver' } })
    expect(unitOf(state, 'c1').alerts).toEqual([])
  })

  test('when a site stops accepting, units under a deliver order reroute at once and others keep going to wait', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('d1', types.directCarrier, at(0)),
      newUnit('near', types.publicSite, at(0.02)),
      newUnit('far', types.publicSite, at(-0.03)),
      newTask('t1', templates.load, at(0), { [top]: 1 }),
      newTask('t2', templates.load, at(0), { [low]: 1 }),
      send(['c1'], { taskId: 't1' }),
      send(['d1'], { taskId: 't2' }),
    ])
    state = await advance(state, start + 5_000)
    state = await run(state, send(['d1'], { siteId: 'near' }))
    state = await advance(state, start + 6_000)
    expect([unitOf(state, 'c1').siteId, unitOf(state, 'd1').siteId]).toEqual(['near', 'near'])
    const outcome = await executeIntent(state, { kind: 'site.set', siteId: 'near', accepting: false }, controller, { routing: createDirectRoutingAdapter() })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(unitTransitions(outcome.transitions, 'c1').map(entry => [entry.record.phase, entry.record.lastAction?.cause ?? entry.record.lastAction?.by])).toEqual([
      ['holding', 'NEAR stopped accepting'],
      ['transporting', 'standing-order:deliver'],
    ])
    expect(unitOf(outcome.state, 'c1').siteId).toBe('far')
    expect(unitOf(outcome.state, 'd1')).toMatchObject({ phase: 'transporting', siteId: 'near' })
    const waiting: EngineState = await advance(outcome.state, start + 60_000)
    expect(unitOf(waiting, 'd1')).toMatchObject({ phase: 'at-site', siteId: 'near' })
    expect(unitOf(waiting, 'd1').phaseDueMs).toBeUndefined()
  })
})
