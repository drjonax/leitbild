import { screenContingencyRange } from './contingency.ts'
import { contingencyTaskId, parseContingencyTask, type ContingencyTaskReply } from './contingency-worker-protocol.ts'

// Entry point of an N-1 screening worker thread (contingency-pool.ts). It loads only the kernel,
// the balance rule and the sparse solve: the Grid runtime stays on the main thread.

interface ContingencyWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage: (message: ContingencyTaskReply) => void
}

const scope = globalThis as unknown as ContingencyWorkerScope

scope.onmessage = (event: MessageEvent<unknown>): void => {
  // A message without an id cannot be answered: it throws, the worker dies and the pool reports it.
  const id = contingencyTaskId(event.data)
  try {
    const task = parseContingencyTask(event.data)
    screenContingencyRange(task.snapshot, task.records, task.start, task.end)
    scope.postMessage({ id, ok: true })
  } catch (error) {
    // The pool fails the screening with this reason.
    scope.postMessage({ id, ok: false, message: error instanceof Error ? error.message : String(error) })
  }
}
