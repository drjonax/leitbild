import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IsoTimestamp, RecordedSample } from '../src/core/model/index.ts'
import {
  defaultHistorianLimits,
  historianSampleBudget,
  relativeDeadband,
  resolveHistorianLimits,
  sampleHoldMs,
  storedSampleBytes,
  walHeadroomBytes,
} from '../src/features/historian/policy.ts'
import { createRunHistorian, EVICTION_PASS, evictionCount, type RunHistorian } from '../src/features/historian/store.ts'
import { HOLD_GAP_MS } from '../src/packs/process-plant/ui/plant-card-sparkline.ts'

const t0 = Date.parse('2026-01-01T10:00:00.000Z')
const iso = (ms: number): IsoTimestamp => new Date(ms).toISOString() as IsoTimestamp
const sample = (seriesId: string, value: RecordedSample['value'], ms: number, quality: RecordedSample['quality'] = 'good') =>
  ({ seriesId, value, observedAt: iso(ms), simulationTime: iso(ms), quality })
const numberSeries = (id: string) => ({ id, subjectId: 'unit', signalId: id, title: id, valueType: 'number' as const })
/** A series' stored samples, oldest first. */
const stored = (historian: RunHistorian, seriesId: string, runtimeId = 'rt') =>
  [...historian.seriesWindow({ runtimeId, seriesId, from: iso(t0 - 86_400_000), to: iso(t0 + 86_400_000), limit: 100_000 })].reverse()
const withTemporaryDirectory = async (run: (dir: string) => Promise<void> | void): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'historian-retention-'))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

