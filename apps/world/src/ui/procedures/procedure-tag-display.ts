import { embeddedViewEnvelopeSchema, embeddedViewFragment, embeddedViewPath, type EmbeddedViewEnvelope } from '@leitbild/contracts'
import type { ProcedureTag, SimulationRunId } from '../../core/model/index.ts'
import { workspaceApiPath } from '../workspace-context.ts'
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

/** What World composes as a subject's default display: the embedded view to frame. */
export interface ProcedureTagView {
  readonly viewType: string
  readonly title: string
  readonly height: number
  readonly state: string
}

/** World's default display of a subject, as the person reads it (POST displays/default); a refusal throws with World's words. */
export const readDefaultDisplay = async (simulationRunId: SimulationRunId, subject: string): Promise<ProcedureTagView> => {
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/displays/default`), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject }),
  })
  const body = await response.json() as { readonly result?: { readonly view: ProcedureTagView }; readonly error?: { readonly message?: string } }
  if (!response.ok || body.result === undefined) throw new Error(body.error?.message ?? `World answered HTTP ${response.status}`)
  return body.result.view
}

/** The display's embedded view, framed read-only: the Run is its subject, as for a display shown below an agent's answer. */
export const procedureTagDisplayEnvelope = (config: {
  readonly workspaceId: string
  readonly simulationRunId: SimulationRunId
  readonly view: ProcedureTagView
}): EmbeddedViewEnvelope => embeddedViewEnvelopeSchema.parse({
  moduleId: 'world',
  subject: { workspaceId: config.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: config.simulationRunId },
  viewType: config.view.viewType,
  title: config.view.title,
  height: config.view.height,
  state: config.view.state,
})

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
