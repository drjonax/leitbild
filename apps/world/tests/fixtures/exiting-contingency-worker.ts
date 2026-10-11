// Test double for the N-1 worker pool: a worker that exits with code 3 on its first task.
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null }

scope.onmessage = (): void => {
  process.exit(3)
}