describe('Run Historian retention', () => {
  test('the sample budget is derived from the byte budget and cannot be set on its own', () => {
    expect(() => resolveHistorianLimits({ maxSamples: 250_000 } as never)).toThrow('derived from maxBytes')
    expect(defaultHistorianLimits.maxSamples).toBe(historianSampleBudget(defaultHistorianLimits.maxBytes))
    for (const maxBytes of [64 * 1024, 1024 * 1024, defaultHistorianLimits.maxBytes]) {
      const { maxSamples } = resolveHistorianLimits({ maxBytes })
      expect(maxSamples).toBeGreaterThan(0)
      expect(maxSamples * storedSampleBytes + walHeadroomBytes(maxBytes)).toBeLessThanOrEqual(maxBytes)
    }
  })

  test('stores only what the last stored sample does not say: a number past its deadband, another boolean, string or quality, a heartbeat', () => {
    const historian = createRunHistorian(':memory:')
    try {
      historian.record('rt', {
        descriptors: [numberSeries('n'), numberSeries('z'), { ...numberSeries('b'), valueType: 'boolean' }, { ...numberSeries('s'), valueType: 'string' }],
        samples: [
          sample('n', 100, t0),
          // Within one part in 10^5 of the stored 100, however many times it moves inside it.
          sample('n', 100 + 100 * relativeDeadband * 0.5, t0 + 1_000),
          sample('n', 100 + 100 * relativeDeadband * 0.9, t0 + 2_000),
          sample('n', 100 + 100 * relativeDeadband * 2, t0 + 3_000),
          // A quality change stores, the same value and quality after it do not.
          sample('n', 100 + 100 * relativeDeadband * 2, t0 + 4_000, 'uncertain'),
          sample('n', 100 + 100 * relativeDeadband * 2, t0 + 5_000, 'uncertain'),
          sample('b', true, t0), sample('b', true, t0 + 1_000), sample('b', false, t0 + 2_000), sample('b', false, t0 + 3_000),
          sample('s', 'open', t0), sample('s', 'open', t0 + 1_000), sample('s', 'closed', t0 + 2_000),
          // At zero a relative band is empty: any departure from it stores, zero again does not.
          sample('z', 0, t0), sample('z', 0, t0 + 1_000), sample('z', 1e-300, t0 + 2_000), sample('z', -1e-300, t0 + 3_000),
        ],
      })
      const moved = 100 + 100 * relativeDeadband * 2
      expect(stored(historian, 'n').map(item => [item.value, item.quality])).toEqual([[100, 'good'], [moved, 'good'], [moved, 'uncertain']])
      expect(stored(historian, 'b').map(item => item.value)).toEqual([true, false])
      expect(stored(historian, 's').map(item => item.value)).toEqual(['open', 'closed'])
      expect(stored(historian, 'z').map(item => item.value)).toEqual([0, 1e-300, -1e-300])
      // The heartbeat: an unchanged value stores once the hold has passed since the last stored sample, not before.
      historian.record('rt', { descriptors: [], samples: [sample('n', moved, t0 + 4_000 + sampleHoldMs - 1, 'uncertain')] })
      historian.record('rt', { descriptors: [], samples: [sample('n', moved, t0 + 4_000 + sampleHoldMs, 'uncertain')] })
      // Run time going back (a restored Run) stores.
      historian.record('rt', { descriptors: [], samples: [sample('n', moved, t0 - 1_000, 'uncertain')] })
      expect(stored(historian, 'n').map(item => Date.parse(item.simulationTime!) - t0)).toEqual([0, 3_000, 4_000, 4_000 + sampleHoldMs, -1_000])
      // A sample inside the deadband is said by the held value: not discarded.
      expect(historian.status()).toMatchObject({ sampleCount: 12, discardedSinceOpen: 0, captureState: 'recording' })
    } finally { historian.close() }
  })

  test('the heartbeat leaves a sample in every two-minute window and no gap a step-and-hold reader would break', () => {
    // A source that re-sends an unchanged value only a minute after its last (the process-plant operations
    // profile) may restart that minute on a value inside the deadband: the hold plus that minute stays within
    // the gap readers draw a held value across.
    expect(sampleHoldMs + 60_000).toBeLessThanOrEqual(HOLD_GAP_MS)
    const historian = createRunHistorian(':memory:')
    try {
      historian.record('rt', { descriptors: [numberSeries('every-second'), numberSeries('once-a-minute')], samples: [] })
      let sent: { value: number; at: number } | undefined
      for (let second = 0; second <= 1_200; second += 1) {
        const at = t0 + second * 1_000
        // Moves inside the deadband every 89 s, just before the store's hold has passed, otherwise exactly steady.
        const value = 500 + (Math.floor(second / 89) % 2) * 500 * relativeDeadband * 0.5
        const samples = [sample('every-second', 42, at)]
        if (sent === undefined || sent.value !== value || at - sent.at >= 60_000) {
          samples.push(sample('once-a-minute', value, at))
          sent = { value, at }
        }
        historian.record('rt', { descriptors: [], samples })
      }
      const end = t0 + 1_200_000
      for (const seriesId of ['every-second', 'once-a-minute']) {
        const times = stored(historian, seriesId).map(item => Date.parse(item.simulationTime!))
        const gaps = times.slice(1).map((time, index) => time - times[index]!)
        expect(Math.max(...gaps, end - times.at(-1)!)).toBeLessThan(HOLD_GAP_MS)
        for (let from = t0; from + 120_000 <= end; from += 10_000) {
          expect(historian.seriesWindow({ runtimeId: 'rt', seriesId, from: iso(from), to: iso(from + 120_000), limit: 1 })).toHaveLength(1)
        }
      }
      expect(stored(historian, 'every-second')).toHaveLength(1_200_000 / sampleHoldMs + 1)
    } finally { historian.close() }
  })

  test('a skewed 3,000-series load keeps 30 minutes of every series within its byte budget, and every series its newest sample', async () => {
    await withTemporaryDirectory(dir => {
      const busy = Array.from({ length: 10 }, (_, index) => `busy:${index}`)
      const quiet = Array.from({ length: 2_980 }, (_, index) => `quiet:${index}`)
      const gone = Array.from({ length: 10 }, (_, index) => `gone:${index}`)
      // Busy series store every second; quiet ones are sent every two minutes; gone ones only once, at the start.
      const perSecond = busy.length + quiet.length / 120
      // A byte budget for 33 minutes of this load, run for 40.
      let maxBytes = 64 * 1024
      while (historianSampleBudget(maxBytes) < perSecond * 33 * 60) maxBytes += 64 * 1024
      let now = t0
      const historian = createRunHistorian(join(dir, 'history.sqlite'), { now: () => now, limits: { maxBytes, minFreeBytes: 0 } })
      try {
        historian.record('rt', { descriptors: [...busy, ...quiet, ...gone].map(numberSeries), samples: gone.map(id => sample(id, 7, t0)) })
        for (let minute = 0; minute < 40; minute += 1) {
          const start = t0 + minute * 60_000
          now = start + 60_000
          historian.record('rt', {
            descriptors: [],
            samples: [
              ...Array.from({ length: 60 }, (_, second) => busy.map((id, index) => sample(id, minute * 60 + second + index / 10, start + second * 1_000))).flat(),
              ...(minute % 2 === 0 ? quiet.map((id, index) => sample(id, index, start)) : []),
            ],
          })
        }
        const status = historian.status()
        expect(status.discardedSinceOpen).toBeGreaterThan(0)
        expect(status).toMatchObject({ captureState: 'recording', lastError: null })
        expect(status.sampleCount!).toBeLessThanOrEqual(status.limits.maxSamples)
        expect(status.storageBytes!).toBeLessThanOrEqual(maxBytes)
        const end = t0 + 40 * 60_000 - 1_000
        for (const id of [...busy, ...quiet]) {
          const [newest, oldest] = historian.seriesWindow({ runtimeId: 'rt', seriesId: id, from: iso(t0), to: iso(end), limit: 1, withOldest: true })
          expect(end - Date.parse(oldest!.simulationTime!)).toBeGreaterThanOrEqual(30 * 60_000)
          expect(Date.parse(newest!.simulationTime!)).toBe(id.startsWith('busy') ? end : end - 119_000)
        }
        // The oldest samples in the store, and the only ones of their series: kept, as what their readers hold.
        for (const id of gone) expect(stored(historian, id).map(item => item.value)).toEqual([7])
      } finally { historian.close() }
    })
  }, 120_000)

  test('a v1 history written before exception recording opens, reads, keeps recording and keeps each series\' newest', async () => {
    await withTemporaryDirectory(dir => {
      const path = join(dir, 'history.sqlite')
      // The v1 schema exactly as earlier code wrote it (user_version 1, two sample indexes).
      const earlier = new Database(path, { create: true, strict: true })
      earlier.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE recording_series (
          runtime_id TEXT NOT NULL, series_id TEXT NOT NULL, subject_id TEXT NOT NULL, signal_id TEXT NOT NULL, title TEXT NOT NULL,
          value_type TEXT NOT NULL CHECK (value_type IN ('number', 'boolean', 'string')), quantity TEXT, unit TEXT,
          PRIMARY KEY (runtime_id, series_id)
        );
        CREATE TABLE recording_samples (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, runtime_id TEXT NOT NULL, series_id TEXT NOT NULL, observed_at TEXT NOT NULL,
          simulation_time TEXT, elapsed_ms INTEGER, value_type TEXT NOT NULL CHECK (value_type IN ('number', 'boolean', 'string')),
          value_number REAL, value_text TEXT, value_boolean INTEGER CHECK (value_boolean IN (0, 1)),
          quality TEXT NOT NULL CHECK (quality IN ('good', 'uncertain', 'bad')),
          FOREIGN KEY (runtime_id, series_id) REFERENCES recording_series(runtime_id, series_id)
        );
        CREATE INDEX recording_samples_series_time ON recording_samples(runtime_id, series_id, observed_at, sequence);
        CREATE INDEX recording_samples_subject_time ON recording_samples(runtime_id, observed_at, sequence);
        PRAGMA user_version = 1;
      `)
      const series = earlier.prepare('INSERT INTO recording_series VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      for (const id of ['level', 'trip']) series.run('rt', id, 'unit', id, id, id === 'trip' ? 'boolean' : 'number', null, null)
      const insert = earlier.prepare(`INSERT INTO recording_samples (runtime_id, series_id, observed_at, simulation_time, elapsed_ms, value_type, value_number, value_text, value_boolean, quality)
        VALUES ('rt', ?, ?, ?, NULL, ?, ?, NULL, ?, 'good')`)
      insert.run('trip', iso(t0), iso(t0), 'boolean', null, 1)
      // Earlier code stored repeated values: they stay as written.
      for (let second = 1; second <= 30; second += 1) insert.run('level', iso(t0 + second * 1_000), iso(t0 + second * 1_000), 'number', second <= 10 ? 50 : second, null)
      earlier.close()

      // Upkeep follows the Run's clock, which moves with the samples it records.
      let now = t0 + 31_000
      const opened = () => createRunHistorian(path, { limits: { maxBytes: 1024 * 1024, minFreeBytes: 0 }, now: () => now })
      const historian = opened()
      try {
        expect(historian.status()).toMatchObject({ seriesCount: 2, sampleCount: 31, captureState: 'recording' })
        expect(stored(historian, 'level')).toHaveLength(30)
        expect(stored(historian, 'trip').map(item => item.value)).toEqual([true])
        // It keeps recording, under the budget its bytes afford, the oldest first but never a series' newest.
        const { maxSamples } = historian.status().limits
        const last = 30 + maxSamples + 10
        for (let first = 31; first <= last; first += 20) {
          now = t0 + (first + 20) * 1_000
          historian.record('rt', { descriptors: [], samples: Array.from({ length: Math.min(20, last - first + 1) }, (_, index) => sample('level', first + index, t0 + (first + index) * 1_000)) })
        }
        const status = historian.status()
        expect(status).toMatchObject({ captureState: 'recording', lastError: null })
        expect(status.sampleCount!).toBeLessThanOrEqual(maxSamples)
        expect(status.discardedSinceOpen).toBe(1 + last - status.sampleCount!)
        expect(stored(historian, 'trip').map(item => item.value)).toEqual([true])
        expect(stored(historian, 'level').at(-1)?.value).toBe(last)
      } finally { historian.close() }
      // The file is still v1: the same tables, one more index (a physical access path), and it opens again.
      const inspected = new Database(path, { readonly: true })
      try {
        expect(inspected.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(1)
        expect(inspected.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name))
          .toEqual(['recording_samples', 'recording_series', 'sqlite_sequence'])
        expect(inspected.query<{ name: string }, []>("SELECT name FROM pragma_table_info('recording_samples')").all()).toHaveLength(11)
      } finally { inspected.close() }
      const reopened = opened()
      try { expect(reopened.status().captureState).toBe('recording') } finally { reopened.close() }
    })
  })

  test('an eviction pass makes room for its batch, and otherwise removes at most EVICTION_PASS samples towards the slack', () => {
    const halden = { maxSamples: 633_429, slack: 5_000, overBytes: false }
    // Below the slack's mark nothing goes; past it, a pass at a time; a batch that would cross the budget takes what it needs.
    expect(evictionCount({ ...halden, sampleCount: 600_000, incoming: 200 })).toBeLessThanOrEqual(0)
    expect(evictionCount({ ...halden, sampleCount: 628_429, incoming: 200 })).toBe(200)
    expect(evictionCount({ ...halden, sampleCount: 631_000, incoming: 2_000 })).toBe(EVICTION_PASS)
    expect(evictionCount({ ...halden, sampleCount: 633_000, incoming: 2_000 })).toBe(1_571)
    expect(evictionCount({ ...halden, sampleCount: 633_429, incoming: 20_000 })).toBe(5_000)
    // Over its page budget, a pass takes a slack's worth, a pass at a time.
    expect(evictionCount({ ...halden, sampleCount: 100_000, incoming: 200, overBytes: true })).toBe(EVICTION_PASS)
    expect(evictionCount({ maxSamples: 1_962, slack: 20, overBytes: true, sampleCount: 100, incoming: 5 })).toBe(20)
  })

  test('evicts ahead of the budget with each batch, settling the slack below it at the rate samples arrive, never above it', () => {
    let now = t0
    const historian = createRunHistorian(':memory:', { now: () => now, limits: { maxBytes: 4 * 1024 * 1024, minFreeBytes: 0 } })
    try {
      const series = Array.from({ length: 1_000 }, (_, index) => `s:${index}`)
      const { maxSamples } = historian.status().limits
      const slack = Math.min(5_000, Math.ceil(maxSamples / 100))
      historian.record('rt', { descriptors: series.map(numberSeries), samples: [] })
      // Every sample says something new, so each stores: a second of `width` series a batch, a second apart.
      let second = 0
      const record = (width: number): void => {
        const before = historian.status()
        now = t0 + second * 1_000
        historian.record('rt', { descriptors: [], samples: series.slice(0, width).map((id, index) => sample(id, second * 10 + index / 1_000, now)) })
        second += 1
        const after = historian.status()
        expect(after.sampleCount!).toBeLessThanOrEqual(maxSamples)
        expect(after.discardedSinceOpen - before.discardedSinceOpen).toBe(Math.max(0, evictionCount({ sampleCount: before.sampleCount!, incoming: width, maxSamples, slack, overBytes: false })))
      }
      // Batches smaller than a pass settle the slack below the budget.
      while (second < 2 * Math.ceil(maxSamples / 300)) record(300)
      expect(historian.status().sampleCount).toBe(maxSamples - slack)
      // A batch larger than a pass takes the room it needs, and the next ones restore the slack.
      record(1_000)
      expect(historian.status().sampleCount).toBe(maxSamples)
      for (let batch = 0; batch < 10; batch += 1) record(300)
      const status = historian.status()
      expect(status.sampleCount).toBe(maxSamples - slack)
      expect(status).toMatchObject({ captureState: 'recording', lastError: null })
    } finally { historian.close() }
  })

  test('samples heavier than budgeted are evicted by the pages they use, so capture continues within the byte budget', async () => {
    await withTemporaryDirectory(dir => {
      const maxBytes = 1024 * 1024
      let now = t0
      const historian = createRunHistorian(join(dir, 'history.sqlite'), { now: () => now, limits: { maxBytes, minFreeBytes: 0 } })
      try {
        historian.record('rt', { descriptors: [{ ...numberSeries('note'), valueType: 'string' }], samples: [] })
        // 600 samples of 2 kB: the sample budget (1,962 at 384 bytes) alone would let them fill the file.
        for (let batch = 0; batch < 120; batch += 1) {
          now += 10_000
          historian.record('rt', { descriptors: [], samples: Array.from({ length: 5 }, (_, index) => sample('note', `${batch * 5 + index} ${'x'.repeat(2_000)}`, now + index)) })
        }
        const status = historian.status()
        expect(status).toMatchObject({ captureState: 'recording', lastError: null })
        expect(status.sampleCount!).toBeLessThan(status.limits.maxSamples / 3)
        expect(status.discardedSinceOpen).toBe(600 - status.sampleCount!)
        expect(status.storageBytes!).toBeLessThanOrEqual(maxBytes)
        expect(String(stored(historian, 'note').at(-1)?.value)).toStartWith('599 ')
      } finally { historian.close() }
    })
  })
})
