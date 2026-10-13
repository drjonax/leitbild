import { EMBEDDED_VIEW_MAX_HEIGHT, embeddedViewEnvelopeSchema, embeddedViewFragment, embeddedViewPath, type EmbeddedViewEnvelope } from '@leitbild/contracts'
import type { ProcedureTag, SimulationRunId } from '../../core/model/index.ts'
import type { PackProcedureContribution, PackProcedureTagDisplay } from '../../core/packs/protocol.ts'
import type { ProcedureTagValidation, ProcedureTagValue } from './procedure-client.ts'

// What a clicked procedure tag's dialog shows, decided before anything is
// drawn: a tag the unit's model does not hold, or one its Pack names no
// equipment for, says so; otherwise the Pack's display is drawn first and
// shown only where it can be.

export type ProcedureTagDisplayPlan =
  | { readonly kind: 'unchecked'; readonly message: string }
  | { readonly kind: 'not-in-model'; readonly message: string }
  | { readonly kind: 'no-display'; readonly message: string; readonly reason: string }
  | { readonly kind: 'display'; readonly display: PackProcedureTagDisplay }

export const procedureTagDisplayPlan = (
  scopeId: string,
  validation: ProcedureTagValidation | undefined,
  provider: PackProcedureContribution,
): ProcedureTagDisplayPlan => {
  if (validation === undefined) return { kind: 'unchecked', message: "Not checked against this unit's plant model" }
  if (validation.status === 'missing') return { kind: 'not-in-model', message: "Not in this unit's plant model" }
  const noDisplay = 'No process display can be drawn for this tag'
  if (provider.tagDisplay === undefined) return { kind: 'no-display', message: noDisplay, reason: "this unit's Pack draws no process displays" }
  const display = provider.tagDisplay(scopeId, validation)
  if (display === null) return { kind: 'no-display', message: noDisplay, reason: 'the model names no equipment it is measured on' }
  return { kind: 'display', display }
}

/** The display's embedded view, framed read-only: the Run is its subject, as for a display shown below an agent's answer. */
export const procedureTagDisplayEnvelope = (config: {
  readonly workspaceId: string
  readonly simulationRunId: SimulationRunId
  readonly display: PackProcedureTagDisplay
}): EmbeddedViewEnvelope => embeddedViewEnvelopeSchema.parse({
  moduleId: 'world',
  subject: { workspaceId: config.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: config.simulationRunId },
  viewType: config.display.viewType,
  title: config.display.title,
  height: EMBEDDED_VIEW_MAX_HEIGHT,
  state: config.display.state,
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
