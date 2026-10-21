/**
 * World's display surface (architecture A6): the Assistant's one display
 * Capability, `world.simulation-run.display.compose`, and the person routes
 * that open, sample and default a vignette. Every one reads as its caller.
 * The routes take a vignette's state and read only what it names; none takes
 * free refs. Rows become pixels here, at this boundary, so features/displays
 * stays pixel-free.
 */
import {
  displayCardSchema, EMBEDDED_VIEW_MAX_HEIGHT, EMBEDDED_VIEW_MIN_HEIGHT, EMBEDDED_VIEW_STATE_MAX_LENGTH, embeddedViewPublicationSchema,
  moduleIdSchema, type ModuleCapabilityInvocation,
} from '@leitbild/contracts'
import type { CapabilityRegistration } from '@leitbild/module-runtime'
import { z } from 'zod'
import { composeDefault, composeVignette, type ComposeOutcome } from '../../features/displays/compose/compose.ts'
import { vignetteStateSchema, type VignetteState } from '../../features/displays/compose/model.ts'
import { compileVignette, sampleVignette, type ViewRun } from '../../features/displays/compose/view.ts'
import { capabilityJsonSchema } from '../../simulation/capabilities.ts'
import { VIGNETTE_ROW_PX } from '../../ui/embed/vignette/grid.ts'
import type { ObjectId } from '../model/index.ts'
import { displaySpecSchema, subjectSchema } from '../observation/spec.ts'
import type { Actor } from '../simulation-runs/actors.ts'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../simulation-runs/runtime.ts'
import { apiError, json } from './responses.ts'

export const VIGNETTE_VIEW_TYPE = 'display.vignette'
const MODULE_ID = moduleIdSchema.parse('world')

/** A frame of `rows` grid rows, within what an embedder reserves. */
export const vignetteHeight = (rows: number): number => Math.min(EMBEDDED_VIEW_MAX_HEIGHT, Math.max(EMBEDDED_VIEW_MIN_HEIGHT, rows * VIGNETTE_ROW_PX))

const composedSchema = z.object({ view: embeddedViewPublicationSchema, card: displayCardSchema }).strict()

/** A Run as the composer reads it, as this caller: its objects, Packs and clock, and what the caller may not inspect. */
export const displayRunOf = async (registry: SimulationRunRegistry, runtime: SimulationRunRuntime, actor: Actor, denied: ReadonlySet<string>): Promise<ViewRun> => {
  const snapshot = runtime.snapshot()
  return {
    objects: snapshot.objects, denied, packs: runtime.packs(), port: runtime.observations(actor), clock: snapshot.clock,
    connections: (await registry.compiledScenarioForRun(runtime.id)).connections,
    series: (seriesId, from, to) => {
      const page = runtime.recordedSamples({ mode: 'raw', seriesId, from, to, timeAxis: 'simulation', limit: 2_000 })
      return page.mode !== 'raw' ? [] : page.samples.flatMap(sample => typeof sample.value === 'number' || typeof sample.value === 'boolean'
        ? [{ t: Date.parse(sample.simulationTime ?? sample.observedAt), v: Number(sample.value) }] : []).reverse()
    },
  }
}

/** A composed vignette as an embedded view and its card, or the composer's refusal with every issue. */
export const composedResponse = (outcome: ComposeOutcome): Response => {
  if (!outcome.ok) return apiError(422, outcome.issues[0]!.code, outcome.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '), { issues: outcome.issues })
  const state = JSON.stringify(outcome.state)
  return json({ result: composedSchema.parse({ view: { viewType: VIGNETTE_VIEW_TYPE, title: outcome.state.title, height: vignetteHeight(outcome.rows), state }, card: outcome.card }) })
}

const stateSchema = z.string().min(2).max(EMBEDDED_VIEW_STATE_MAX_LENGTH).transform((text, ctx): VignetteState => {
  const parsed = vignetteStateSchema.safeParse((() => { try { return JSON.parse(text) as unknown } catch { return undefined } })())
  if (!parsed.success) { ctx.addIssue({ code: 'custom', message: 'not a vignette state' }); return z.NEVER }
  return parsed.data
})
export const displayRouteInputs = {
  view: z.object({ state: stateSchema }).strict(),
  sample: z.object({ state: stateSchema, history: z.object({ fromMs: z.number().int().nonnegative() }).strict().optional() }).strict(),
  default: z.object({ subject: subjectSchema }).strict(),
} as const

/** The person routes: POST displays/{view,sample,default}, each read as the caller. */
export const handleDisplayRoute = async (kind: string, body: unknown, run: ViewRun): Promise<Response | null> => {
  if (kind === 'view') return json({ view: await compileVignette(run, displayRouteInputs.view.parse(body).state) })
  if (kind === 'sample') {
    const input = displayRouteInputs.sample.parse(body)
    return json({ sample: await sampleVignette(run, input.state, input.history) })
  }
  if (kind === 'default') return composedResponse(await composeDefault(run, displayRouteInputs.default.parse(body).subject))
  return null
}

type Invocation = ModuleCapabilityInvocation
/** The Assistant's display Capability; the API supplies how a Resource, an actor and the denied objects come from an invocation. */
export const displayCapabilities = (ports: {
  readonly runOf: (registry: SimulationRunRegistry, invocation: Invocation) => Promise<{ readonly runtime: SimulationRunRuntime; readonly actor: Actor; readonly denied: ReadonlySet<ObjectId | string> }>
}): ReadonlyArray<CapabilityRegistration<SimulationRunRegistry, Response>> => [{
  descriptor: {
    id: 'world.simulation-run.display.compose', moduleId: MODULE_ID, kind: 'query', scope: { kind: 'resource', resourceType: 'world.simulation-run' },
    title: 'Compose a vignette',
    description: 'Composes one live vignette for an answer from up to 6 subjects (exact refs from the Run context, objectId#tag-or-label, an object id for its lead values, a Scenario connection id, or {of: {category}} for things that come and go) and up to 4 views (trend, values, alerts, topology, map); no views gives each subject\'s World default. World draws it from what Packs declare; never pass numbers, limits, colours or coordinates. Returns the view and a card whose keyed items an answer cites as ⟦k1⟧. An unknown name is refused with the nearest names.',
    searchTerms: ['show display', 'vignette', 'compose display', 'show trend', 'show alarms', 'show on map'],
    risk: 'read', idempotent: true, publishes: ['embedded-view'],
    inputSchema: capabilityJsonSchema(displaySpecSchema), outputSchema: capabilityJsonSchema(composedSchema),
  },
  invoke: async (registry: SimulationRunRegistry, invocation: Invocation): Promise<Response> => {
    const spec = displaySpecSchema.parse(invocation.input)
    const { runtime, actor, denied } = await ports.runOf(registry, invocation)
    return composedResponse(await composeVignette(await displayRunOf(registry, runtime, actor, denied), spec))
  },
}]
