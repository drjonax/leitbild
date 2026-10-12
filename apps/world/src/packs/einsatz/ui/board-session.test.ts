import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, ObjectId } from '../../../core/model/index.ts'
import { boardQueryIds } from '../board/calls.ts'
import type { CallResult } from '../board/types.ts'
import { civilConfig, civilKinds, civilWith, createWall, onObject, pastGuardMs, taskAt, unitAt } from '../fixtures/board-harness.ts'
import { openRun, operator, type OpenRun } from '../fixtures/run-harness.ts'
import { openModeViewer } from '../picture.ts'
import { createBoardSession, refeedAfterMs, type BoardPorts, type BoardSession } from './board-session.ts'

/**
 * The session the Board panel runs, on a real Run: it stamps events with wall
 * time, performs the controller's effects through the panel's ports and feeds
 * every result and answer back, turns a failed request into a refusal, and
 * once disposed drops whatever still arrives for it.
 */

const kinds = civilKinds(civilConfig)
const { carrier } = kinds.types
const [top] = kinds.classes as [string]
const at = (eastKm: number, northKm = 0): [number, number] => [11.38 + eastKm / 57.12, 59.12 + northKm / 110.54]
const scene = [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [top]: 1 })]
const key = (name: string) => ({ key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, shift: false })

