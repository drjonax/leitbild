// Test double for the N-1 worker pool: a worker whose first task ends in an uncaught error.
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null }

scope.onmessage = (event: MessageEvent<unknown>): void => {
  throw new Error(`test worker crash on task ${(event.data as { id: number }).id}`)
}
