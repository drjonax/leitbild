import { describe, expect, test } from 'bun:test'
import {
  countedNoun, deleteEach, deleteLabel, deleteTitle, failureTitle, progressText, SIMULATION_NOUN, WORKSPACE_NOUN, type RemoveOutcome,
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
    expect(failureTitle(WORKSPACE_NOUN, 3, 3)).toBe('None of the 3 Workspaces were deleted')
  })
})