/** Test ports over the Run's own Capability path, as the panel's World client calls it, with every request awaited by `settle`. */
const portsFor = (run: OpenRun, wall: ReturnType<typeof createWall>, overrides: Partial<BoardPorts> = {}) => {
  const pending: Array<Promise<unknown>> = []
  const seen = { selects: [] as Array<ObjectId | null>, sounds: 0, changes: 0, failures: [] as unknown[], calls: [] as Array<{ capabilityId: string; input: unknown; result: CallResult }> }
  const awaited = <T>(promise: Promise<T>): Promise<T> => {
    pending.push(promise.catch(() => undefined))
    return promise
  }
  const ports: BoardPorts = {
    invoke: async (capabilityId, input) => await awaited((async (): Promise<CallResult> => {
      const outcome = await run.run.invokeCapability(operator, { capabilityId, input })
      if (outcome.kind !== 'command') throw new Error(`${capabilityId} is not a command`)
      const result: CallResult = outcome.result.ok ? { ok: true } : { ok: false, reason: outcome.result.reason }
      seen.calls.push({ capabilityId, input, result })
      return result
    })()),
    recommend: async taskId => await awaited((async () => (await run.run.invokeCapability(operator, { capabilityId: boardQueryIds.recommend, input: { taskId } })).result)()),
    select: objectId => { seen.selects.push(objectId) },
    sound: () => { seen.sounds += 1 },
    wallMs: wall.now,
    changed: () => { seen.changes += 1 },
    failed: error => { seen.failures.push(error) },
    ...overrides,
  }
  /** Lets every request the session made, and every one its answers led to, finish. */
  const settle = async (): Promise<void> => {
    while (pending.length > 0) {
      await Promise.all(pending.splice(0))
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  return { ports, seen, settle, awaited }
}

const withRun = async (body: (run: OpenRun) => Promise<void>): Promise<void> => {
  const run = await openRun({ definition: civilWith(scene) })
  try { await body(run) } finally { await run.close() }
}
const runTime = (run: OpenRun): IsoTimestamp => new Date(run.nowMs()).toISOString() as IsoTimestamp
const observe = (session: BoardSession, run: OpenRun): void => session.observe(run.run.snapshot().objects, runTime(run))

describe('Board session', () => {
  test('feeds nothing before the Run clock is known, then dispatches N and Enter as keys, performs the send and shows its result', async () => {
    await withRun(async run => {
      const wall = createWall()
      const { ports, seen, settle } = portsFor(run, wall)
      const session = createBoardSession({ config: civilConfig, viewer: openModeViewer, declaredRoles: [], sides: [], ports })
      session.observe(run.run.snapshot().objects, undefined)
      expect(seen.changes).toBe(0)
      observe(session, run)
      await settle()
      expect(session.view().workList.rows.map(row => row.id)).toEqual(['t1'])

      expect(session.onKey({ key: 'q', code: 'KeyQ', shift: false })).toBe(false)
      expect(session.onKey(key('n'))).toBe(true)
      expect(seen.selects).toEqual(['t1' as ObjectId])
      wall.advance(pastGuardMs)
      expect(session.onKey(key('Enter'))).toBe(true)
      expect(session.view().feedback?.tone).toBe('pending')
      await settle()
      expect(seen.calls).toEqual([{ capabilityId: 'world.einsatz.unit.send', input: { units: ['u1'], to: { taskId: 't1' } }, result: { ok: true } }])
      expect(session.view().feedback).toMatchObject({ tone: 'done', text: expect.stringMatching(/^✓ /) })
      expect(seen.failures).toEqual([])
    })
  })

  test('a failed request is a refusal with its message, and a failed recommendation shows on its row', async () => {
    await withRun(async run => {
      const wall = createWall()
      const { ports, seen, settle, awaited } = portsFor(run, wall)
      const offline = createBoardSession({
        config: civilConfig,
        viewer: openModeViewer,
        declaredRoles: [],
        sides: [],
        ports: { ...ports, recommend: async () => await awaited(Promise.reject(new Error('Capability query failed: 503'))) },
      })
      observe(offline, run)
      await settle()
      expect(offline.view().workList.rows[0]?.statusText).toBe('No recommendation: Capability query failed: 503')

      const unreachable = createBoardSession({
        config: civilConfig,
        viewer: openModeViewer,
        declaredRoles: [],
        sides: [],
        ports: { ...ports, invoke: async () => await awaited(Promise.reject(new Error('Failed to fetch'))) },
      })
      observe(unreachable, run)
      await settle()
      unreachable.onKey(key('n'))
      wall.advance(pastGuardMs)
      unreachable.onKey(key('Enter'))
      await settle()
      expect(unreachable.view().feedback).toEqual({ text: '✗ Failed to fetch', tone: 'refused' })
      expect(seen.failures).toEqual([])
    })
  })

  test('once disposed, a late result is dropped, keys and map targets are no longer taken, and no preview is shown', async () => {
    await withRun(async run => {
      const wall = createWall()
      const { ports, seen, settle } = portsFor(run, wall)
      let answer: ((result: CallResult) => void) | null = null
      const session = createBoardSession({
        config: civilConfig,
        viewer: openModeViewer,
        declaredRoles: [],
        sides: [],
        ports: { ...ports, invoke: async () => await new Promise<CallResult>(resolve => { answer = resolve }) },
      })
      observe(session, run)
      await settle()
      session.onKey(key('n'))
      wall.advance(pastGuardMs)
      session.onKey(key('Enter'))
      expect(answer).not.toBeNull()
      expect(session.previewMapTarget('u1' as ObjectId, onObject('t1'))).not.toBeNull()
      const changes = seen.changes
      session.dispose()
      answer!({ ok: true })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(seen.changes).toBe(changes)
      expect(session.onKey(key('n'))).toBe(false)
      session.onMapTarget('u1' as ObjectId, onObject('t1'))
      observe(session, run)
      expect(seen.changes).toBe(changes)
      expect(session.previewMapTarget('u1' as ObjectId, onObject('t1'))).toBeNull()
      expect(seen.failures).toEqual([])
    })
  })

  test('while the Run clock runs with nothing moving, a tick feeds the same objects again once a second has passed, so ages follow the clock; a paused clock feeds nothing', async () => {
    await withRun(async run => {
      const wall = createWall()
      const { ports, seen, settle } = portsFor(run, wall)
      const session = createBoardSession({ config: civilConfig, viewer: openModeViewer, declaredRoles: [], sides: [], ports })
      const objects = run.run.snapshot().objects
      const later = (ms: number): IsoTimestamp => new Date(run.nowMs() + ms).toISOString() as IsoTimestamp
      const age = () => session.view().workList.rows[0]?.ageText
      // Before any snapshot a tick feeds nothing: the objects the panel holds may not have arrived yet.
      session.tick(objects, later(0))
      expect(session.view().workList.rows).toEqual([])
      session.observe(objects, later(0))
      await settle()
      const first = age()
      session.tick(objects, later(refeedAfterMs - 1))
      expect(age()).toBe(first)
      // Paused: the clock stands still and the age with it.
      session.tick(objects, later(0))
      session.tick(objects, undefined)
      expect(age()).toBe(first)
      session.tick(objects, later(65_000))
      await settle()
      const seconds = (text: string | undefined): number => text!.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
      expect(seconds(age()) - seconds(first)).toBe(65)
      expect(seen.failures).toEqual([])
    })
  })

  test('a fault in the Board itself is reported, never shown as a refusal', async () => {
    await withRun(async run => {
      const wall = createWall()
      const { ports, seen } = portsFor(run, wall)
      const session = createBoardSession({ config: civilConfig, viewer: openModeViewer, declaredRoles: [], sides: [], ports })
      session.dispatch({ kind: 'result', callId: 'board-99', result: { ok: true } })
      expect(seen.failures.map(error => (error as Error).message)).toEqual(['The Board made no call board-99'])
      expect(session.view().feedback).toBeNull()
    })
  })
})
