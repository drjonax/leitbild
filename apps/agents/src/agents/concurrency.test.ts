import { describe, expect, test } from 'bun:test'
import { createConcurrencyManager } from './concurrency.ts'

describe('ConcurrencyManager — getStartedAt', () => {
  test('undefined when idle', () => {
    const cm = createConcurrencyManager('agent-1')
    expect(cm.getStartedAt()).toBeUndefined()
    expect(cm.state.getStartedAt()).toBeUndefined()
  })

  test('returns a number after startGeneration', () => {
    const cm = createConcurrencyManager('agent-1')
    const before = Date.now()
    cm.startGeneration('room-a')
    const after = Date.now()
    const t = cm.getStartedAt()
    expect(t).toBeDefined()
    expect(t!).toBeGreaterThanOrEqual(before)
    expect(t!).toBeLessThanOrEqual(after)
    expect(cm.state.getStartedAt()).toBe(t!)
  })

  test('cleared after endGeneration', () => {
    const cm = createConcurrencyManager('agent-1')
    cm.startGeneration('room-a')
    expect(cm.getStartedAt()).toBeDefined()
    cm.endGeneration('room-a')
    expect(cm.getStartedAt()).toBeUndefined()
    expect(cm.state.getStartedAt()).toBeUndefined()
  })

  test('cleared after cancelAll', () => {
    const cm = createConcurrencyManager('agent-1')
    cm.startGeneration('room-a')
    expect(cm.getStartedAt()).toBeDefined()
    cm.cancelAll()
    expect(cm.getStartedAt()).toBeUndefined()
  })

  test('subscriber receives startedAt as 4th arg', () => {
    const cm = createConcurrencyManager('agent-1')
    const calls: Array<{ state: string; ctx?: string; ts?: number }> = []
    cm.state.subscribe((state, _id, context, startedAt) => {
      calls.push({ state, ctx: context, ts: startedAt })
    })
    cm.startGeneration('room-a')
    cm.notifyState('generating', 'room-a')
    cm.endGeneration('room-a')

    expect(calls.length).toBe(2)
    expect(calls[0]?.state).toBe('generating')
    expect(calls[0]?.ctx).toBe('room-a')
    expect(typeof calls[0]?.ts).toBe('number')
    // After endGeneration → notifyState('idle') → startedAt is already cleared.
    expect(calls[1]?.state).toBe('idle')
    expect(calls[1]?.ts).toBeUndefined()
  })
})

describe('ConcurrencyManager — a delayed turn', () => {
  test('is queued work that whenIdle waits for', async () => {
    const cm = createConcurrencyManager('agent-1')
    const started: string[] = []
    cm.scheduleNext('room-a', 5, roomId => { started.push(roomId); cm.startGeneration(roomId) })
    expect(cm.state.get()).toBe('idle')
    expect(cm.hasQueuedWork()).toBe(true)
    let idle = false
    const waiting = cm.whenIdle().then(() => { idle = true })
    await Bun.sleep(20)
    expect(started).toEqual(['room-a'])
    expect(idle).toBe(false)
    cm.endGeneration('room-a')
    await waiting
    expect(cm.hasQueuedWork()).toBe(false)
  })

  test('is dropped by cancelAll', async () => {
    const cm = createConcurrencyManager('agent-1')
    const started: string[] = []
    cm.scheduleNext('room-a', 5, roomId => { started.push(roomId) })
    cm.cancelAll()
    expect(cm.hasQueuedWork()).toBe(false)
    await cm.whenIdle()
    await Bun.sleep(20)
    expect(started).toEqual([])
  })
})

describe('ConcurrencyManager — close', () => {
  test('drops queued work, lets the running turn end, and starts nothing after', async () => {
    const cm = createConcurrencyManager('agent-1')
    const started: string[] = []
    cm.startGeneration('room-a')
    cm.addPending('room-b')
    cm.scheduleNext('room-c', 5, roomId => { started.push(roomId) })
    cm.close()
    expect(cm.isClosed()).toBe(true)
    expect(cm.hasQueuedWork()).toBe(false)
    expect(cm.state.get()).toBe('generating')
    let idle = false
    const waiting = cm.whenIdle().then(() => { idle = true })
    await Bun.sleep(20)
    expect(started).toEqual([])
    expect(idle).toBe(false)
    cm.endGeneration('room-a')
    await waiting
    expect(() => cm.startGeneration('room-a')).toThrow('closed')
    expect(() => cm.addPending('room-a')).toThrow('closed')
    expect(() => cm.scheduleNext('room-a', 5, () => {})).toThrow('closed')
  })
})
