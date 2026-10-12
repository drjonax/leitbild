import type { UnitProperty } from '../config-schema.ts'
import { wordFor, type LexiconKey } from '../lexicon.ts'
import { unitTypeOf, type Catalog, type PropertyValue, type UnitRecord } from './model.ts'
import { countOf, type Counts } from './values.ts'

/**
 * Engine wording. Every domain word comes from the configuration: unit and
 * task labels, load-class nouns and codes, property labels and units, and
 * the lexicon's phase words. The few fixed words here are neutral.
 */

const inline = (word: string): string => word.charAt(0).toLowerCase() + word.slice(1)

/** A unit's own word for a lexicon key, for use inside a sentence. */
export const unitWord = (catalog: Catalog, unit: UnitRecord, key: LexiconKey): string =>
  inline(wordFor(catalog.config.lexicon, key, unitTypeOf(catalog, unit).lexicon))

export const phaseWord = (catalog: Catalog, unit: UnitRecord): string => unitWord(catalog, unit, unit.phase)

/**
 * "2 pallets, 1 crate" in declared class order. Classes that share a noun
 * count together, so two classes of crates read "2 crates", never
 * "1 crate, 1 crate".
 */
export const loadText = (catalog: Catalog, load: Counts): string => {
  const byNoun = new Map<string, { readonly noun: { readonly one: string; readonly other: string }; count: number }>()
  for (const loadClass of catalog.classes) {
    const count = countOf(load, loadClass.id)
    if (count <= 0) continue
    const key = JSON.stringify([loadClass.noun.one, loadClass.noun.other])
    const shared = byNoun.get(key)
    if (shared === undefined) byNoun.set(key, { noun: loadClass.noun, count })
    else shared.count += count
  }
  return [...byNoun.values()].map(({ noun, count }) => `${count} ${count === 1 ? noun.one : noun.other}`).join(', ')
}

export const classCode = (catalog: Catalog, classId: string): string => {
  const loadClass = catalog.classes.find(entry => entry.id === classId)
  if (loadClass === undefined) throw new Error(`Load class ${classId} is not declared`)
  return loadClass.code
}

const withUnit = (property: Extract<UnitProperty, { kind: 'number' }>, value: number): string =>
  property.unit === undefined ? `${value}` : `${value} ${property.unit}`

export const propertyValueText = (property: UnitProperty, value: PropertyValue): string => {
  if (property.kind === 'number' && typeof value === 'number') return withUnit(property, value)
  if (property.kind === 'boolean') return value === true ? 'yes' : 'no'
  const label = property.kind === 'enum' ? property.values.find(entry => entry.id === value)?.label : undefined
  if (label === undefined) throw new Error(`${String(value)} is not a value of ${property.label}`)
  return label
}

export const numberBoundText = (property: UnitProperty, bound: 'atLeast' | 'atMost', value: number): string => {
  const sign = bound === 'atLeast' ? '≥' : '≤'
  return property.kind === 'number' ? `${sign} ${withUnit(property, value)}` : `${sign} ${value}`
}
