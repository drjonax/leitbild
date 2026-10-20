import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { cardItemSchema, displayCardSchema } from '../src/core/observation/card.ts'
import {
  alertWithFacetsSchema, observableSchema, observationSchema, quantitySchema, stampSchema, thresholdSchema, viewerSchema,
} from '../src/core/observation/model.ts'
import {
  dashboardSchema, dashboardsFileSchema, displaySpecSchema, sectionSchema, selectorSchema, viewSchema,
} from '../src/core/observation/spec.ts'
import { alertStateSchema } from '../src/core/model/alerts.ts'

const at = { at: '2026-10-20T08:00:00.000Z', clock: 'simulation' } as const
const threshold = { id: 'lo-lo', direction: 'low', value: 20, order: 2, effect: 'trip', priority: 'alarm' } as const
const observable = {
  ref: 'unit-2#SG-A-NR-LVL', label: 'Unit 2 SG A narrow-range level', quantity: 'level', unit: '%', valueType: 'number',
  series: { seriesId: 's-1', intervalMs: 1000 },
} as const
const spec = { title: 'SG A level', question: 'Is SG A level recovering?', subjects: ['unit-2#SG-A-NR-LVL'], views: [{ kind: 'trend', signals: ['unit-2#SG-A-NR-LVL'] }] }
const section = { id: 's1', by: 'agent', source: { spec }, composedAt: { ...at, mode: 'Mode 1' } }

describe('observation model draft', () => {
  test('every stamp names its clock and accepts an offset', () => {
    expect(stampSchema.parse({ at: '2026-10-20T10:00:00+02:00', clock: 'wall' }).clock).toBe('wall')
    expect(stampSchema.safeParse({ at: '2026-10-20T08:00:00Z' }).success).toBe(false)
  })

  test('quantities come from the fixed core list only', () => {
    expect(quantitySchema.parse('electric-power')).toBe('electric-power')
    expect(quantitySchema.safeParse('active-power').success).toBe(false)
    expect(quantitySchema.safeParse('power').success).toBe(false)
  })

  test('a threshold has an order 1–4 and a priority above none', () => {
    expect(thresholdSchema.parse(threshold).order).toBe(2)
    expect(thresholdSchema.safeParse({ ...threshold, order: 5 }).success).toBe(false)
    expect(thresholdSchema.safeParse({ ...threshold, priority: 'none' }).success).toBe(false)
    expect(thresholdSchema.safeParse({ ...threshold, colour: '#f00' }).success).toBe(false)
  })

  test('an observable defaults to no thresholds and may be unrecorded', () => {
    expect(observableSchema.parse(observable).thresholds).toEqual([])
    expect(observableSchema.parse({ ...observable, series: null, valueType: 'duration', quantity: 'duration' }).series).toBeNull()
    expect(observableSchema.safeParse({ ...observable, series: undefined }).success).toBe(false)
    expect(observableSchema.safeParse({ ...observable, thresholds: Array.from({ length: 13 }, (_, index) => ({ ...threshold, id: `t${index}` })) }).success).toBe(false)
  })

  test('an observation carries one six-level priority and refuses a second scale name', () => {
    const observation = { ...at, ref: observable.ref, value: 31.5, quality: 'good', priority: 'caution', timeToAct: { threshold: 'lo-lo', seconds: 140 } }
    expect(observationSchema.parse(observation).priority).toBe('caution')
    expect(observationSchema.safeParse({ ...observation, severity: 'caution' }).success).toBe(false)
    expect(observationSchema.safeParse({ ...observation, clock: undefined }).success).toBe(false)
  })

  test('today\'s alert record parses unchanged and facets stay optional', () => {
    const record = { id: 'a1', kind: 'sg-level-lo', severity: 'warning', message: 'SG A level low', raisedAt: '2026-10-20T08:00:00.000Z', acknowledged: false }
    expect(alertStateSchema.parse(record)).toEqual(alertWithFacetsSchema.parse(record))
    expect(alertWithFacetsSchema.parse({ ...record, priority: 'caution', firstOut: { group: 'rx-trip', rank: 1 }, clock: 'simulation' }).priority).toBe('caution')
  })

  test('a present priority must agree with the record severity', () => {
    const record = { id: 'a1', kind: 'trip', severity: 'critical', message: 'Reactor trip', raisedAt: '2026-10-20T08:00:00.000Z', acknowledged: false }
    expect(alertWithFacetsSchema.safeParse({ ...record, priority: 'emergency' }).success).toBe(true)
    expect(alertWithFacetsSchema.safeParse({ ...record, priority: 'caution' }).success).toBe(false)
    expect(alertWithFacetsSchema.safeParse({ ...record, severity: 'info', priority: 'none' }).success).toBe(true)
  })

  test('a viewer sees everything or named sides', () => {
    expect(viewerSchema.parse({ actor: 'person', sees: 'all' }).sees).toBe('all')
    expect(viewerSchema.parse({ actor: 'agent', sees: ['blue'] }).sees).toEqual(['blue'])
    expect(viewerSchema.safeParse({ actor: 'agent', sees: [] }).success).toBe(false)
  })
})

