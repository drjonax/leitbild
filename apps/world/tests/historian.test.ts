import { describe, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createRunHistorian, type RunHistorian } from '../src/features/historian/store.ts'
import type { IsoTimestamp, RecordingSeriesQuery } from '../src/core/model/index.ts'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const at = (value: string): IsoTimestamp => value as IsoTimestamp
const rawPage = (historian: RunHistorian, query: Omit<RecordingSeriesQuery, 'mode'> = {}) => {
  const page = historian.query({ ...query, mode: 'raw' })
  if (page.mode !== 'raw') throw new Error('Expected raw historian page')
  return page
}

describe('Run Historian', () => {
  test('default summary matches the whole raw interval, retains interior excursions and quality, and skips raw-page SQL', () => {
    const historian = createRunHistorian(':memory:')
    try {
      historian.record('plant.local', { descriptors: [{ id: 'power', subjectId: 'plant', signalId: 'power', title: 'Power', valueType: 'number', unit: 'MW' }], samples: [10, 100, 10].map((value, index) => ({ seriesId: 'power', value, quality: (['good', 'bad', 'uncertain'] as const)[index]!, observedAt: at(`2026-01-01T00:00:0${index + 1}.000Z`) })) })
      const scope = { runtimeId: 'plant.local', seriesId: 'power', from: '2026-01-01T00:00:01Z', to: '2026-01-01T00:00:03Z' }
      const sql = spyOn(Database.prototype, 'query')
      let summary
      try {
        summary = historian.query(scope)
        expect(sql.mock.calls.some(call => /ORDER BY sequence DESC\s+LIMIT \?/.test(call[0]))).toBe(false)
      } finally { sql.mockRestore() }
      expect(summary.mode).toBe('summary')
      for (const field of ['samples', 'hasMore', 'nextBeforeSequence']) expect(summary).not.toHaveProperty(field)
      expect(summary.windowSummary).toMatchObject({ sampleCount: 3, seriesCount: 1, qualityCounts: { good: 1, uncertain: 1, bad: 1 }, distinctValueCount: 2, numericMinimum: 10, numericMaximum: 100, numericAverage: 40, firstSample: { value: 10 }, lastSample: { value: 10 } })
      for (const limit of [1, 100]) expect(rawPage(historian, { ...scope, limit }).windowSummary).toEqual(summary.windowSummary)
    } finally { historian.close() }
  })

  for (const timeAxis of ['observed', 'simulation'] as const) test(`equal timestamps paginate without duplication and page-two summary covers the whole ${timeAxis} interval`, () => {
    const historian = createRunHistorian(':memory:')
    try {
      const observedAt = at('2026-01-01T00:00:01.000Z')
      const simulationTime = at('2026-01-01T10:00:01.000Z')
      historian.record('test.local', { descriptors: [{ id: 'signal', subjectId: 'asset', signalId: 'signal', title: 'Signal', valueType: 'number' }], samples: [1, 2, 3, 4, 5].map(value => ({ seriesId: 'signal', value, observedAt, simulationTime, quality: 'good' })) })
      const scope = { runtimeId: 'test.local', seriesId: 'signal', timeAxis, from: timeAxis === 'observed' ? observedAt : simulationTime, to: timeAxis === 'observed' ? observedAt : simulationTime }
      const first = rawPage(historian, { ...scope, limit: 2 })
      const second = rawPage(historian, { ...scope, limit: 2, beforeSequence: first.nextBeforeSequence! })
      const third = rawPage(historian, { ...scope, limit: 2, beforeSequence: second.nextBeforeSequence! })
      expect([...first.samples, ...second.samples, ...third.samples].map(sample => sample.value)).toEqual([5, 4, 3, 2, 1])
      expect(second.windowSummary).toEqual(first.windowSummary)
      expect(third.windowSummary).toEqual(historian.query(scope).windowSummary)
      expect(third).toMatchObject({ hasMore: false, nextBeforeSequence: null })
      expect(first.windowSummary.firstSample?.sequence).toBe(1)
      expect(first.windowSummary.lastSample?.sequence).toBe(5)
    } finally { historian.close() }
  })

  test('a series window reads the newest up to its limit, and with them the window\'s oldest where asked, never the rows between', () => {
    const historian = createRunHistorian(':memory:')
    try {
      const second = (index: number) => at(`2026-01-01T10:00:${String(index).padStart(2, '0')}.000Z`)
      historian.record('plant.local', { descriptors: [{ id: 'level', subjectId: 'sg', signalId: 'level', title: 'Level', valueType: 'number', unit: '%' }], samples: Array.from({ length: 30 }, (_, index) => ({ seriesId: 'level', value: index, observedAt: second(index), simulationTime: second(index), quality: 'good' as const })) })
      const window = { runtimeId: 'plant.local', seriesId: 'level', from: second(10), to: second(29) }
      expect(historian.seriesWindow({ ...window, limit: 3 }).map(sample => sample.value)).toEqual([29, 28, 27])
      // How far back the record reaches in the window, in one more row: the oldest after the newest.
      expect(historian.seriesWindow({ ...window, limit: 3, withOldest: true }).map(sample => sample.value)).toEqual([29, 28, 27, 10])
      // Where the newest hold the oldest, no row twice.
      expect(historian.seriesWindow({ ...window, limit: 25, withOldest: true }).map(sample => sample.value)).toHaveLength(20)
      expect(historian.seriesWindow({ ...window, limit: 20, withOldest: true }).at(-1)?.value).toBe(10)
      expect(historian.seriesWindow({ ...window, from: second(40), to: second(50), limit: 3, withOldest: true })).toEqual([])
    } finally { historian.close() }
  })

  test('raw wide exports retain row identities but do not numerically combine multiple actual series', () => {
    const historian = createRunHistorian(':memory:')
    try {
      const observedAt = at('2026-01-01T00:00:01.000Z')
      for (const [runtimeId, value, unit] of [['plant.one', 10, 'MW'], ['plant.two', 1000, 'kW']] as const) {
        historian.record(runtimeId, { descriptors: [{ id: 'same-id', subjectId: 'plant', signalId: 'power', title: 'Power', valueType: 'number', unit }], samples: [{ seriesId: 'same-id', value, observedAt, quality: 'good' }] })
      }
      const wide = rawPage(historian, { seriesId: 'same-id' })
      expect(wide.samples.map(sample => sample.runtimeId)).toEqual(['plant.two', 'plant.one'])
      expect(wide.windowSummary).toMatchObject({ sampleCount: 2, seriesCount: 2, numericMinimum: null, numericMaximum: null, numericAverage: null })
      expect(rawPage(historian, { runtimeId: 'plant.one' }).windowSummary).toMatchObject({ seriesCount: 1, numericAverage: 10 })
    } finally { historian.close() }
  })

  test('later appends change live whole-window aggregates without changing the meaning of a raw cursor', () => {
    const historian = createRunHistorian(':memory:')
    try {
      const scope = { runtimeId: 'test.local', seriesId: 'signal' }
      const sample = (value: number) => ({ seriesId: 'signal', value, observedAt: at(`2026-01-01T00:00:0${value}.000Z`), quality: 'good' as const })
      historian.record(scope.runtimeId, { descriptors: [{ id: scope.seriesId, subjectId: 'asset', signalId: 'signal', title: 'Signal', valueType: 'number' }], samples: [1, 2, 3].map(sample) })
      const first = rawPage(historian, { ...scope, limit: 1 })
      historian.record(scope.runtimeId, { descriptors: [], samples: [sample(4)] })
      const older = rawPage(historian, { ...scope, beforeSequence: first.nextBeforeSequence! })
      expect(older.samples.map(sample => sample.value)).toEqual([2, 1])
      expect(first.windowSummary.sampleCount).toBe(3)
      expect(older.windowSummary).toEqual(historian.query(scope).windowSummary)
      expect(older.windowSummary).toMatchObject({ sampleCount: 4, numericMaximum: 4, lastSample: { value: 4 } })
    } finally { historian.close() }
  })

  test('summary requires exact scope and rejects raw cursors at the store boundary', () => {
    const historian = createRunHistorian(':memory:')
    try {
      for (const query of [{}, { runtimeId: 'test.local' }, { seriesId: 'signal' }, { runtimeId: 'test.local', seriesId: 'signal', beforeSequence: 2 }, { runtimeId: 'test.local', seriesId: 'signal', from: 'invalid' }, { runtimeId: 'test.local', seriesId: 'signal', from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' }]) expect(() => historian.query(query)).toThrow()
      expect(() => rawPage(historian, { beforeSequence: 0 })).toThrow()
      expect(() => rawPage(historian, { limit: 0 })).toThrow()
      expect(() => rawPage(historian, {})).not.toThrow()
    } finally { historian.close() }
  })

  test('an empty interval has no sampled series, numeric values or endpoints and preserves known retained bounds', () => {
    const historian = createRunHistorian(':memory:')
    try {
      const scope = { runtimeId: 'test.local', seriesId: 'signal' }
      historian.record(scope.runtimeId, { descriptors: [{ id: scope.seriesId, subjectId: 'asset', signalId: 'signal', title: 'Signal', valueType: 'number' }], samples: [{ seriesId: scope.seriesId, value: 8, observedAt: at('2026-01-01T00:00:01.000Z'), quality: 'good' }] })
      const query = { ...scope, from: '2026-01-01T00:00:02Z' }
      const summary = historian.query(query)
      expect(summary.windowSummary).toEqual({ sampleCount: 0, seriesCount: 0, qualityCounts: { good: 0, uncertain: 0, bad: 0 }, firstSample: null, lastSample: null, distinctValueCount: 0, numericMinimum: null, numericMaximum: null, numericAverage: null })
      expect(summary.retainedFromObservedAt).toBe('2026-01-01T00:00:01.000Z')
      expect(rawPage(historian, query)).toMatchObject({ samples: [], hasMore: false, nextBeforeSequence: null, windowSummary: summary.windowSummary })
    } finally { historian.close() }
  })
  test('storage accounting includes live WAL and shared-memory files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'historian-wal-'))
    const path = join(dir, 'history.sqlite')
    const historian = createRunHistorian(path, { limits: { minFreeBytes: 0 } })
    try {
      historian.record('test', { descriptors: [{ id: 's', subjectId: 'asset', signalId: 'n', title: 'N', valueType: 'number' }], samples: [{ seriesId: 's', value: 1, observedAt: at(new Date().toISOString()), quality: 'good' }] })
      const status = historian.status()
      expect(status.walBytes).toBeGreaterThan(0)
      const sizes = await Promise.all([path, `${path}-wal`, `${path}-shm`].map(file => stat(file)))
      expect(status.storageBytes).toBe(sizes.reduce((sum, value) => sum + value.size, 0))
      expect(status.databaseBytes).toBe(sizes[0]!.size)
    } finally { historian.close(); await rm(dir, { recursive: true, force: true }) }
  })
  test('an existing oversized history remains queryable and untouched, including retention', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'historian-budget-'))
    const path = join(dir, 'history.sqlite')
    try {
      const descriptor = { id: 'series:text', subjectId: 'asset', signalId: 'text', title: 'Text', valueType: 'string' as const }
      const original = createRunHistorian(path, { limits: { minFreeBytes: 0 } })
      original.record('test', { descriptors: [descriptor], samples: Array.from({ length: 200 }, () => ({ seriesId: descriptor.id, observedAt: at('2026-01-01T00:00:00.000Z'), value: 'x'.repeat(1000), quality: 'good' as const })) })
      original.close()
      expect((await stat(path)).size).toBeGreaterThan(64 * 1024)
      const before = await readFile(path)
      const limited = createRunHistorian(path, { limits: { maxBytes: 64 * 1024, maxSamples: 1, minFreeBytes: 0 } })
      try {
        limited.record('test', { descriptors: [], samples: [{ seriesId: descriptor.id, observedAt: at(new Date().toISOString()), value: 'new', quality: 'good' }] })
        expect(limited.status()).toMatchObject({ sampleCount: 200, captureState: 'limited', discardedSinceOpen: 1 })
        expect(rawPage(limited, { limit: 1 }).samples).toHaveLength(1)
      } finally { limited.close() }
      expect(await readFile(path)).toEqual(before)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  test('rejects changed units and mismatched value types atomically', () => {
    const historian = createRunHistorian(':memory:')
    const descriptor = { id: 'series:power', subjectId: 'plant', signalId: 'power', title: 'Power', valueType: 'number' as const, unit: 'MW' }
    historian.record('plant.local', { descriptors: [descriptor], samples: [] })
    expect(() => historian.record('plant.local', { descriptors: [{ ...descriptor, unit: 'kW' }], samples: [] })).toThrow('semantics changed')
    expect(() => historian.record('plant.local', { descriptors: [], samples: [{ seriesId: descriptor.id, value: 'oops', observedAt: at(new Date().toISOString()), quality: 'good' }] })).toThrow('does not match')
    expect(historian.status().sampleCount).toBe(0)
    historian.close()
  })

  test('retains a bounded recent window and paginates equal times by sequence on either time axis', () => {
    let now = Date.parse('2026-01-01T00:00:10.000Z')
    const historian = createRunHistorian(':memory:', { limits: { maxSamples: 3, maxAgeMs: 20_000 }, now: () => now })
    const observedAt = at('2026-01-01T00:00:10.000Z')
    const simulationTime = at('2026-01-01T10:00:10.000Z')
    historian.record('test.local', { descriptors: [{ id: 'series:value', subjectId: 'asset', signalId: 'value', title: 'Value', valueType: 'number' }], samples: [1, 2, 3, 4, 5].map(value => ({ seriesId: 'series:value', observedAt, simulationTime, value, quality: 'good' })) })
    expect(historian.status()).toMatchObject({ sampleCount: 3, discardedSinceOpen: 2 })
    const page = rawPage(historian, { limit: 2, timeAxis: 'simulation', from: '2026-01-01T12:00:00+02:00' })
    expect(page.samples.map(sample => sample.value)).toEqual([5, 4])
    expect(page.windowSummary).toMatchObject({
      sampleCount: 3,
      distinctValueCount: 3,
      numericMinimum: 3,
      numericMaximum: 5,
      numericAverage: 4,
      firstSample: { value: 3 },
      lastSample: { value: 5 },
    })
    expect(page.hasMore).toBe(true)
    expect(rawPage(historian, { beforeSequence: page.nextBeforeSequence! }).samples.map(sample => sample.value)).toEqual([3])
    expect(rawPage(historian, { beforeSequence: 2 }).retentionGap).toBe(true)
    expect(page).toMatchObject({
      retainedFromObservedAt: observedAt,
      retainedToObservedAt: observedAt,
      retainedFromSimulationTime: simulationTime,
      retainedToSimulationTime: simulationTime,
    })
    expect(rawPage(historian, {
      timeAxis: 'simulation',
      from: '2026-01-01T09:00:00Z',
      to: '2026-01-01T09:01:00Z',
    })).toMatchObject({ samples: [], retentionGap: true, retainedFromSimulationTime: simulationTime })
    now += 30_000
    historian.record('test.local', { descriptors: [], samples: [{ seriesId: 'series:value', observedAt: at(new Date(now).toISOString()), value: 6, quality: 'good' }] })
    expect(historian.status()).toMatchObject({ sampleCount: 1, discardedSinceOpen: 5 })
    historian.close()
  })
  test('persists typed samples, exposes descriptors, and applies bounded filters', () => {
    const historian = createRunHistorian(':memory:')
    try {
      historian.record('process-plant.local', {
        descriptors: [{
          id: 'series:power',
          subjectId: 'plant:test',
          signalId: 'core.totalThermalPowerMw',
          title: 'Test Plant · Thermal power',
          valueType: 'number',
          quantity: 'power',
          unit: 'MW',
        }, {
          id: 'series:trip',
          subjectId: 'plant:test',
          signalId: 'core.tripped',
          title: 'Test Plant · Reactor trip',
          valueType: 'boolean',
          quantity: 'boolean',
          unit: 'boolean',
        }],
        samples: [{
          seriesId: 'series:power',
          observedAt: at('2026-01-01T00:00:01.000Z'),
          simulationTime: at('2026-01-01T10:00:01.000Z'),
          elapsedMs: 1_000,
          value: 2_980,
          quality: 'good',
        }, {
          seriesId: 'series:trip',
          observedAt: at('2026-01-01T00:00:01.000Z'),
          simulationTime: at('2026-01-01T10:00:01.000Z'),
          elapsedMs: 1_000,
          value: false,
          quality: 'good',
        }],
      })

      expect(historian.status()).toMatchObject({
        seriesCount: 2,
        sampleCount: 2,
        firstObservedAt: '2026-01-01T00:00:01.000Z',
        lastObservedAt: '2026-01-01T00:00:01.000Z',
      })
      expect(historian.listSeries()).toContainEqual(expect.objectContaining({
        runtimeId: 'process-plant.local',
        id: 'series:power',
        subjectId: 'plant:test',
        unit: 'MW',
      }))
      expect(rawPage(historian, { subjectId: 'plant:test', signalId: 'core.tripped' }).samples).toEqual([expect.objectContaining({
        seriesId: 'series:trip',
        value: false,
        elapsedMs: 1_000,
      })])
      expect(rawPage(historian, { from: '2026-01-01T00:00:02.000Z' }).samples).toEqual([])
    } finally {
      historian.close()
    }
  })

  test('rejects samples whose series has not been described', () => {
    const historian = createRunHistorian(':memory:')
    try {
      expect(() => historian.record('process-plant.local', {
        descriptors: [],
        samples: [{
          seriesId: 'series:missing',
          observedAt: at('2026-01-01T00:00:01.000Z'),
          value: 1,
          quality: 'good',
        }],
      })).toThrow()
    } finally {
      historian.close()
    }
  })
})
