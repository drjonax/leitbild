import { describe, expect, test } from 'bun:test'
import {
  countedNoun, createDeleteSession, deleteEach, deletedText, deleteLabel, deleteTitle, failureBody, failureTitle, isAlreadyGone, keepExisting,
  progressText, selectAllState, SIMULATION_NOUN, toggleAll, toggleOne, WORKSPACE_NOUN, type DeleteSessionState, type RemoveOutcome,
} from './bulk-delete.ts'
import { GENERIC_ERROR_TEXT, HOST_UNREACHABLE_TEXT } from './error-text.ts'

const later = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('deleteEach', () => {
  test('deletes every item, never more than the limit at once, and reports progress', async () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f']
    let running = 0
    let peak = 0
    const progress: string[] = []
    const result = await deleteEach(items, async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 1))
      running -= 1
      return { kind: 'deleted' }
    }, { concurrency: 4, onprogress: (done, total) => progress.push(`${done}/${total}`) })
    expect(result).toEqual({ removed: items, failed: [] })
    expect(peak).toBe(4)
    expect(progress).toEqual(['1/6', '2/6', '3/6', '4/6', '5/6', '6/6'])
  })

  test('gone counts as removed; failures keep their item and plain text, in the order given', async () => {
    const answers: Record<string, RemoveOutcome> = {
      a: { kind: 'deleted' },
      b: { kind: 'failed', text: 'Part of this Workspace could not be removed. Try again.' },
      c: { kind: 'gone' },
    }
    const result = await deleteEach(['a', 'b', 'c'], async item => answers[item]!)
    expect(result.removed).toEqual(['a', 'c'])
    expect(result.failed).toEqual([{ item: 'b', text: 'Part of this Workspace could not be removed. Try again.' }])
  })

  test('a thrown error is that item\'s failure in plain words; the others still run', async () => {
    const error = console.error
    console.error = () => {}
    try {
      const result = await deleteEach(['a', 'b', 'c'], async item => {
        if (item === 'a') throw new TypeError('Failed to fetch')
        if (item === 'b') throw new Error('Invalid input: expected string, received number')
        return { kind: 'deleted' }
      })
      expect(result.removed).toEqual(['c'])
      expect(result.failed).toEqual([{ item: 'a', text: HOST_UNREACHABLE_TEXT }, { item: 'b', text: GENERIC_ERROR_TEXT }])
    } finally { console.error = error }
  })

  test('a slow first item does not hold back the rest', async () => {
    const slow = later()
    const finished: string[] = []
    const run = deleteEach(['slow', 'b', 'c'], async item => {
      if (item === 'slow') await slow.promise
      finished.push(item)
      return { kind: 'deleted' }
    }, { concurrency: 2 })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(finished).toEqual(['b', 'c'])
    slow.resolve()
    expect((await run).removed).toEqual(['slow', 'b', 'c'])
  })

  test('nothing to delete is an empty result', async () => {
    expect(await deleteEach([], async () => ({ kind: 'deleted' }))).toEqual({ removed: [], failed: [] })
  })
})

describe('already gone', () => {
  const refusal = (status: number, code: string) => Object.assign(new Error('refused'), { status, code })

  test('only the owner\'s own not-found code means someone deleted it first', () => {
    expect(isAlreadyGone(refusal(404, 'simulation_run_not_found'), 'simulation_run_not_found')).toBe(true)
    expect(isAlreadyGone(refusal(404, 'workspace_not_found'), 'workspace_not_found')).toBe(true)
  })

  test('a 404 for an unknown Capability, route or Module is a failure, as is any other refusal', () => {
    for (const code of ['capability_not_found', 'route_not_found', 'module_not_installed', 'workspace_not_found']) {
      expect(isAlreadyGone(refusal(404, code), 'simulation_run_not_found')).toBe(false)
    }
    expect(isAlreadyGone(refusal(409, 'simulation_run_not_found'), 'simulation_run_not_found')).toBe(false)
    expect(isAlreadyGone(new Error('Failed to fetch'), 'simulation_run_not_found')).toBe(false)
  })
})