describe('vignette and dashboard spec draft', () => {
  test('a values view lists a live collection that excludes closed objects unless asked', () => {
    const view = viewSchema.parse({ kind: 'values', of: { category: 'incident', status: ['open'] }, columns: ['priority', 'age'], count: { by: 'priority' } })
    expect(view.kind === 'values' && view.of?.closed).toBe(false)
    expect(selectorSchema.safeParse({ near: 'ambulance-1', within: '5km' }).success).toBe(false)
    expect(selectorSchema.safeParse({ class: 'line', within: '7km' }).success).toBe(false)
  })

  test('events default to the last 30 minutes and alerts to related ones', () => {
    expect(viewSchema.parse({ kind: 'events' })).toEqual({ kind: 'events', since: '30m' })
    expect(viewSchema.parse({ kind: 'alerts' })).toEqual({ kind: 'alerts', scope: 'related' })
  })

  test('no view carries coordinates, colours or numbers', () => {
    expect(viewSchema.safeParse({ kind: 'map', around: ['halden'], within: '20km' }).success).toBe(true)
    expect(viewSchema.safeParse({ kind: 'map', center: [11.38, 59.12] }).success).toBe(false)
    expect(viewSchema.safeParse({ kind: 'trend', signals: ['a'], colour: '#f00' }).success).toBe(false)
    expect(viewSchema.safeParse({ kind: 'values', signals: ['a'], limits: { high: 90 } }).success).toBe(false)
  })

  test('view kinds hold their caps', () => {
    expect(viewSchema.safeParse({ kind: 'trend', signals: Array.from({ length: 13 }, (_, index) => `s${index}`) }).success).toBe(false)
    expect(viewSchema.safeParse({ kind: 'topology', around: ['bus-a'], reach: 5 }).success).toBe(false)
    expect(viewSchema.safeParse({ kind: 'gauge', signals: ['a'] }).success).toBe(false)
  })

  test('a spec names one to six subjects and at most four views', () => {
    expect(displaySpecSchema.parse(spec).subjects).toHaveLength(1)
    expect(displaySpecSchema.parse({ ...spec, subjects: [{ of: { category: 'vehicle' } }] }).subjects).toHaveLength(1)
    expect(displaySpecSchema.safeParse({ ...spec, subjects: [] }).success).toBe(false)
    expect(displaySpecSchema.safeParse({ ...spec, subjects: Array.from({ length: 7 }, (_, index) => `o${index}`) }).success).toBe(false)
    expect(displaySpecSchema.safeParse({ ...spec, views: Array.from({ length: 5 }, () => ({ kind: 'alerts' })) }).success).toBe(false)
  })

  test('dashboard sections are stored by value, never as templates', () => {
    expect(sectionSchema.parse(section).composedAt?.mode).toBe('Mode 1')
    expect(sectionSchema.parse({ id: 's2', by: 'world', source: { default: 'unit-2' } }).by).toBe('world')
    expect(sectionSchema.safeParse({ id: 's3', by: 'person', source: { template: 'plant-overview' } }).success).toBe(false)
  })

  test('a dashboard holds at most eight uniquely named sections', () => {
    expect(dashboardSchema.parse({ scope: 'run', revision: 3, sections: [section] }).revision).toBe(3)
    expect(dashboardSchema.safeParse({ scope: 'run', revision: 3, sections: [section, section] }).success).toBe(false)
    expect(dashboardSchema.safeParse({ scope: { subject: 'unit-2' }, revision: 0, sections: Array.from({ length: 9 }, (_, index) => ({ ...section, id: `s${index}` })) }).success).toBe(false)
  })

  test('the stored file keeps revision ids and at most twenty removed sections by value', () => {
    const removed = Array.from({ length: 20 }, (_, index) => ({ revision: index + 1, section: { ...section, id: `r${index}` } }))
    const entry = {
      dashboard: { scope: { of: { category: 'incident' } }, revision: 21, sections: [section] },
      revisions: [{ revision: 21, by: { actor: 'person', id: 'p1' }, at: { ...at, clock: 'wall' }, added: ['s1'], removed: ['r19'] }],
      removed,
    }
    expect(dashboardsFileSchema.parse({ dashboards: [entry] }).dashboards[0]?.removed).toHaveLength(20)
    expect(dashboardsFileSchema.safeParse({ dashboards: [{ ...entry, removed: [...removed, removed[0]] }] }).success).toBe(false)
  })
})

