import { embeddedViewFragment, embeddedViewPath, type EmbeddedViewEnvelope } from '@leitbild/contracts'
import type { ProcedureTag } from '../../core/model/index.ts'
import type { ProcedureTagValidation, ProcedureTagValue } from './procedure-client.ts'

// What a clicked procedure tag's dialog shows, decided before anything is
// drawn: a tag the unit's model does not hold says so; otherwise World's
// default display of the signal the tag names on the unit (displays/default
// for `<unit>#<signal path>`, the exact ref the tag resolved to, else
// `<unit>#<tag>`) is drawn first and shown only where it can be.

export type ProcedureTagDisplayPlan =
  | { readonly kind: 'unchecked'; readonly message: string }
  | { readonly kind: 'not-in-model'; readonly message: string }
  | { readonly kind: 'display'; readonly subject: string }

export const procedureTagDisplayPlan = (scopeId: string, tagId: string, validation: ProcedureTagValidation | undefined): ProcedureTagDisplayPlan => {
  if (validation === undefined) return { kind: 'unchecked', message: "Not checked against this unit's plant model" }
  if (validation.status === 'missing') return { kind: 'not-in-model', message: "Not in this unit's plant model" }
  const path = validation.signal?.path
  return { kind: 'display', subject: `${scopeId}#${typeof path === 'string' ? path : tagId}` }
}

export const procedureTagDisplaySource = (envelope: EmbeddedViewEnvelope): string =>
  `${embeddedViewPath(envelope)}${embeddedViewFragment(envelope)}`

/** How the tag is bound, in one line: the signal it reads, and every warning the binding or the reading carries. */
export const procedureTagBindingLine = (
  validation: ProcedureTagValidation | undefined,
  value: ProcedureTagValue | null,
): string => {
  if (validation === undefined) return "Binding not checked against this unit's plant model"
  if (validation.status === 'missing') return "No signal in this unit's plant model"
  const path = typeof validation.signal?.path === 'string' ? validation.signal.path : value?.path
  const notes = [
    ...validation.warnings,
    ...(value?.warning === undefined || validation.warnings.includes(value.warning) ? [] : [value.warning]),
    ...(value?.quality === undefined || value.quality === 'good' ? [] : [`quality ${value.quality}`]),
  ]
  return [path === undefined ? 'Bound' : `Bound to ${path}`, ...notes].join(' · ')
}

/** The tag's declared meaning, as the procedure states it. */
export const procedureTagDeclared = (tag: Pick<ProcedureTag, 'description' | 'units' | 'equipment'>): string | null => {
  const parts = [
    ...(tag.description === undefined ? [] : [tag.description]),
    ...(tag.equipment === undefined ? [] : [`equipment ${tag.equipment}`]),
    ...(tag.units === undefined ? [] : [`in ${tag.units}`]),
  ]
  return parts.length === 0 ? null : parts.join(' · ')
}

/** A reading as the dialog states it: a two-state signal names what it says ("Reactor trip breaker A closed: no"), a number its value and unit. */
export const procedureTagReadingText = (reading: { readonly label: string; readonly value: unknown; readonly formatted: string }): string =>
  typeof reading.value === 'boolean' ? `${reading.label}: ${reading.value ? 'yes' : 'no'}` : reading.formatted
