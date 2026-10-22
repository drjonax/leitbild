/**
 * What the caller may know of refs and objects (architecture A2): every read
 * goes through the observation port as the caller, so a ref of an object it
 * may not inspect has no declaration and no value. A Pack that declares an
 * element's observables only when asked (a grid's) is asked for the elements
 * whose id the ref carries; its answer confirms the exact ref, never a guess.
 */
import { refObjectId } from '../../../core/model/alerts.ts'
import type { ObjectId, OperationalObject } from '../../../core/model/index.ts'
import type { ObservationDeclaration } from '../../../core/observation/capabilities.ts'
import type { Observable } from '../../../core/observation/model.ts'
import { normalized } from '../../../core/model/text-search.ts'
import { fold } from '../observation/fold.ts'
import type { SearchRun } from '../observation/search.ts'
import type { VignetteElement, VignetteValue } from './model.ts'

export interface Declared {
  readonly observable: Observable
  readonly object: OperationalObject
  readonly element?: VignetteElement
}

/** Two names alike once folded: case, marks, æ/ø/å and punctuation aside. */
export const same = (left: string, right: string): boolean => normalized(fold(left)) === normalized(fold(right))

export const visibleObject = (run: SearchRun, objectId: string): OperationalObject | undefined =>
  run.denied.has(objectId) ? undefined : run.objects.find(object => object.id === objectId)

/** An object's declaration as the caller reads it (with these elements' observables), or null where it declares none to the caller. */
export const declarationOf = async (run: SearchRun, objectId: string, elementIds?: ReadonlyArray<string>): Promise<ObservationDeclaration | null> => {
  if (visibleObject(run, objectId) === undefined) return null
  const [declaration] = await run.port.declarations([objectId as ObjectId], elementIds)
  return declaration === undefined || 'refused' in declaration ? null : declaration
}

const elementOf = (declaration: ObservationDeclaration, id: string | undefined): VignetteElement | undefined =>
  id === undefined ? undefined : declaration.elements.find(entry => entry.id === id)

/** The declarations of these refs, by ref; a ref the caller may not read is absent. */
export const declaredRefs = async (run: SearchRun, refs: ReadonlyArray<string>): Promise<ReadonlyMap<string, Declared>> => {
  const found = new Map<string, Declared>()
  for (const objectId of new Set(refs.map(refObjectId))) {
    const object = visibleObject(run, objectId)
    const base = await declarationOf(run, objectId)
    if (object === undefined || base === null) continue
    const add = (declaration: ObservationDeclaration): void => {
      for (const observable of declaration.observables) {
        if (refs.includes(observable.ref) && !found.has(observable.ref)) {
          const element = elementOf(declaration, observable.element) ?? elementOf(base, observable.element)
          found.set(observable.ref, { observable, object, ...(element === undefined ? {} : { element }) })
        }
      }
    }
    add(base)
    const missing = refs.filter(ref => refObjectId(ref) === objectId && !found.has(ref)).map(ref => ref.slice(ref.indexOf('#') + 1))
    const asked = base.elements.filter(element => missing.some(signal => signal.includes(element.id))).map(element => element.id).slice(0, 256)
    if (asked.length > 0) {
      const extended = await declarationOf(run, objectId, asked)
      if (extended !== null) add(extended)
    }
  }
  return found
}

/** A declared observable as a vignette names it (R25). */
export const valueOf = ({ observable, object, element }: Declared): VignetteValue => ({
  ref: observable.ref, label: `${object.label} · ${observable.label}`.slice(0, 80), quantity: observable.quantity, unit: observable.unit,
  valueType: observable.valueType, thresholds: observable.thresholds, series: observable.series,
  ...(observable.states === undefined ? {} : { states: observable.states }), ...(observable.decades === true ? { decades: true } : {}),
  ...(element === undefined ? {} : { element: named(element) }),
})
/** An element as a value names it: what it leads with stays in its declaration. */
const named = ({ id, class: kind, label, shortLabel, group, parent }: VignetteElement): VignetteElement =>
  ({ id, class: kind, label, ...(shortLabel === undefined ? {} : { shortLabel }), ...(group === undefined ? {} : { group }), ...(parent === undefined ? {} : { parent }) })
