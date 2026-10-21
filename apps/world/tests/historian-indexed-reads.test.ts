import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunHistorian, type RunHistorian } from '../src/features/historian/store.ts'
import type { IsoTimestamp, RecordingSeriesQuery } from '../src/core/model/index.ts'

// A live display reads each trend by series id alone, an agent by runtime and
// series, the history route also by subject or signal. Every statement of
// such a read reaches the series' samples through recording_samples_series_time;
// none scans the samples table, whose cost grows with the whole Run's history
// (a mature four-unit Halden file holds 633k samples).

const at = (value: string): IsoTimestamp => value as IsoTimestamp
const second = (index: number): IsoTimestamp => at(new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 1_000).toISOString())

let directory: string
let path: string
let historian: RunHistorian

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'leitbild-historian-indexed-'))
  path = join(directory, 'history.sqlite')
  historian = createRunHistorian(path)
  // One series id in two runtimes, so a read by id alone selects both, as it always has.
  for (const runtimeId of ['plant.sim', 'grid.sim']) {
    historian.record(runtimeId, {
      descriptors: [
        { id: 'shared', subjectId: `${runtimeId}:a`, signalId: 'core.power', title: `${runtimeId} power`, valueType: 'number', unit: 'MW' },
        { id: `${runtimeId}.flow`, subjectId: `${runtimeId}:a`, signalId: 'loop.flow', title: `${runtimeId} flow`, valueType: 'number', unit: 'kg/s' },
      ],
      samples: Array.from({ length: 20 }, (_, index) => [
        { seriesId: 'shared', observedAt: second(index), simulationTime: second(index + 3_600), value: (runtimeId === 'plant.sim' ? 100 : 1_000) + index, quality: 'good' as const },
        { seriesId: `${runtimeId}.flow`, observedAt: second(index), simulationTime: second(index + 3_600), value: 50 + index, quality: 'good' as const },
      ]).flat(),
    })
  }
})

afterAll(async () => {
  historian.close()
  await rm(directory, { recursive: true, force: true })
})

/** The SQL text of every statement `read` runs on the store's database. */
const statementsOf = (read: () => unknown): ReadonlyArray<string> => {
  const prepared = spyOn(Database.prototype, 'query')
  try {
    read()
    return prepared.mock.calls.map(call => String(call[0]))
  } finally { prepared.mockRestore() }
}

/** How SQLite plans a statement on the store's own schema and indexes. */
const planOf = (sql: string): ReadonlyArray<string> => {
  const reader = new Database(path, { readonly: true })
  try {
    return reader.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail)
  } finally { reader.close() }
}

const window = { from: second(3_600 + 5), to: second(3_600 + 14) }

const reads: ReadonlyArray<readonly [string, RecordingSeriesQuery, number]> = [
  ['a display trend: series id alone on simulation time', { mode: 'raw', seriesId: 'shared', timeAxis: 'simulation', ...window, limit: 4_000 }, 5],
  ['series id alone on capture time', { mode: 'raw', seriesId: 'shared', from: second(5), to: second(14) }, 5],
  ['series id alone, an older raw page', { mode: 'raw', seriesId: 'shared', beforeSequence: 30 }, 5],
  ['an agent read: runtime and series, summary', { mode: 'summary', runtimeId: 'grid.sim', seriesId: 'shared', timeAxis: 'simulation', ...window }, 4],
  ['subject alone', { mode: 'raw', subjectId: 'plant.sim:a' }, 5],
  ['runtime and signal', { mode: 'raw', runtimeId: 'plant.sim', signalId: 'loop.flow' }, 5],
]

describe('Historian reads of named series', () => {
  for (const [name, query, statementCount] of reads) test(`${name}: every statement searches the series index, none scans the samples`, () => {
    const statements = statementsOf(() => historian.query(query))
    expect(statements).toHaveLength(statementCount)
    for (const sql of statements) {
      const plan = planOf(sql)
      expect(plan.filter(detail => /^SCAN recording_samples\b/.test(detail))).toEqual([])
      expect(plan.some(detail => /^SEARCH recording_samples USING (COVERING )?INDEX recording_samples_series_time \(runtime_id=\? AND series_id=\?/.test(detail))).toBe(true)
    }
  })

  test('the names select the same samples: an id alone both runtimes, a runtime one, a subject or signal its series', () => {
    const raw = (query: Omit<RecordingSeriesQuery, 'mode'>) => {
      const page = historian.query({ ...query, mode: 'raw' })
      if (page.mode !== 'raw') throw new Error('expected a raw page')
      return page
    }
    const byId = raw({ seriesId: 'shared', timeAxis: 'simulation', ...window })
    // Newest stored first: the grid's series was recorded after the plant's.
    const newestFirst = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5]
    expect(byId.samples.map(sample => [sample.runtimeId, sample.value])).toEqual([
      ...newestFirst.map(index => ['grid.sim', 1_000 + index]),
      ...newestFirst.map(index => ['plant.sim', 100 + index]),
    ])
    expect(byId.windowSummary).toMatchObject({ sampleCount: 20, seriesCount: 2, numericMinimum: null, firstSample: { runtimeId: 'plant.sim', value: 105 }, lastSample: { runtimeId: 'grid.sim', value: 1_014 } })
    expect(byId.retainedFromSimulationTime).toBe(second(3_600))
    const one = raw({ runtimeId: 'grid.sim', seriesId: 'shared', timeAxis: 'simulation', ...window })
    expect(one.samples.map(sample => sample.value)).toEqual([1_014, 1_013, 1_012, 1_011, 1_010, 1_009, 1_008, 1_007, 1_006, 1_005])
    expect(one.windowSummary).toMatchObject({ sampleCount: 10, seriesCount: 1, numericMinimum: 1_005, numericMaximum: 1_014, numericAverage: 1_009.5 })
    expect(new Set(raw({ subjectId: 'plant.sim:a' }).samples.map(sample => `${sample.runtimeId}/${sample.seriesId}`))).toEqual(new Set(['plant.sim/shared', 'plant.sim/plant.sim.flow']))
    expect(new Set(raw({ signalId: 'loop.flow' }).samples.map(sample => `${sample.runtimeId}/${sample.seriesId}`))).toEqual(new Set(['plant.sim/plant.sim.flow', 'grid.sim/grid.sim.flow']))
    expect(raw({ runtimeId: 'plant.sim', signalId: 'loop.flow' }).samples).toHaveLength(20)
    expect(raw({ seriesId: 'missing' }).samples).toEqual([])
    expect(raw({ runtimeId: 'grid.sim' }).samples).toHaveLength(40)
  })
})
