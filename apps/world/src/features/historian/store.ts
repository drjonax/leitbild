import { existsSync, mkdirSync, statfsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import { relativeDeadband, resolveHistorianLimits, sampleHoldMs, walHeadroomBytes, type HistorianLimitOverrides, type RunHistorianStatus } from './policy.ts'
import {
  packRuntimeRecordingBatchSchema,
  recordingSeriesQuerySchema,
  type PackRuntimeRecordingBatch,
  type RecordedSample,
  type RecordingSeriesDescriptor,
  type RecordingSeriesQuery,
  type RecordingPage,
} from '../../core/model/index.ts'

interface SeriesRow {
  readonly runtime_id: string
  readonly series_id: string
  readonly subject_id: string
  readonly signal_id: string
  readonly title: string
  readonly value_type: RecordingSeriesDescriptor['valueType']
  readonly quantity: string | null
  readonly unit: string | null
}

interface SampleRow {
  readonly sequence: number
  readonly runtime_id: string
  readonly series_id: string
  readonly observed_at: string
  readonly simulation_time: string | null
  readonly elapsed_ms: number | null
  readonly value_type: 'number' | 'boolean' | 'string'
  readonly value_number: number | null
  readonly value_text: string | null
  readonly value_boolean: number | null
  readonly quality: RecordedSample['quality']
}

interface RetainedBoundsRow {
  readonly first_sequence: number | null
  readonly first_observed_at: string | null
  readonly last_observed_at: string | null
  readonly first_simulation_time: string | null
  readonly last_simulation_time: string | null
}

interface WindowSummaryRow {
  readonly sample_count: number
  readonly series_count: number
  readonly good_count: number
  readonly uncertain_count: number
  readonly bad_count: number
  readonly distinct_value_count: number
  readonly numeric_minimum: number | null
  readonly numeric_maximum: number | null
  readonly numeric_average: number | null
}

const sampleFromRow = (row: SampleRow): RecordedSample => ({
  sequence: row.sequence,
  runtimeId: row.runtime_id,
  seriesId: row.series_id,
  observedAt: row.observed_at as RecordedSample['observedAt'],
  ...(row.simulation_time === null ? {} : { simulationTime: row.simulation_time as RecordedSample['simulationTime'] }),
  ...(row.elapsed_ms === null ? {} : { elapsedMs: row.elapsed_ms }),
  value: valueFromRow(row),
  quality: row.quality,
})

export interface SeriesWindowQuery {
  readonly runtimeId: string
  readonly seriesId: string
  readonly from: string
  readonly to: string
  readonly limit: number
  /** After the newest up to the limit, the window's oldest sample where it is not among them: how far back the record reaches, in one more row. */
  readonly withOldest?: boolean
}

export interface RunHistorian {
  readonly record: (runtimeId: string, batch: PackRuntimeRecordingBatch) => void
  readonly listSeries: () => ReadonlyArray<RecordingSeriesDescriptor & { readonly runtimeId: string }>
  readonly query: (query: RecordingSeriesQuery) => RecordingPage
  /** One runtime's series between two simulation times, the newest up to the limit (and the oldest, `withOldest`): raw rows only, without the window summary a query computes. */
  readonly seriesWindow: (query: SeriesWindowQuery) => ReadonlyArray<RecordedSample>
  readonly status: () => RunHistorianStatus
  readonly close: () => void
}

/**
 * One runtime's own series read back by simulation time, newest first up to
 * the limit, and its oldest where asked: what a Pack runtime reads of what it
 * recorded (the PackRuntimeRecordedHistory port).
 */
export const recordedHistoryOf = (historian: Pick<RunHistorian, 'seriesWindow'>, runtimeId: string) => ({
  read: (query: Omit<SeriesWindowQuery, 'runtimeId'>): ReadonlyArray<RecordedSample> => historian.seriesWindow({ ...query, runtimeId }),
})

const currentSchema = 1

/**
 * The most samples an eviction pass removes beyond what its batch needs to fit
 * the budget (createRunHistorian evict). On a mature four-unit Halden file
 * (633k samples, about 200 stored a second) one pass of 5,000 every 25 s held
 * the event loop 110-480 ms; passes of at most 500 run with most batches, 3 ms
 * at the median and 71 ms at most, measured on a loaded machine.
 */
export const EVICTION_PASS = 500

/**
 * How many samples an eviction pass removes: what a batch of `incoming`
 * needs to fit the budget, and otherwise at most EVICTION_PASS towards the
 * slack kept below it (a file over its page budget, a slack's worth). At
 * most 5,000 at once; a batch still too large waits for upkeep to catch up.
 */
export const evictionCount = (store: {
  readonly sampleCount: number
  readonly incoming: number
  readonly maxSamples: number
  readonly slack: number
  readonly overBytes: boolean
}): number => {
  const needed = store.sampleCount + store.incoming - store.maxSamples
  const towardsSlack = Math.max(store.sampleCount + store.incoming - (store.maxSamples - store.slack), store.overBytes ? store.slack : 0)
  return Math.min(5_000, Math.max(needed, Math.min(EVICTION_PASS, towardsSlack)))
}

const historyStorage = (path: string) => {
  const bytes = (file: string) => {
    if (path === ':memory:') return 0
    try { return statSync(file).size } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
  }
  const databaseBytes = bytes(path), walBytes = bytes(`${path}-wal`)
  return { databaseBytes, walBytes, storageBytes: databaseBytes + walBytes + bytes(`${path}-shm`) }
}

/** Optional storage may fail independently. Never invent empty successful history or repair its files. */
export const openRunHistorian = (path: string, options: Parameters<typeof createRunHistorian>[1] = {}): RunHistorian => {
  const limits = resolveHistorianLimits(options.limits)
  try { return createRunHistorian(path, options) }
  catch (error) {
    const message = `Historian unavailable: ${error instanceof Error ? error.message : String(error)}`
    console.error(message)
    let discardedSinceOpen = 0
    const status = (): RunHistorianStatus => ({
      seriesCount: null, sampleCount: null, firstObservedAt: null, lastObservedAt: null,
      captureState: 'unavailable', lastError: message, discardedSinceOpen,
      storageBytes: null, databaseBytes: null, walBytes: null,
      limits,
    })
    const unavailable = (): never => { throw Object.assign(new Error(message), { code: 'history_unavailable', status: status() }) }
    return { record: (_runtimeId, batch) => { discardedSinceOpen += batch.samples.length }, status, listSeries: unavailable, query: unavailable, seriesWindow: unavailable, close: () => {} }
  }
}

const valueColumns = (value: RecordedSample['value']): {
  readonly type: 'number' | 'boolean' | 'string'
  readonly number: number | null
  readonly text: string | null
  readonly boolean: number | null
} => typeof value === 'number'
  ? { type: 'number', number: value, text: null, boolean: null }
  : typeof value === 'boolean'
    ? { type: 'boolean', number: null, text: null, boolean: value ? 1 : 0 }
    : { type: 'string', number: null, text: value, boolean: null }

const valueFromRow = (row: SampleRow): RecordedSample['value'] => {
  if (row.value_type === 'number' && row.value_number !== null) return row.value_number
  if (row.value_type === 'boolean' && row.value_boolean !== null) return row.value_boolean === 1
  if (row.value_type === 'string' && row.value_text !== null) return row.value_text
  throw new Error(`historian sample ${row.runtime_id}/${row.series_id} has invalid ${row.value_type} storage`)
}

/** A series' last stored sample: the value its readers hold until the next. */
interface HeldSample {
  readonly value: RecordedSample['value']
  readonly quality: RecordedSample['quality']
  /** Run time in epoch milliseconds (capture time where the sample has none). */
  readonly at: number
}

/** Whether a sample says something its series' last stored sample does not (policy.ts, exception recording). */
const storesOver = (held: HeldSample | undefined, value: RecordedSample['value'], quality: RecordedSample['quality'], at: number): boolean => {
  if (held === undefined || quality !== held.quality || at < held.at || at - held.at >= sampleHoldMs) return true
  if (typeof value === 'number' && typeof held.value === 'number') return Math.abs(value - held.value) > relativeDeadband * Math.max(Math.abs(value), Math.abs(held.value))
  return value !== held.value
}

const descriptorFromRow = (row: SeriesRow): RecordingSeriesDescriptor & { readonly runtimeId: string } => ({
  runtimeId: row.runtime_id,
  id: row.series_id,
  subjectId: row.subject_id,
  signalId: row.signal_id,
  title: row.title,
  valueType: row.value_type,
  ...(row.quantity === null ? {} : { quantity: row.quantity }),
  ...(row.unit === null ? {} : { unit: row.unit }),
})

export const createRunHistorian = (path: string, options: { readonly limits?: HistorianLimitOverrides; readonly now?: () => number; readonly captureAdmission?: () => string | null } = {}): RunHistorian => {
  const limits = resolveHistorianLimits(options.limits)
  const now = options.now ?? Date.now
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const oversizedAtOpen = path !== ':memory:' && existsSync(path) && historyStorage(path).storageBytes > limits.maxBytes
  const database = new Database(path, { create: !oversizedAtOpen, readonly: oversizedAtOpen, strict: true })
  try {
  database.exec('PRAGMA foreign_keys = ON')
  if (!oversizedAtOpen) {
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA wal_autocheckpoint = 256; PRAGMA journal_size_limit = 4194304')
  }
  const version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
  if (version === 0) {
    database.exec(`
      CREATE TABLE recording_series (
        runtime_id TEXT NOT NULL,
        series_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        title TEXT NOT NULL,
        value_type TEXT NOT NULL CHECK (value_type IN ('number', 'boolean', 'string')),
        quantity TEXT,
        unit TEXT,
        PRIMARY KEY (runtime_id, series_id)
      );
      CREATE TABLE recording_samples (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        runtime_id TEXT NOT NULL,
        series_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        simulation_time TEXT,
        elapsed_ms INTEGER,
        value_type TEXT NOT NULL CHECK (value_type IN ('number', 'boolean', 'string')),
        value_number REAL,
        value_text TEXT,
        value_boolean INTEGER CHECK (value_boolean IN (0, 1)),
        quality TEXT NOT NULL CHECK (quality IN ('good', 'uncertain', 'bad')),
        FOREIGN KEY (runtime_id, series_id) REFERENCES recording_series(runtime_id, series_id)
      );
      CREATE INDEX recording_samples_series_time
        ON recording_samples(runtime_id, series_id, observed_at, sequence);
      CREATE INDEX recording_samples_subject_time
        ON recording_samples(runtime_id, observed_at, sequence);
      PRAGMA user_version = 1;
    `)
  } else if (version !== currentSchema) {
    throw new Error(`unsupported historian schema: ${version}`)
  }
  // Indexes are physical access paths, not a second storage format or a migration.
  if (!oversizedAtOpen) database.exec('CREATE INDEX IF NOT EXISTS recording_samples_time ON recording_samples(observed_at, sequence)')
  const pageSize = database.query<{ page_size: number }, []>('PRAGMA page_size').get()!.page_size
  if (!oversizedAtOpen) database.exec(`PRAGMA max_page_count = ${Math.floor(limits.maxBytes / pageSize)}`)
  const described = new Map<string, RecordingSeriesDescriptor>()
  const keyFor = (runtimeId: string, seriesId: string) => JSON.stringify([runtimeId, seriesId])
  for (const row of database.query<SeriesRow, []>('SELECT * FROM recording_series').all()) described.set(keyFor(row.runtime_id, row.series_id), descriptorFromRow(row))
  let sampleCount = database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM recording_samples').get()!.count
  // Each series' last stored sample this session, against which the next is judged; empty on open, so each series' first sample stores.
  const held = new Map<string, HeldSample>()
  /** Samples offered but not kept (capture refused or failed) and stored samples removed since (evicted or expired); a sample within its series' deadband is not discarded, its held value says it. */
  let discardedSinceOpen = 0
  let lastError: string | null = null
  let lastMaintenanceAt = -Infinity
  let storage = historyStorage(path)
  let storageAllowed = !oversizedAtOpen
  const storageLimitMessage = 'Historian byte/free-space budget reached; capture paused, simulation continues. Retained data remains queryable.'
  const catchingUpMessage = 'Sample retention maintenance is catching up; capture is paused'
  if (oversizedAtOpen) lastError = storageLimitMessage
  // Large existing histories remain untouched: calculate their bounds once,
  // never build a new multi-million-row index or prune them during Run startup.
  const frozenBounds = oversizedAtOpen ? database.query<{ first: string | null; last: string | null }, []>('SELECT MIN(observed_at) AS first, MAX(observed_at) AS last FROM recording_samples').get() : null
  // Eviction keeps the store this far below its budget, so a burst of samples
  // (every series' heartbeat falls due together) lands in room already made.
  const evictionSlack = Math.min(5_000, Math.ceil(limits.maxSamples / 100))
  // The file was over its page budget at the last eviction: each batch evicts until it is within it again.
  let overBytesAtEviction = false
  // The pages the database file may use: the sample budget's bytes, enforced
  // where samples are larger than measured (long strings, long ids).
  const databaseBudgetBytes = limits.maxBytes - walHeadroomBytes(limits.maxBytes)
  const usedDatabaseBytes = (): number => {
    const pages = database.query<{ page_count: number }, []>('PRAGMA page_count').get()!.page_count
    const free = database.query<{ freelist_count: number }, []>('PRAGMA freelist_count').get()!.freelist_count
    return (pages - free) * pageSize
  }
  const forget = (removed: number): void => {
    sampleCount -= removed
    discardedSinceOpen += removed
  }
  /** Bounded upkeep: free space, the log, expiry by age, and eviction to make room for `incoming` samples. */
  const maintenance = (incoming = 0): void => {
    lastMaintenanceAt = now()
    if (oversizedAtOpen) return
    const admissionError = options.captureAdmission?.()
    if (admissionError) { storageAllowed = false; lastError = admissionError; return }
    storageAllowed = true
    if (path !== ':memory:') {
      database.exec('PRAGMA wal_checkpoint(PASSIVE)')
      storage = historyStorage(path)
      // A completed checkpoint can leave a large reusable WAL. Reclaim it only
      // when no reader prevents truncation; SQLite returns busy rather than waiting.
      if (storage.walBytes > Math.min(4 * 1024 * 1024, walHeadroomBytes(limits.maxBytes) / 2)) {
        database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        storage = historyStorage(path)
      }
      const fs = statfsSync(dirname(path))
      storageAllowed = fs.bavail * fs.bsize >= limits.minFreeBytes && storage.storageBytes <= limits.maxBytes
      if (!storageAllowed) { lastError = storageLimitMessage; return }
    }
    const expiredBefore = new Date(now() - limits.maxAgeMs).toISOString()
    const expired = database.query<{ runtime_id: string; series_id: string }, [string]>('DELETE FROM recording_samples WHERE sequence IN (SELECT sequence FROM recording_samples WHERE observed_at < ? ORDER BY observed_at, sequence LIMIT 5000) RETURNING runtime_id, series_id').all(expiredBefore)
    forget(expired.length)
    // Expiry by age may take a series' last stored sample: its next sample stores.
    for (const row of expired) held.delete(keyFor(row.runtime_id, row.series_id))
    evict(incoming)
  }
  const evictOldest = database.query<unknown, [number]>(`
    DELETE FROM recording_samples WHERE sequence IN (
      SELECT oldest.sequence FROM recording_samples AS oldest
      WHERE EXISTS (
        SELECT 1 FROM recording_samples AS later INDEXED BY recording_samples_series_time
        WHERE later.runtime_id = oldest.runtime_id AND later.series_id = oldest.series_id AND later.sequence > oldest.sequence
      )
      ORDER BY oldest.observed_at, oldest.sequence LIMIT ?
    )
  `)
  /**
   * Fair eviction: the oldest retained samples go first, whichever series
   * holds them, and never a series' newest (one with no later sample of its
   * series), the value its readers hold. Every series keeps the same span of
   * time, the measure its readers' windows ask for: a series that stores
   * more costs itself more samples, not the others their history.
   *
   * A pass removes what `incoming` needs to fit the budget, and otherwise at
   * most EVICTION_PASS samples towards the slack below it (evictionCount), so
   * the Run's event loop is held briefly and the next batch carries on.
   */
  const evict = (incoming: number): void => {
    overBytesAtEviction = usedDatabaseBytes() > databaseBudgetBytes
    const count = evictionCount({ sampleCount, incoming, maxSamples: limits.maxSamples, slack: evictionSlack, overBytes: overBytesAtEviction })
    if (count > 0) forget(evictOldest.run(count).changes)
  }

  const insertSeries = database.prepare(`
    INSERT INTO recording_series (
      runtime_id, series_id, subject_id, signal_id, title, value_type, quantity, unit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(runtime_id, series_id) DO NOTHING
  `)
  const insertSample = database.prepare(`
    INSERT INTO recording_samples (
      runtime_id, series_id, observed_at, simulation_time, elapsed_ms,
      value_type, value_number, value_text, value_boolean, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const writeBatch = database.transaction((runtimeId: string, descriptors: PackRuntimeRecordingBatch['descriptors'], samples: PackRuntimeRecordingBatch['samples']): void => {
    for (const descriptor of descriptors) {
      insertSeries.run(
        runtimeId,
        descriptor.id,
        descriptor.subjectId,
        descriptor.signalId,
        descriptor.title,
        descriptor.valueType,
        descriptor.quantity ?? null,
        descriptor.unit ?? null,
      )
    }
    for (const sample of samples) {
      const value = valueColumns(sample.value)
      insertSample.run(
        runtimeId,
        sample.seriesId,
        sample.observedAt,
        sample.simulationTime ?? null,
        sample.elapsedMs ?? null,
        value.type,
        value.number,
        value.text,
        value.boolean,
        sample.quality,
      )
    }
  })

  return {
    record: (runtimeId, input): void => {
      const batch = packRuntimeRecordingBatchSchema.parse(input) as PackRuntimeRecordingBatch
      if (batch.samples.length === 0 && batch.descriptors.length === 0) return
      if (batch.samples.length > 20_000 || described.size + batch.descriptors.filter(item => !described.has(keyFor(runtimeId, item.id))).length > 20_000) throw new Error('Historian batch/series limit exceeded (20,000)')
      const pending = new Map<string, RecordingSeriesDescriptor>()
      for (const descriptor of batch.descriptors) {
        const key = keyFor(runtimeId, descriptor.id)
        const previous = pending.get(key) ?? described.get(key)
        if (previous && (previous.subjectId !== descriptor.subjectId || previous.signalId !== descriptor.signalId || previous.valueType !== descriptor.valueType || previous.unit !== descriptor.unit || previous.quantity !== descriptor.quantity)) throw new Error(`Historian series semantics changed: ${runtimeId}/${descriptor.id}`)
        pending.set(key, descriptor)
      }
      for (const sample of batch.samples) {
        const descriptor = pending.get(keyFor(runtimeId, sample.seriesId)) ?? described.get(keyFor(runtimeId, sample.seriesId))
        if (!descriptor || typeof sample.value !== descriptor.valueType) throw new Error(`Historian sample does not match its descriptor: ${runtimeId}/${sample.seriesId}`)
      }
      // Exception recording (policy.ts): only what each series' last stored sample does not already say.
      const admitted = new Map<string, HeldSample>()
      const kept = batch.samples.filter(sample => {
        const key = keyFor(runtimeId, sample.seriesId)
        const at = Date.parse(sample.simulationTime ?? sample.observedAt)
        if (!storesOver(admitted.get(key) ?? held.get(key), sample.value, sample.quality, at)) return false
        admitted.set(key, { value: sample.value, quality: sample.quality, at })
        return true
      })
      let written = false
      try {
        if (now() - lastMaintenanceAt >= 10_000 || sampleCount + kept.length > limits.maxSamples) maintenance(kept.length)
        else if (storageAllowed && !oversizedAtOpen && (overBytesAtEviction || sampleCount + kept.length > limits.maxSamples - evictionSlack)) evict(kept.length)
        if (!storageAllowed || sampleCount > limits.maxSamples) {
          if (storageAllowed) lastError = catchingUpMessage
          discardedSinceOpen += kept.length
          return
        }
        if (kept.length > 0 || batch.descriptors.length > 0) {
          const samples = kept.map(sample => ({ ...sample, observedAt: new Date(sample.observedAt).toISOString(), ...(sample.simulationTime === undefined ? {} : { simulationTime: new Date(sample.simulationTime).toISOString() }) })) as PackRuntimeRecordingBatch['samples']
          writeBatch(runtimeId, batch.descriptors, samples)
          written = true
          for (const descriptor of batch.descriptors) described.set(keyFor(runtimeId, descriptor.id), descriptor)
          for (const [key, sample] of admitted) held.set(key, sample)
          sampleCount += samples.length
        }
        lastError = null
        if (sampleCount > limits.maxSamples) maintenance()
        if (sampleCount > limits.maxSamples && lastError === null) lastError = catchingUpMessage
      } catch (error) {
        // Optional observations must not stop physics or its canonical checkpoint.
        lastError = error instanceof Error ? error.message : String(error)
        if (!written) discardedSinceOpen += kept.length
      }
    },
    listSeries: (): ReadonlyArray<RecordingSeriesDescriptor & { readonly runtimeId: string }> =>
      database.query<SeriesRow, []>(`
        SELECT runtime_id, series_id, subject_id, signal_id, title, value_type, quantity, unit
        FROM recording_series
        ORDER BY runtime_id, subject_id, signal_id
      `).all().map(descriptorFromRow),
    query: (input): RecordingPage => {
      const query = recordingSeriesQuerySchema.parse(input)
      const selectionPredicates: string[] = []
      const selectionValues: Array<string | number> = []
      // Both sample indexes lead with runtime_id. A read that names its series
      // (by id, subject or signal) takes the (runtime_id, series_id) pairs that
      // match from the series catalog and reaches each pair's samples through
      // recording_samples_series_time, so none of the statements below scans
      // the samples table. Every stored sample belongs to a described series
      // (record), so these are the rows the names select.
      const named = ([
        ['runtime_id', query.runtimeId],
        ['series_id', query.seriesId],
        ['subject_id', query.subjectId],
        ['signal_id', query.signalId],
      ] as const).flatMap(([column, value]) => value === undefined ? [] : [{ column, value }])
      if (query.seriesId !== undefined || query.subjectId !== undefined || query.signalId !== undefined) {
        selectionPredicates.push(`(runtime_id, series_id) IN (
          SELECT runtime_id, series_id FROM recording_series
          WHERE ${named.map(({ column }) => `${column} = ?`).join(' AND ')}
        )`)
        selectionValues.push(...named.map(({ value }) => value))
      } else if (query.runtimeId !== undefined) {
        selectionPredicates.push('runtime_id = ?')
        selectionValues.push(query.runtimeId)
      }
      const predicates = [...selectionPredicates]
      const values = [...selectionValues]
      const timeColumn = query.timeAxis === 'simulation' ? 'simulation_time' : 'observed_at'
      if (query.from !== undefined) { predicates.push(`${timeColumn} >= ?`); values.push(new Date(query.from).toISOString()) }
      if (query.to !== undefined) { predicates.push(`${timeColumn} <= ?`); values.push(new Date(query.to).toISOString()) }
      const selectedColumns = `sequence, runtime_id, series_id, observed_at, simulation_time, elapsed_ms,
               value_type, value_number, value_text, value_boolean, quality`
      const filteredWhere = predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`
      const window = database.query<WindowSummaryRow, Array<string | number>>(`
        SELECT COUNT(*) AS sample_count,
               COUNT(DISTINCT json_array(runtime_id, series_id)) AS series_count,
               COALESCE(SUM(quality = 'good'), 0) AS good_count,
               COALESCE(SUM(quality = 'uncertain'), 0) AS uncertain_count,
               COALESCE(SUM(quality = 'bad'), 0) AS bad_count,
               COUNT(DISTINCT CASE value_type
                 WHEN 'number' THEN 'n:' || CAST(value_number AS TEXT)
                 WHEN 'boolean' THEN 'b:' || CAST(value_boolean AS TEXT)
                 ELSE 's:' || value_text
               END) AS distinct_value_count,
               MIN(value_number) AS numeric_minimum,
               MAX(value_number) AS numeric_maximum,
               AVG(value_number) AS numeric_average
        FROM recording_samples
        ${filteredWhere}
      `).get(...values)!
      const firstRow = database.query<SampleRow, Array<string | number>>(`
        SELECT ${selectedColumns} FROM recording_samples ${filteredWhere} ORDER BY ${timeColumn} ASC, sequence ASC LIMIT 1
      `).get(...values)
      const lastRow = database.query<SampleRow, Array<string | number>>(`
        SELECT ${selectedColumns} FROM recording_samples ${filteredWhere} ORDER BY ${timeColumn} DESC, sequence DESC LIMIT 1
      `).get(...values)
      const selectedWhere = selectionPredicates.length === 0 ? '' : `WHERE ${selectionPredicates.join(' AND ')}`
      const retained = database.query<RetainedBoundsRow, Array<string | number>>(`
        SELECT MIN(sequence) AS first_sequence,
               MIN(observed_at) AS first_observed_at,
               MAX(observed_at) AS last_observed_at,
               MIN(simulation_time) AS first_simulation_time,
               MAX(simulation_time) AS last_simulation_time
        FROM recording_samples
        ${selectedWhere}
      `).get(...selectionValues)
      const retainedFromSequence = retained?.first_sequence ?? null
      const retainedFromObservedAt = retained?.first_observed_at ?? null
      const retainedToObservedAt = retained?.last_observed_at ?? null
      const retainedFromSimulationTime = retained?.first_simulation_time ?? null
      const retainedToSimulationTime = retained?.last_simulation_time ?? null
      const retainedStart = query.timeAxis === 'simulation' ? retainedFromSimulationTime : retainedFromObservedAt
      const requestedFrom = query.from === undefined ? undefined : new Date(query.from).toISOString()
      const requestedTo = query.to === undefined ? undefined : new Date(query.to).toISOString()
      const retentionGap = (query.beforeSequence !== undefined && retainedFromSequence !== null && query.beforeSequence <= retainedFromSequence)
        || (retainedStart !== null && requestedFrom !== undefined && requestedFrom < retainedStart)
        || (retainedStart !== null && requestedTo !== undefined && requestedTo < retainedStart)
      const shared = {
        windowSummary: {
          sampleCount: window.sample_count,
          seriesCount: window.series_count,
          qualityCounts: { good: window.good_count, uncertain: window.uncertain_count, bad: window.bad_count },
          firstSample: firstRow === null ? null : sampleFromRow(firstRow),
          lastSample: lastRow === null ? null : sampleFromRow(lastRow),
          distinctValueCount: window.distinct_value_count,
          // A raw wide export may mix units/subjects/runtimes. Numerical
          // aggregation only has a defined meaning for one actual series.
          numericMinimum: window.series_count === 1 ? window.numeric_minimum : null,
          numericMaximum: window.series_count === 1 ? window.numeric_maximum : null,
          numericAverage: window.series_count === 1 ? window.numeric_average : null,
        },
        retainedFromSequence,
        retainedFromObservedAt,
        retainedToObservedAt,
        retainedFromSimulationTime,
        retainedToSimulationTime,
        retentionGap,
      }
      if (query.mode === 'summary') return { mode: 'summary', ...shared }

      // The raw cursor limits only this page, never the whole-window summary.
      if (query.beforeSequence !== undefined) { predicates.push('sequence < ?'); values.push(query.beforeSequence) }
      const limit = query.limit ?? 2_000
      const rows = database.query<SampleRow, Array<string | number>>(`
        SELECT ${selectedColumns}
        FROM recording_samples
        ${predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`}
        ORDER BY sequence DESC
        LIMIT ?
      `).all(...values, limit + 1)
      const samples = rows.slice(0, limit).map(sampleFromRow)
      return {
        mode: 'raw', ...shared, samples,
        hasMore: rows.length > limit,
        nextBeforeSequence: rows.length > limit ? samples.at(-1)!.sequence : null,
      }
    },
    // The same rows a raw query by simulation time returns for the series,
    // without its window summary and retained bounds, which cost more than
    // the rows on a long Run.
    seriesWindow: (query): ReadonlyArray<RecordedSample> => {
      const from = new Date(query.from).toISOString()
      const to = new Date(query.to).toISOString()
      const columns = `sequence, runtime_id, series_id, observed_at, simulation_time, elapsed_ms,
             value_type, value_number, value_text, value_boolean, quality`
      const window = 'FROM recording_samples WHERE runtime_id = ? AND series_id = ? AND simulation_time >= ? AND simulation_time <= ?'
      const newest = database.query<SampleRow, [string, string, string, string, number]>(`SELECT ${columns} ${window} ORDER BY sequence DESC LIMIT ?`)
        .all(query.runtimeId, query.seriesId, from, to, query.limit).map(sampleFromRow)
      if (query.withOldest !== true || newest.length < query.limit) return newest
      // The window's first sample, one row by its index: never the window between it and the newest.
      const oldest = database.query<SampleRow, [string, string, string, string]>(`SELECT ${columns} ${window} ORDER BY sequence ASC LIMIT 1`)
        .get(query.runtimeId, query.seriesId, from, to)
      return oldest === null || newest.some(sample => sample.sequence === oldest.sequence) ? newest : [...newest, sampleFromRow(oldest)]
    },
    status: (): RunHistorianStatus => {
      const first = frozenBounds ? { observed_at: frozenBounds.first } : database.query<{ observed_at: string }, []>('SELECT observed_at FROM recording_samples ORDER BY observed_at LIMIT 1').get()
      const last = frozenBounds ? { observed_at: frozenBounds.last } : database.query<{ observed_at: string }, []>('SELECT observed_at FROM recording_samples ORDER BY observed_at DESC LIMIT 1').get()
      return {
        seriesCount: described.size,
        sampleCount,
        firstObservedAt: first?.observed_at ?? null,
        lastObservedAt: last?.observed_at ?? null,
        captureState: lastError ? 'limited' : 'recording', lastError, discardedSinceOpen, ...historyStorage(path), limits,
      }
    },
    close: (): void => {
      try {
        if (!oversizedAtOpen) database.exec('PRAGMA wal_checkpoint(PASSIVE)')
      } finally { database.close() }
    },
  }
  } catch (error) {
    database.close()
    throw error
  }
}
