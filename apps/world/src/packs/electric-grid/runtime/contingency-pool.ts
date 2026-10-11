import { availableParallelism } from 'node:os'
import type { ContingencySnapshot, ScreeningRecords } from './contingency-snapshot.ts'
import { parseContingencyTaskReply, type ContingencyTask } from './contingency-worker-protocol.ts'

// A lazy pool of Bun worker threads for N-1 screening. No worker exists until a screening needs
// one; workers that stay idle for `idleTimeoutMs` are terminated, and the next screening starts
// new ones. A chunk's failure — the kernel throwing, the worker crashing or exiting — fails its
// whole screening with the reason; nothing is re-run on the main thread.

export interface ContingencyPoolConfig {
  /** Most worker threads the pool runs; 0 means it runs none (every screening is inline). */
  readonly size: number
  /** Workers are terminated after this long without a task (ms). */
  readonly idleTimeoutMs: number
  /** The worker's entry module. */
  readonly workerUrl: URL
}

/** Positions [start, end) of a snapshot's contingencies. */
export interface ContingencyChunk {
  readonly start: number
  readonly end: number
}

export interface ContingencyPool {
  readonly size: number
  /** Worker threads alive now. */
  readonly liveWorkerCount: () => number
  /** Screens every chunk into the records on the workers; rejects with the first chunk's failure. */
  readonly screen: (snapshot: ContingencySnapshot, records: ScreeningRecords, chunks: ReadonlyArray<ContingencyChunk>) => Promise<void>
  /** Terminates every worker and fails the screenings still running. */
  readonly close: () => void
}

/** Workers for a host: one core stays with the main thread (the Grid's ticks and the server), at most `cap`. */
export const contingencyPoolSize = (cores: number, cap: number): number => Math.max(0, Math.min(cores - 1, cap))

interface PoolRun {
  readonly snapshot: ContingencySnapshot
  readonly records: ScreeningRecords
  remaining: number
  failed: boolean
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

interface QueuedChunk {
  readonly run: PoolRun
  readonly chunk: ContingencyChunk
}

/** Bun's Worker: a DOM Worker that can stop keeping the process alive. */
type ThreadWorker = Worker & { readonly ref: () => void; readonly unref: () => void }

interface PoolWorker {
  readonly worker: ThreadWorker
  task: { readonly id: number; readonly queued: QueuedChunk } | null
  retired: boolean
}

/**
 * The reason of an uncaught error in a worker. Bun's ErrorEvent carries no error object, only a
 * message that quotes the throwing source before an `error: <message>` line; that line is the reason.
 */
const uncaughtWorkerError = (message: string): string => {
  const reason = message.split('\n').find(line => line.startsWith('error: '))
  return reason === undefined ? message : reason.slice('error: '.length)
}

export const createContingencyPool = (config: ContingencyPoolConfig): ContingencyPool => {
  if (!Number.isSafeInteger(config.size) || config.size < 0) throw new Error(`N-1 worker pool size must be a non-negative integer, got ${config.size}`)
  if (!Number.isSafeInteger(config.idleTimeoutMs) || config.idleTimeoutMs <= 0) throw new Error(`N-1 worker idle timeout must be a positive integer of ms, got ${config.idleTimeoutMs}`)
  let workers: PoolWorker[] = []
  const queue: QueuedChunk[] = []
  const runs = new Set<PoolRun>()
  let sequence = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const failRun = (run: PoolRun, message: string): void => {
    if (run.failed) return
    run.failed = true
    runs.delete(run)
    run.reject(new Error(message))
  }

  const retire = (entry: PoolWorker): void => {
    if (entry.retired) return
    entry.retired = true
    workers = workers.filter(candidate => candidate !== entry)
    entry.worker.terminate()
  }

  const retireAll = (): void => {
    idleTimer = null
    for (const entry of [...workers]) retire(entry)
  }

  const scheduleIdleTermination = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = null
    if (queue.length > 0 || workers.some(entry => entry.task !== null) || workers.length === 0) return
    idleTimer = setTimeout(retireAll, config.idleTimeoutMs)
    idleTimer.unref()
  }

  /** A worker that crashed, exited or broke the protocol fails the screening it was running. */
  const workerFailed = (entry: PoolWorker, reason: string): void => {
    if (entry.retired) return
    const task = entry.task
    entry.task = null
    retire(entry)
    if (task !== null) failRun(task.queued.run, `N-1 screening worker failed: ${reason}`)
    dispatch()
    scheduleIdleTermination()
  }

