import { describe, expect, test } from 'bun:test'
import { gridAutomationPreset, gridAutomationPresets } from '../src/packs/electric-grid/automation-presets.ts'
import { gridAutomationSchema } from '../src/packs/electric-grid/schemas/grid-automation.ts'

const nordic = gridAutomationPreset('electric-grid.frequency.nordic-2025')
const training = gridAutomationPreset('electric-grid.frequency.manual-balancing-training')

describe('electric grid Automation presets', () => {
  test('every preset validates and the Nordic preset cites a source for every section', () => {
    expect([...gridAutomationPresets.keys()].sort()).toEqual([
      'electric-grid.frequency.islanded-operation',
      'electric-grid.frequency.manual-balancing-training',
      'electric-grid.frequency.nordic-2025',
    ])
    for (const preset of gridAutomationPresets.values()) expect(gridAutomationSchema.parse(preset)).toEqual(preset)
    const cited = new Set(nordic.sources.filter(source => source.status !== 'modelling-choice').map(source => source.section))
    for (const section of ['swing', 'fcrN', 'fcrD', 'afrr', 'mfrr', 'lfdd', 'storage', 'generatorProtection'] as const) {
      expect(cited.has(section)).toBe(true)
    }
    expect(training.afrr.enabled).toBe(false)
    expect(training.mfrr.enabled).toBe(false)
  })

  test('the schema rejects inconsistent automation', () => {
    const invalid = (change: (value: Record<string, unknown>) => void): boolean => {
      const value = structuredClone(nordic) as unknown as Record<string, unknown>
      change(value)
      return gridAutomationSchema.safeParse(value).success
    }
    expect(invalid(() => undefined)).toBe(true)
    expect(invalid(value => { value.unexpected = true })).toBe(false)
    expect(invalid(value => { value.afrr = { enabled: false } })).toBe(false)
    expect(invalid(value => {
      const lfdd = value.lfdd as { stages: Array<{ thresholdHz: number }> }
      lfdd.stages[1]!.thresholdHz = lfdd.stages[0]!.thresholdHz + 0.1
    })).toBe(false)
    expect(invalid(value => { (value.simulation as { subStepSeconds: number }).subStepSeconds = 0.3 })).toBe(false)
  })
})
