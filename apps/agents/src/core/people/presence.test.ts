import { describe, expect, test } from 'bun:test'
import { createPresence, createWaiterBudget, createWaiterSet } from './presence.ts'

const clock = (start = 1_000_000) => {
  let at = start
  return { now: () => at, advance: (ms: number) => { at += ms } }
}

describe('Presence', () => {
  test('a screen is live until the timeout after it was last seen, or while a sync is pending', () => {
    const time = clock()
    const presence = createPresence({ now: time.now, timeoutMs: 30_000 })
    const { entry, changed } = presence.touch('person-a', 'screen-1', 'run-1')
    expect(changed).toBe(true)
    expect(presence.presentIn('run-1')).toEqual(new Set(['person-a']))
    time.advance(29_999)
    expect(presence.touch('person-a', 'screen-1', 'run-1').changed).toBe(false)
    presence.hold(entry)
    time.advance(60_000)
    expect(presence.presentIn('run-1')).toEqual(new Set(['person-a']))
    expect(presence.sweep()).toBe(0)
    presence.release(entry, false)
    expect(presence.presentIn('run-1')).toEqual(new Set())
    expect(presence.sweep()).toBe(1)
    expect(presence.liveScreenCount()).toBe(0)
  })

  test('an answered sync counts as seen; an aborted one does not', () => {
    const time = clock()
    const presence = createPresence({ now: time.now, timeoutMs: 30_000 })
    const { entry } = presence.touch('person-a', 'screen-1', 'run-1')
    presence.hold(entry)
    time.advance(20_000)
    presence.release(entry, true)
    time.advance(20_000)
    expect(presence.presentIn('run-1').has('person-a')).toBe(true)
    presence.hold(entry)
    time.advance(20_000)
    presence.release(entry, false)
    expect(presence.presentIn('run-1').has('person-a')).toBe(false)
    expect(() => presence.release(entry, true)).toThrow('without a pending sync')
  })

  test('a Run switch re-keys the screen, two Runs show the same Person, and leave removes one screen', () => {
    const time = clock()
    const presence = createPresence({ now: time.now })
    presence.touch('person-a', 'screen-1', 'run-1')
    expect(presence.touch('person-a', 'screen-1', 'run-2').changed).toBe(true)
    expect(presence.presentIn('run-1').size).toBe(0)
    presence.touch('person-a', 'screen-2', 'run-1')
    expect(presence.presentIn('run-1')).toEqual(new Set(['person-a']))
    expect(presence.presentIn('run-2')).toEqual(new Set(['person-a']))
    expect(presence.remove('person-a', 'screen-2')).toBe(true)
    expect(presence.remove('person-a', 'screen-2')).toBe(false)
    expect(presence.presentIn('run-1').size).toBe(0)
    // Screen ids are scoped to their Person: another Person cannot move this screen.
    presence.touch('person-b', 'screen-1', 'run-3')
    expect(presence.presentIn('run-2')).toEqual(new Set(['person-a']))
  })

  test('an expired screen that syncs again is a change for everyone else', () => {
    const time = clock()
    const presence = createPresence({ now: time.now, timeoutMs: 1_000 })
    presence.touch('person-a', 'screen-1', 'run-1')
    time.advance(1_000)
    expect(presence.touch('person-a', 'screen-1', 'run-1').changed).toBe(true)
  })

  test('the waiter budget and set keep exact counts and registration order', () => {
    const budget = createWaiterBudget(2)
    expect(budget.tryTake()).toBe(true)
    expect(budget.tryTake()).toBe(true)
    expect(budget.tryTake()).toBe(false)
    budget.release()
    expect(budget.held()).toBe(1)
    budget.release()
    expect(() => budget.release()).toThrow()
    const set = createWaiterSet<{ personId: string; n: number }>()
    const first = { personId: 'a', n: 1 }
    set.add(first)
    set.add({ personId: 'b', n: 2 })
    set.add({ personId: 'a', n: 3 })
    expect(set.forPerson('a').map(w => w.n)).toEqual([1, 3])
    expect(set.delete(first)).toBe(true)
    expect(set.delete(first)).toBe(false)
    expect(set.size()).toBe(2)
  })
})
