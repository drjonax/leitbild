import { z } from 'zod'

export interface HistorianLimits {
  /** The samples `maxBytes` affords (historianSampleBudget): derived, never set independently. */
  readonly maxSamples: number
  readonly maxAgeMs: number
  readonly maxBytes: number
  readonly minFreeBytes: number
}

export type HistorianLimitOverrides = Partial<Omit<HistorianLimits, 'maxSamples'>>

/**
 * Disk one stored sample takes at steady state: its table row and its entries
 * in the three sample indexes, in pages that eviction churns. Measured on a
 * local four-unit Halden Run (halden-power-complex, 3,256 series, the process
 * plant, grid and weather recording selections on): its real 40-minute stream
 * replayed eight times over (320 simulated minutes) into a 256 MiB history
 * held 632,511 samples in 222.0 MB, 351 bytes each counting free pages (342
 * to 347 before any eviction; a v1 file written before exception recording
 * measured 356). Budgeted at 384 bytes, 9 % above, for less favourable page
 * fill on other Runs; the store also evicts when the pages in use exceed the
 * file's share, whatever the samples weigh. At 256 MiB: 633,429 samples, on
 * Halden 67 minutes of every series at steady state (149 stored a second).
 */
export const storedSampleBytes = 384

/**
 * Room beside the database file for the write-ahead log and its index. A
 * heartbeat batch writes into every series' last index page at once, so one
 * transaction can put a page per series in the log on top of the 1 MiB at
 * which it checkpoints: 16.3 MB at the peak on Halden (3,256 series), which
 * `journal_size_limit` and the maintenance checkpoint then cut back.
 */
export const walHeadroomBytes = (maxBytes: number): number => Math.min(24 * 1024 * 1024, Math.floor(maxBytes / 4))

/** The schema's root pages at 4 KiB: page one, both tables, the sequence table, the series key and the three sample indexes. */
const schemaBytes = 8 * 4096

/** The sample budget: what the database file holds beside its schema once the log has its room. */
export const historianSampleBudget = (maxBytes: number): number => Math.floor((maxBytes - walHeadroomBytes(maxBytes) - schemaBytes) / storedSampleBytes)

/**
 * Exception recording. A sample is stored only where it says something the
 * series' last stored sample does not: another quality, another boolean or
 * string, or a number more than `relativeDeadband` of its magnitude away;
 * or `sampleHoldMs` of Run time has passed since that sample (a heartbeat).
 *
 * The heartbeat bounds every gap between a series' stored samples to the hold
 * plus the time its source stays silent: one recording interval, or up to a
 * minute where the source itself sends an unchanged value only once a minute
 * (the process-plant operations profile, which then restarts that minute on a
 * value inside the deadband). 30 s + 60 s keeps every gap within the 90 s a
 * step-and-hold reader draws a held value across (`recordedHoldMs`), so
 * every window of two minutes holds samples. Measured on Halden: the
 * longest gap in the last 30 minutes was 88 s (97 s with a 60 s hold), at a
 * cost of 149 rather than 141 stored samples per second.
 *
 * Descriptors declare no resolution, so the deadband is relative and the same
 * for every series: one part in 10^5 of the value. That is twenty times finer
 * than one pixel of the narrowest scale a World trend draws a value on (4 % of
 * its magnitude across a strip of a few hundred pixels), a hundred times finer
 * than the 0.1 % of span process displays read at and the 0.1 % a minute that
 * trend readings call steady, and coarser than solver jitter (a median 1.2e-6
 * relative change per tick on Halden). Numbers that cross or sit at zero store
 * on any change. On Halden it stores 22 % of the samples offered (exact change
 * alone: 99 %; the Pack already drops exact repeats).
 */
export const sampleHoldMs = 30_000
export const relativeDeadband = 1e-5

/**
 * The longest a recording series goes without a stored sample: the heartbeat
 * and the minute its source may stay silent. A reader holds a stored value
 * until the next one, across a silence up to this long and no longer: a
 * longer one is a gap in the record (nothing was offered, the Run was not
 * recording). It is served with the samples a display draws, so no reader
 * guesses it from a recording interval.
 */
export const recordedHoldMs = sampleHoldMs + 60_000

const baseLimits = { maxAgeMs: 7 * 86_400_000, maxBytes: 256 * 1024 * 1024, minFreeBytes: 1024 * 1024 * 1024 }

export const resolveHistorianLimits = (overrides: HistorianLimitOverrides = {}): HistorianLimits => {
  if (Object.hasOwn(overrides, 'maxSamples')) throw new Error('Historian maxSamples is derived from maxBytes and cannot be set')
  const limits = { ...baseLimits, ...overrides }
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 0) throw new Error('Historian limits must be nonnegative safe integers')
  if (limits.maxBytes < 64 * 1024 || limits.maxAgeMs < 1) throw new Error('Historian retention budget is too small')
  return { maxSamples: historianSampleBudget(limits.maxBytes), ...limits }
}

export const defaultHistorianLimits: HistorianLimits = resolveHistorianLimits()

export const runHistorianStatusSchema = z.object({
  seriesCount: z.number().int().nonnegative().nullable(),
  sampleCount: z.number().int().nonnegative().nullable(),
  firstObservedAt: z.string().nullable(), lastObservedAt: z.string().nullable(),
  captureState: z.enum(['recording', 'limited', 'unavailable']), lastError: z.string().nullable(),
  discardedSinceOpen: z.number().int().nonnegative(),
  storageBytes: z.number().int().nonnegative().nullable(),
  databaseBytes: z.number().int().nonnegative().nullable(),
  walBytes: z.number().int().nonnegative().nullable(),
  limits: z.object({ maxSamples: z.number(), maxAgeMs: z.number(), maxBytes: z.number(), minFreeBytes: z.number() }).strict(),
}).strict()
export type RunHistorianStatus = z.infer<typeof runHistorianStatusSchema>
