import { describe, expect, test } from 'bun:test'
import { alertStateSchema, priorityLevels, type Priority } from '../src/core/model/alerts.ts'
import { simulationRunEventSchema } from '../src/core/model/events.ts'
import type { IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { createFixtureObject } from './fixtures/fixture-pack.ts'

// Alert facets (plan v3.1 §2.2, architecture A2, R11): optional beside today's record, which every saved Run's
// alerts parse through; a facet only survives a save and restore if alerts.ts declares it.

const at = '2026-10-20T08:00:00.000Z' as IsoTimestamp
const record = { id: 'a1', kind: 'sg-level-lo', severity: 'warning', message: 'SG A level low', raisedAt: at, acknowledged: false } as const
const facets = {
  returned: true, latched: true, standing: true, advisory: true, firstOut: { group: 'rx-trip', rank: 1 }, subject: { element: 'sg-a' },
  observable: 'unit-2#SG-A-NR-LVL', threshold: 'lo-lo', priority: 'caution', clock: 'simulation',
} as const

describe('alert facets', () => {
  test('a record saved before facets parses unchanged and gains none', () => {
    expect(alertStateSchema.parse(record)).toEqual(record)
  })

  test('a record with every facet survives the journal round trip without loss', () => {
    const object = createFixtureObject({ type: 'site', id: 'site-1' as ObjectId, label: 'Site 1', position: [10.7, 59.9] }, { at, objectById: () => undefined })
    const alert = { ...record, ...facets, acknowledged: true, acknowledgedBy: 'ai' as const }
    const event = {
      id: 'evt-1', simulationRunId: 'run-facets', seq: 1, at, provenance: object.provenance, type: 'object.upserted',
      object: { ...object, alerts: [alert, { ...record, id: 'a2', subject: { group: 'island-north' } }] },
    }
    const restored = simulationRunEventSchema.parse(JSON.parse(JSON.stringify(event)))
    expect(restored.type === 'object.upserted' && restored.object.alerts).toEqual([alert, { ...record, id: 'a2', subject: { group: 'island-north' } }])
  })

  test('a present priority must agree with the severity; nothing derives one', () => {
    const agrees: Readonly<Record<Priority, string>> = { none: 'info', notice: 'info', caution: 'warning', warning: 'warning', alarm: 'critical', emergency: 'critical' }
    for (const priority of priorityLevels) {
      for (const severity of ['info', 'warning', 'critical'] as const) {
        expect(alertStateSchema.safeParse({ ...record, severity, priority }).success).toBe(agrees[priority] === severity)
      }
    }
    expect(alertStateSchema.parse({ ...record, severity: 'critical' })).not.toHaveProperty('priority')
  })

  test('boolean facets are true or absent, and only an acknowledged alert names who acknowledged it', () => {
    for (const facet of ['returned', 'latched', 'standing', 'advisory']) expect(alertStateSchema.safeParse({ ...record, [facet]: false }).success).toBe(false)
    expect(alertStateSchema.safeParse({ ...record, acknowledgedBy: 'person' }).success).toBe(false)
    expect(alertStateSchema.safeParse({ ...record, acknowledged: true, acknowledgedBy: 'operator' }).success).toBe(false)
  })

  test('a subject is one element or one group, and an observable names its object', () => {
    expect(alertStateSchema.safeParse({ ...record, subject: { element: 'sg-a', group: 'loop-a' } }).success).toBe(false)
    expect(alertStateSchema.safeParse({ ...record, observable: 'SG-A-NR-LVL' }).success).toBe(false)
    expect(alertStateSchema.safeParse({ ...record, firstOut: { group: 'rx-trip', rank: 0 } }).success).toBe(false)
  })

  test('an undeclared key is dropped on parse, which is why facets live in alerts.ts', () => {
    expect(alertStateSchema.parse({ ...record, shelved: true })).toEqual(record)
  })
})
