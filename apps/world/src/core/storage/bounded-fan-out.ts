/**
 * How many file operations one listing across every Workspace keeps open at
 * once, so thousands of Workspaces cannot exhaust the process's descriptors.
 */
export const workspaceFanOutLimit = 16

/**
 * Runs `task` over `items` with at most `limit` running at once and returns
 * the results in item order. The first failure rejects the whole map and no
 * further item starts; tasks already running finish unobserved.
 */
export const mapWithConcurrency = async <T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<ReadonlyArray<R>> => {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`concurrency limit must be a positive integer: ${limit}`)
  const results: R[] = new Array(items.length)
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next
      next += 1
      try {
        results[index] = await task(items[index]!)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