  const spawn = (): PoolWorker => {
    // The global Worker is typed by the DOM library; on Bun it also has ref() and unref().
    const worker = new Worker(config.workerUrl.href, { name: 'leitbild-grid-n1' }) as ThreadWorker
    // Only a worker with a task keeps the process alive.
    worker.unref()
    const entry: PoolWorker = { worker, task: null, retired: false }
    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      const reply = parseContingencyTaskReply(event.data)
      const task = entry.task
      if (reply === null || task === null || reply.id !== task.id) {
        workerFailed(entry, `unexpected message ${JSON.stringify(event.data)}`)
        return
      }
      entry.task = null
      worker.unref()
      const { run } = task.queued
      if (!reply.ok) failRun(run, `N-1 screening worker failed: ${reply.message}`)
      else if (!run.failed) {
        run.remaining -= 1
        if (run.remaining === 0) {
          runs.delete(run)
          run.resolve()
        }
      }
      dispatch()
      scheduleIdleTermination()
    })
    worker.addEventListener('error', event => workerFailed(entry, uncaughtWorkerError(event.message)))
    worker.addEventListener('messageerror', () => workerFailed(entry, 'a message could not be deserialised'))
    worker.addEventListener('close', event => {
      workerFailed(entry, `the worker exited with code ${(event as CloseEvent).code}`)
    })
    workers.push(entry)
    return entry
  }

  const dispatch = (): void => {
    while (queue.length > 0) {
      if (queue[0]!.run.failed) {
        queue.shift()
        continue
      }
      const entry = workers.find(candidate => candidate.task === null) ?? (workers.length < config.size ? spawn() : null)
      if (entry === null) return
      const queued = queue.shift()!
      sequence += 1
      entry.task = { id: sequence, queued }
      entry.worker.ref()
      const task: ContingencyTask = { id: sequence, snapshot: queued.run.snapshot, records: queued.run.records, start: queued.chunk.start, end: queued.chunk.end }
      try {
        entry.worker.postMessage(task)
      } catch (error) {
        // A task that cannot be posted fails its screening; the worker stays idle and healthy.
        entry.task = null
        entry.worker.unref()
        failRun(queued.run, `N-1 screening task could not be posted to a worker: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return {
    size: config.size,
    liveWorkerCount: () => workers.length,
    screen: async (snapshot, records, chunks) => {
      if (closed) throw new Error('the N-1 worker pool is closed')
      if (config.size === 0) throw new Error('the N-1 worker pool runs no workers; screen inline')
      if (chunks.length === 0) return
      await new Promise<void>((resolve, reject) => {
        const run: PoolRun = { snapshot, records, remaining: chunks.length, failed: false, resolve, reject }
        runs.add(run)
        for (const chunk of chunks) queue.push({ run, chunk })
        if (idleTimer !== null) clearTimeout(idleTimer)
        idleTimer = null
        dispatch()
      })
    },
    close: () => {
      closed = true
      if (idleTimer !== null) clearTimeout(idleTimer)
      queue.length = 0
      for (const run of [...runs]) failRun(run, 'the N-1 worker pool was closed during the screening')
      retireAll()
    },
  }
}

/**
 * Default cap on workers. Measured 2026-10-11 on an 8-core host (4 performance + 4 efficiency):
 * four workers screened every v2 branch 3.4–4.5× faster than one thread; six were no faster.
 */
const defaultMaximumWorkers = 4
/** Workers idle this long are terminated (ms); starting four again took about 40 ms. */
const defaultIdleTimeoutMs = 30_000

const integerFromEnv = (name: string, value: string | undefined, minimum: number, otherwise: number): number => {
  if (value === undefined) return otherwise
  const parsed = Number(value)
  if (value.trim() === '' || !Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer of at least ${minimum}, got ${JSON.stringify(value)}`)
  return parsed
}

/** The process pool's configuration: LEITBILD_GRID_N1_MAX_WORKERS (cap, default 4) and LEITBILD_GRID_N1_IDLE_MS (default 30 000). */
export const contingencyPoolConfigFromEnv = (env: Readonly<Record<string, string | undefined>>): ContingencyPoolConfig => ({
  size: contingencyPoolSize(availableParallelism(), integerFromEnv('LEITBILD_GRID_N1_MAX_WORKERS', env.LEITBILD_GRID_N1_MAX_WORKERS, 0, defaultMaximumWorkers)),
  idleTimeoutMs: integerFromEnv('LEITBILD_GRID_N1_IDLE_MS', env.LEITBILD_GRID_N1_IDLE_MS, 1, defaultIdleTimeoutMs),
  workerUrl: new URL('./contingency-worker.ts', import.meta.url),
})

let processPool: ContingencyPool | null = null

/** The process's N-1 worker pool, created by the first screening that needs it (never at start-up). */
export const processContingencyPool = (): ContingencyPool => {
  processPool ??= createContingencyPool(contingencyPoolConfigFromEnv(process.env))
  return processPool
}

/** Whether the process pool exists yet; it does only after a screening needed it. */
export const processContingencyPoolCreated = (): boolean => processPool !== null
