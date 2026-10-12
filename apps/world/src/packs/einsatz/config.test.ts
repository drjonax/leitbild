import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import atlas from '../../core/map-symbols/common.json'
import { isMapSymbol } from '../../core/map-symbols/catalog.ts'
import { einsatzConfigShapeSchema } from './config-schema.ts'
import { einsatzConfigSchema, validateEinsatzConfig } from './config-validation.ts'
import combinations from './fixtures/combinations.config.json'
import refused from './fixtures/refused-configs.json'
import supplyRun from './fixtures/supply-run.config.json'
import { neutralLexicon, wordFor } from './lexicon.ts'
import { configurationRefusalCodes, refusal, refusalCode } from './refusal.ts'

interface ExpectedIssue { readonly code: string; readonly path: ReadonlyArray<string | number> }
interface RefusedCase { readonly name: string; readonly config: unknown; readonly issues: ReadonlyArray<ExpectedIssue> }
const semanticCases: ReadonlyArray<RefusedCase> = refused.semantic
const structuralCases: ReadonlyArray<RefusedCase> = refused.structural

/** Einsatz refusals are read back through the convention; structural issues keep Zod's own code. */
const issuesOf = (raw: unknown): ExpectedIssue[] => {
  const result = einsatzConfigSchema.safeParse(raw)
  if (result.success) return []
  return result.error.issues.map(issue => ({ code: issue.code === 'custom' ? refusalCode(issue.message) : issue.code, path: issue.path.map(key => typeof key === 'symbol' ? String(key) : key) }))
}
const sorted = (issues: ReadonlyArray<ExpectedIssue>): string[] => issues.map(issue => JSON.stringify([issue.code, issue.path])).sort()

describe('Einsatz configuration', () => {
  test('an empty configuration declares nothing and has a JSON Schema for authoring', () => {
    expect(einsatzConfigSchema.parse({})).toEqual({ hostility: {}, lexicon: {}, loadClasses: [], unitTypes: [], taskTemplates: [], authority: [], groups: [] })
    expect(z.toJSONSchema(einsatzConfigSchema)).toMatchObject({ type: 'object', additionalProperties: false })
  })

  test('the supply-run configuration validates, with a payload floor on its requirement', () => {
    expect(issuesOf(supplyRun)).toEqual([])
    const config = einsatzConfigSchema.parse(supplyRun)
    const [requirement] = config.taskTemplates.flatMap(template => template.requires)
    expect(requirement?.where).toEqual([{ property: 'payloadKg', atLeast: 500 }])
    const provider = config.unitTypes.find(type => type.components.service?.provides.includes(requirement!.provides))
    expect(provider?.properties).toEqual([{ id: 'payloadKg', label: 'Payload', kind: 'number', unit: 'kg', min: 0, max: 20000, default: 1000, board: true }])
    expect(provider?.components.mobility).toEqual({ mode: 'road', speedFactor: 1, mobilizeS: 0 })
  })

  test('the supply-run icons are catalogue symbols the operational atlas has never drawn', () => {
    const config = einsatzConfigSchema.parse(supplyRun)
    const icons = [...config.unitTypes, ...config.taskTemplates].map(entry => entry.icon)
    for (const icon of icons) {
      expect(isMapSymbol(icon)).toBe(true)
      expect(Object.keys(atlas)).not.toContain(icon)
    }
  })

  test('allowed combinations validate: an effector without a sensor, a sensor-only post and a targetable static object', () => {
    expect(issuesOf(combinations)).toEqual([])
    const types = einsatzConfigSchema.parse(combinations).unitTypes.map(type => type.components)
    expect(types.some(components => components.effector !== undefined && components.sensor === undefined)).toBe(true)
    expect(types.some(components => Object.keys(components).join() === 'sensor')).toBe(true)
    expect(types.some(components => components.durability !== undefined && components.mobility === undefined && components.receiving === undefined)).toBe(true)
  })

  test('signature reflexes default to the documented values', () => {
    const config = einsatzConfigSchema.parse(combinations)
    const signatures = config.unitTypes.flatMap(type => type.components.signature === undefined ? [] : [type.components.signature])
    expect(signatures).toContainEqual({ factor: 0.6, haltedFactor: 0.5, concealAfterS: 30, firedFactor: 2 })
  })

  for (const entry of semanticCases) {
    test(`refuses ${entry.name}`, () => expect(sorted(issuesOf(entry.config))).toEqual(sorted(entry.issues)))
  }

  for (const entry of structuralCases) {
    test(`refuses the structure of ${entry.name}`, () => expect(sorted(issuesOf(entry.config))).toEqual(sorted(entry.issues)))
  }

  test('every configuration refusal code has a refused fixture', () => {
    const covered = new Set(semanticCases.flatMap(entry => entry.issues.map(issue => issue.code)))
    expect(configurationRefusalCodes.filter(code => !covered.has(code))).toEqual([])
  })

  test('the validator on its own reports exactly what the parser refuses, each with a worded reason', () => {
    for (const entry of semanticCases) {
      const found = validateEinsatzConfig(einsatzConfigShapeSchema.parse(entry.config))
      expect(sorted(found)).toEqual(sorted(entry.issues))
      for (const issue of found) expect(issue.message.trim().length).toBeGreaterThan(0)
    }
  })

  test('refusals read `<code>: <message>` and nothing else parses as one', () => {
    expect(refusal('unknown_icon', 'Unknown icon "x"')).toBe('unknown_icon: Unknown icon "x"')
    expect(refusalCode('duplicate_id: Unit type "a" appears more than once')).toBe('duplicate_id')
    for (const reason of ['no_such_code: text', 'duplicate_id:', 'duplicate_id text', 'Duplicate ids']) expect(() => refusalCode(reason)).toThrow('Not an Einsatz refusal')
  })

  test('the unknown icon reason points to the map symbol catalogue', () => {
    const result = einsatzConfigSchema.safeParse({ taskTemplates: [{ id: 'job', label: 'Job', icon: 'nor-this-one' }] })
    expect(result.error?.issues[0]?.message).toBe('unknown_icon: Unknown icon "nor-this-one"; discover names with world.map.symbols')
  })
})

describe('Einsatz wording', () => {
  test('a unit type word wins over the configuration word, which wins over the neutral word', () => {
    const config = einsatzConfigSchema.parse(combinations)
    const [ownWords] = config.unitTypes.flatMap(type => type.lexicon === undefined ? [] : [type.lexicon])
    expect(wordFor({}, 'workList')).toBe(neutralLexicon.workList)
    expect(wordFor(config.lexicon, 'tracks')).toBe('Sightings')
    expect(wordFor(config.lexicon, 'hold')).toBe('Stop')
    expect(wordFor(config.lexicon, 'hold', ownWords)).toBe('Halt')
    expect(wordFor(config.lexicon, 'on-task', ownWords)).toBe('Screening')
    expect(wordFor(config.lexicon, 'returning', ownWords)).toBe(neutralLexicon.returning)
  })
})