describe('card draft', () => {
  const item = { key: 'k3', label: 'SG A NR level', reading: '31.5 % falling', unit: '%', numbers: [{ value: 31.5, decimals: 1 }], subject: { ref: observable.ref } }

  test('items are keyed for citation and carry their numbers', () => {
    expect(cardItemSchema.parse(item).key).toBe('k3')
    expect(cardItemSchema.safeParse({ ...item, key: 'x3' }).success).toBe(false)
    expect(cardItemSchema.safeParse({ ...item, numbers: Array.from({ length: 9 }, () => ({ value: 1, decimals: 0 })) }).success).toBe(false)
  })

  test('items reserve entity rows, events and map features', () => {
    expect(cardItemSchema.safeParse({ ...item, subject: { objectId: 'incident-7' } }).success).toBe(true)
    expect(cardItemSchema.safeParse({ ...item, subject: { eventId: 'e-9', at } }).success).toBe(true)
    expect(cardItemSchema.safeParse({ ...item, subject: { featureId: 'line-420', attribution: '© OpenStreetMap contributors' } }).success).toBe(true)
    expect(cardItemSchema.safeParse({ ...item, subject: { lon: 11.3 } }).success).toBe(false)
  })

  test('a card holds at most 48 unique items and eight adjustments', () => {
    const card = { at, items: [item], more: 0, adjusted: [{ kind: 'scope', text: 'Reach narrowed to 2 links', lost: 'aux feed', alternatives: ['feed-to-sg'] }] }
    expect(displayCardSchema.parse(card).items).toHaveLength(1)
    expect(displayCardSchema.safeParse({ ...card, items: [item, item] }).success).toBe(false)
    expect(displayCardSchema.safeParse({ ...card, items: Array.from({ length: 49 }, (_, index) => ({ ...item, key: `k${index}` })) }).success).toBe(false)
    expect(displayCardSchema.safeParse({ ...card, adjusted: [{ kind: 'layout', text: 'x', alternatives: ['y'] }] }).success).toBe(false)
  })
})

test('the draft stays unregistered: no World source outside core/observation imports it', async () => {
  const importers: string[] = []
  for await (const path of new Glob('src/**/*.{ts,svelte}').scan({ cwd: `${import.meta.dir}/..` })) {
    if (path.startsWith('src/core/observation/')) continue
    if ((await Bun.file(`${import.meta.dir}/../${path}`).text()).includes('core/observation/')) importers.push(path)
  }
  expect(importers).toEqual([])
})
