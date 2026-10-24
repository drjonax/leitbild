import { embeddedViewEnvelopeSchema, type EmbeddedViewEnvelope } from '@leitbild/contracts'
import type { SimulationRunId } from '../../core/model/index.ts'
import { workspaceApiPath } from '../workspace-context.ts'

// World's default display of a subject (an asset, `<asset>#<ref>`,
// `<asset>#<element>` or a declared group's set), as World composes it for a person (POST
// displays/default) and as the display window and a procedure tag's dialog
// frame it: read-only, the Run its subject, as for a display shown below an
// agent's answer.

/** The embedded view World composes as a subject's default. */
export interface DefaultDisplayView {
  readonly viewType: string
  readonly title: string
  readonly height: number
  readonly state: string
}

/** World's default display of a subject; a refusal throws with World's words. */
export const readDefaultDisplay = async (simulationRunId: SimulationRunId, subject: string | { readonly of: { readonly category: string; readonly group: string } }): Promise<DefaultDisplayView> => {
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/displays/default`), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject }),
  })
  const body = await response.json() as { readonly result?: { readonly view: DefaultDisplayView }; readonly error?: { readonly message?: string } }
  if (!response.ok || body.result === undefined) throw new Error(body.error?.message ?? `World answered HTTP ${response.status}`)
  return body.result.view
}

/** The default's embedded view, framed read-only on the Run. */
export const defaultDisplayEnvelope = (config: {
  readonly workspaceId: string
  readonly simulationRunId: SimulationRunId
  readonly view: DefaultDisplayView
}): EmbeddedViewEnvelope => embeddedViewEnvelopeSchema.parse({
  moduleId: 'world',
  subject: { workspaceId: config.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: config.simulationRunId },
  viewType: config.view.viewType,
  title: config.view.title,
  height: config.view.height,
  state: config.view.state,
})