describe('the dialog\'s session', () => {
  test('a close is refused while deletes run, and their outcome is still there once they finish', async () => {
    const gate = later()
    const seen: DeleteSessionState<string>[] = []
    const session = createDeleteSession(['a', 'b'], async item => {
      await gate.promise
      return item === 'a' ? { kind: 'deleted' } : { kind: 'gone' }
    }, state => seen.push(state))
    expect(session.mayClose()).toBe(true)
    const running = session.start()
    expect(session.state().phase).toBe('working')
    expect(session.mayClose()).toBe(false)
    expect(await session.start()).toBe(session.state())
    gate.resolve()
    const finished = await running
    expect(finished).toMatchObject({ phase: 'done', removed: ['a', 'b'], done: 2 })
    expect(session.mayClose()).toBe(true)
    expect(seen.map(state => state.phase)).toEqual(['working', 'working', 'working', 'done'])
  })

  test('Try again runs only the failed ones; each round counts its own results, removed counts them all', async () => {
    let attempt = 0
    const session = createDeleteSession(['a', 'b', 'c'], async item => {
      if (item === 'a') return { kind: 'deleted' }
      attempt += 1
      return item === 'b' && attempt > 2 ? { kind: 'deleted' } : { kind: 'failed', text: 'Try again.' }
    }, undefined, { concurrency: 1 })
    const first = await session.start()
    expect(first.phase).toBe('failed')
    expect(first.round?.removed).toEqual(['a'])
    expect(first.round?.failed.map(failure => failure.item)).toEqual(['b', 'c'])
    expect(failureTitle(WORKSPACE_NOUN, first.round!.failed.length, first.pending.length)).toBe('2 of 3 Workspaces were not deleted')
    expect(failureBody(first.round!)).toBe('1 deleted. These are still there:')
    const second = await session.start()
    expect(second.pending).toEqual(['b', 'c'])
    expect(second.round?.removed).toEqual(['b'])
    expect(failureTitle(WORKSPACE_NOUN, second.round!.failed.length, second.pending.length)).toBe('1 of 2 Workspaces was not deleted')
    expect(failureBody(second.round!)).toBe('1 deleted. This one is still there:')
    expect(second.removed).toEqual(['a', 'b'])
  })

  test('done stays done', async () => {
    let calls = 0
    const session = createDeleteSession(['a'], async () => { calls += 1; return { kind: 'deleted' } })
    await session.start()
    await session.start()
    expect(calls).toBe(1)
  })
})

describe('words', () => {
  test('the confirm button says what and how many', () => {
    expect(deleteLabel(WORKSPACE_NOUN, 1)).toBe('Delete Workspace')
    expect(deleteLabel(WORKSPACE_NOUN, 5)).toBe('Delete 5 Workspaces')
    expect(deleteLabel(SIMULATION_NOUN, 1)).toBe('Delete simulation')
    expect(deleteLabel(SIMULATION_NOUN, 3)).toBe('Delete 3 simulations')
    expect(countedNoun(WORKSPACE_NOUN, 0)).toBe('Workspaces')
  })

  test('the title names one item, or counts many', () => {
    expect(deleteTitle(WORKSPACE_NOUN, [{ key: 'a', label: 'New Workspace · 13 Oct, 17:17' }])).toBe('Delete New Workspace · 13 Oct, 17:17?')
    expect(deleteTitle(SIMULATION_NOUN, [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }])).toBe('Delete 2 simulations?')
  })

  test('progress and failures read as sentences', () => {
    expect(progressText(WORKSPACE_NOUN, 0, 1)).toBe('Deleting the Workspace…')
    expect(progressText(WORKSPACE_NOUN, 2, 5)).toBe('Deleting 5 Workspaces… 2 of 5 done')
    expect(failureTitle(SIMULATION_NOUN, 1, 1)).toBe('The simulation was not deleted')
    expect(failureTitle(WORKSPACE_NOUN, 2, 5)).toBe('2 of 5 Workspaces were not deleted')
    expect(failureTitle(WORKSPACE_NOUN, 1, 5)).toBe('1 of 5 Workspaces was not deleted')
    expect(failureTitle(WORKSPACE_NOUN, 3, 3)).toBe('None of the 3 Workspaces were deleted')
  })
})

describe('selection', () => {
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }]

  test('select all ticks every shown item, and unticks them when all are ticked', () => {
    expect(selectAllState(items, new Set())).toBe('none')
    expect(selectAllState(items, new Set(['a']))).toBe('some')
    const all = toggleAll(items, new Set(['a']))
    expect([...all].sort()).toEqual(['a', 'b', 'c'])
    expect(selectAllState(items, all)).toBe('all')
    expect(toggleAll(items, all).size).toBe(0)
    expect([...toggleOne(toggleOne(new Set(['a']), 'b'), 'a')]).toEqual(['b'])
  })

  test('items a search hides keep their state', () => {
    const shown = [{ key: 'b' }]
    expect([...toggleAll(shown, new Set(['a']))].sort()).toEqual(['a', 'b'])
    expect([...toggleAll(shown, new Set(['a', 'b']))]).toEqual(['a'])
  })

  test('after a reload only items that still exist stay selected', () => {
    expect([...keepExisting(new Set(['a', 'b']), [{ key: 'b' }, { key: 'c' }])]).toEqual(['b'])
  })

  test('the live region says what was deleted', () => {
    expect(deletedText(WORKSPACE_NOUN, [])).toBe('')
    expect(deletedText(WORKSPACE_NOUN, [{ key: 'a', label: 'Grid study' }])).toBe('Deleted Grid study.')
    expect(deletedText(SIMULATION_NOUN, [{ key: 'a', label: 'a' }, { key: 'b', label: 'b' }])).toBe('Deleted 2 simulations.')
  })
})
