import { describe, expect, test } from 'bun:test'
import {
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createPwrReferencePlantDefinition,
} from '../src/packs/process-plant/index.ts'
import { answerProcessPlantIcQuery, PROCESS_PLANT_IC_CATALOG_DEFAULT_LIMIT } from '../src/packs/process-plant/ic-query.ts'
import type { ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'

// One read of the reference PWR's whole catalog was 494 KB: each of its 154
// rules repeated the full view of every signal it watches. An AI agent that
// called it carried that through the rest of its turn.
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:catalog-test', loopCount: 4 }))
const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
const plants = new Map([[plant.id, { protection } as unknown as ProcessPlantRuntimeInstance]])

interface CatalogPage {
  readonly plantId: string
  readonly ruleCount: number
  readonly total: number
  readonly offset: number
  readonly returned: number
  readonly hasMore: boolean
  readonly rules: ReadonlyArray<{ readonly id: string; readonly ruleClass: string; readonly watchedSignals: ReadonlyArray<Record<string, unknown>> }>
}
const catalog = (input: Record<string, unknown> = {}): CatalogPage => answerProcessPlantIcQuery({
  request: { capabilityId: 'world.process-plant.ic.catalog', input: { plantId: plant.id, ...input } },
  plants,
}) as CatalogPage

describe('world.process-plant.ic.catalog', () => {
  test('answers a page of rules, with how many the Plant has', () => {
    const first = catalog()
    expect(first.ruleCount).toBe(protection.catalog().ruleCount)
    expect(first).toMatchObject({ plantId: plant.id, total: first.ruleCount, offset: 0, returned: PROCESS_PLANT_IC_CATALOG_DEFAULT_LIMIT, hasMore: true })
    expect(JSON.stringify(first).length).toBeLessThan(40_000)
    const pages: string[] = []
    for (let offset = 0; offset < first.total; offset += 100) pages.push(...catalog({ offset, limit: 100 }).rules.map(rule => rule.id))
    expect(pages).toEqual(protection.catalog().rules.map(rule => rule.id))
    expect(() => catalog({ limit: 101 })).toThrow()
  })

  test('names a watched signal by path, tagId, label and unit; signals.read has the rest', () => {
    const [rule] = catalog({ ruleIds: ['generator-output-low'] }).rules
    expect(rule!.watchedSignals.map(signal => signal.tagId)).toEqual(expect.arrayContaining(['TRIP-BKR-A-POS', 'TRIP-BKR-B-POS', 'GEN-MW']))
    for (const signal of rule!.watchedSignals) expect(Object.keys(signal).every(key => ['path', 'tagId', 'label', 'unit'].includes(key))).toBe(true)
  })

  test('filters by words in the rule, its effects or its signals, by class and by id', () => {
    const injection = catalog({ text: 'safety injection' })
    expect(injection.total).toBeGreaterThan(0)
    expect(injection.total).toBeLessThan(injection.ruleCount)
    expect(injection.rules.map(rule => rule.id)).toContain('safety-injection-low-pzr-pressure')
    expect(catalog({ text: 'TRIP-BKR-A-POS', limit: 100 }).rules.map(rule => rule.id)).toContain('generator-output-low')
    expect(catalog({ ruleClass: 'alarm', limit: 100 }).rules.every(rule => rule.ruleClass === 'alarm')).toBe(true)
    expect(catalog({ ruleIds: ['generator-output-low', 'no-such-rule'] }).rules.map(rule => rule.id)).toEqual(['generator-output-low'])
    expect(catalog({ text: 'no rule says this' })).toMatchObject({ total: 0, returned: 0, hasMore: false, rules: [] })
  })
})
