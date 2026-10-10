import { z } from 'zod'
import { EMBEDDED_VIEW_MAX_HEIGHT, embeddedViewPublicationSchema } from '@leitbild/contracts'
import { idSchema, type IsoTimestamp, type ObjectId, type OperationalObject } from '../../../core/model/index.ts'
import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import { rejectCapabilityInput, rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import { variablePathSchema } from '../graph/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { processPlantSignalQuality } from '../signals.ts'
import { processPlantOperatingMode } from '../runtime/index.ts'
import {
  COMPOSED_DISPLAY_VIEW_TYPE,
  PROCESS_DISPLAY_SAMPLE_MAX_PATHS,
  composedDisplayCompositionSchema,
  composedDisplayStateSchema,
  overviewDisplayStateSchema,
  processDisplayStatePlantId,
  processDisplayStateSchema,
} from '../displays/composition.ts'
import {
  compileComposedDisplay,
  compileDetailDisplay,
  compileOverviewDisplay,
  type CompiledComposedDisplay,
  type OverviewView,
  composedDisplayShows,
  composedDisplayMargins,
  composedDisplaySignals,
  composedDisplayWarnings,
  formatComposedDisplayIssues,
  formatComposedViewIssues,
} from '../displays/compose.ts'
import { requirePlant } from './common.ts'
import { simulationClock } from '../displays/display-text.ts'
import { indexSample, itemLook } from '../displays/mimic/evaluate.ts'
import { mimicItemId } from '../displays/mimic/bindings.ts'

export const processPlantComposedDisplayQueryKinds = [
  'world.process-plant.display.compose',
  'world.process-plant.display.overview',
  'world.process-plant.display.view',
  'world.process-plant.display.sample',
] as const

// The compose input is validated by the compiler so every issue is reported
// at once; the capability schema only requires the target Plant.
export const displayComposeQuerySchema = composedDisplayCompositionSchema
export const displayOverviewQuerySchema = z.object({
  plantId: idSchema,
}).strict()
export const displayViewQuerySchema = z.object({
  plantId: idSchema,
  state: z.string().min(2),
  /** The view's inner size in CSS px: a unit overview, and equipment opened from it, is drawn for it. */
  size: z.object({ width: z.number().int().min(1).max(16_384), height: z.number().int().min(1).max(16_384) }).strict().optional(),
}).strict()
// One sample serves one view: a unit overview reads the most.
export const displaySampleQuerySchema = z.object({
  plantId: idSchema,
  paths: z.array(variablePathSchema).min(1).max(PROCESS_DISPLAY_SAMPLE_MAX_PATHS),
  alarms: z.boolean().default(false),
}).strict()

// Generated displays per Plant, by what they show and the view size: windows
// rarely change size, an operator returns to the same equipment, and
// resizing recompiles only for sizes not yet drawn.
const GENERATED_CACHE_SIZE = 16
const generatedCache = new WeakMap<ProcessPlantRuntimeInstance, Map<string, CompiledComposedDisplay>>()

const compiledOrRejected = (
  system: ProcessPlantRuntimeInstance,
  composition: unknown,
  purpose: 'compose' | 'view',
  recordedSeriesIds: ReadonlySet<string>,
) => {
  const result = compileComposedDisplay(system, composition, purpose, recordedSeriesIds)
  if (!result.ok) return rejectCapabilityInput(purpose === 'compose' ? formatComposedDisplayIssues(result.issues) : formatComposedViewIssues(result.issues))
  return result.display
}

export const answerProcessPlantComposedDisplayQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly objects: ReadonlyMap<ObjectId, Pick<OperationalObject, 'id' | 'label'>>
  readonly simulationTime?: IsoTimestamp
  readonly recordedSeriesIds?: ReadonlySet<string>
}): unknown | undefined => {
  if (!processPlantComposedDisplayQueryKinds.some(kind => kind === config.request.capabilityId)) return undefined
  const simulationTime = config.simulationTime
  if (simulationTime === undefined) throw new Error(`${config.request.capabilityId} requires the Simulation Run time of the answering runtime`)
  const recordedSeriesIds = config.recordedSeriesIds
  if (recordedSeriesIds === undefined) throw new Error(`${config.request.capabilityId} requires the series recorded by the answering runtime`)

  if (config.request.capabilityId === 'world.process-plant.display.compose') {
    const plantId = idSchema.parse((config.request.input as { plantId?: unknown } | null)?.plantId)
    const system = requirePlant(config.plants, plantId)
    const display = compiledOrRejected(system, config.request.input, 'compose', recordedSeriesIds)
    const mimics = display.panels.flatMap(panel => panel.kind === 'mimic' ? [panel.mimic] : [])
    const state = composedDisplayStateSchema.parse({
      composition: composedDisplayCompositionSchema.parse(config.request.input),
      issuedAt: simulationTime,
      modelDigest: display.modelDigest,
      ...(mimics.length === 0 ? {} : { drawings: mimics.map(mimic => mimic.hash) }),
    })
    const now = indexSample(mimics.flatMap(mimic => mimic.paths).map(path => {
      const snapshot = system.runtime.readVariableSnapshot(path)
      return { path, value: snapshot.value, quality: processPlantSignalQuality(snapshot).status }
    }))
    return {
      plantId: display.plantId,
      issuedAt: simulationTime,
      view: embeddedViewPublicationSchema.parse({
        viewType: COMPOSED_DISPLAY_VIEW_TYPE,
        title: display.title,
        height: display.height,
        state: JSON.stringify(state),
      }),
      // The display header's clock, so the answer gives times as the display does.
      simulationClock: simulationClock(Date.parse(simulationTime)),
      signals: composedDisplaySignals(display),
      shows: composedDisplayShows(display),
      margins: composedDisplayMargins(display, path => system.runtime.readVariableSnapshot(path).value),
      warnings: composedDisplayWarnings(display),
      // What the mimic draws now, so the answer states equipment exactly as the operator sees it.
      equipment: mimics.flatMap(mimic => mimic.items
        .map(item => ({ id: mimicItemId(system.plant.graph, item.binding.item), label: item.binding.label, state: itemLook(item.binding, now).words || 'no state drawn' }))),
    }
  }

  // The asset label distinguishes identical units; null when the Plant has no projected asset.
  const plantLabelOf = (plantId: string): string | null => config.objects.get(plantId as ObjectId)?.label ?? null
  const generatedOrRejected = (
    system: ProcessPlantRuntimeInstance,
    shows: string,
    view: OverviewView | null,
    compile: () => ReturnType<typeof compileOverviewDisplay>,
    /** What the refusal is about; null where the view names it (equipment opened from an overview says what it opened). */
    refusal: string | null,
  ) => {
    const key = `${shows}|${view === null ? 'natural' : `${view.width}x${view.height}`}`
    const cached = generatedCache.get(system)?.get(key)
    if (cached !== undefined) return cached
    const result = compile()
    if (!result.ok) return rejectCapabilityTarget(`${refusal === null ? '' : `${refusal}: `}${result.issues.map(issue => issue.message).join('; ')}`)
    const displays = generatedCache.get(system) ?? new Map<string, CompiledComposedDisplay>()
    if (displays.size >= GENERATED_CACHE_SIZE) displays.delete(displays.keys().next().value!)
    displays.set(key, result.display)
    generatedCache.set(system, displays)
    return result.display
  }
  const overviewOrRejected = (system: ProcessPlantRuntimeInstance, view: OverviewView | null) =>
    generatedOrRejected(system, 'overview', view, () => compileOverviewDisplay(system, recordedSeriesIds, view), `Process Plant ${system.plant.id} has no unit overview`)

  if (config.request.capabilityId === 'world.process-plant.display.overview') {
    const payload = displayOverviewQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    const display = overviewOrRejected(system, null)
    const mimics = display.panels.flatMap(panel => panel.kind === 'mimic' ? [panel.mimic] : [])
    const now = indexSample(mimics.flatMap(mimic => mimic.paths).map(path => {
      const snapshot = system.runtime.readVariableSnapshot(path)
      return { path, value: snapshot.value, quality: processPlantSignalQuality(snapshot).status }
    }))
    const label = plantLabelOf(display.plantId)
    return {
      plantId: display.plantId,
      view: embeddedViewPublicationSchema.parse({
        viewType: COMPOSED_DISPLAY_VIEW_TYPE,
        title: `${label ?? display.plantId} overview`,
        // A chat card reserves at most this; a window shows the whole overview.
        height: Math.min(display.height, EMBEDDED_VIEW_MAX_HEIGHT),
        state: JSON.stringify(overviewDisplayStateSchema.parse({ overview: { plantId: display.plantId } })),
      }),
      simulationClock: simulationClock(Date.parse(simulationTime)),
      shows: composedDisplayShows(display),
      equipment: mimics.flatMap(mimic => mimic.items
        .map(item => ({ id: mimicItemId(system.plant.graph, item.binding.item), label: item.binding.label, state: itemLook(item.binding, now).words || 'no state drawn' }))),
    }
  }

  if (config.request.capabilityId === 'world.process-plant.display.view') {
    const payload = displayViewQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    const parsedState = processDisplayStateSchema.safeParse(JSON.parse(payload.state))
    if (!parsedState.success) return rejectCapabilityInput(`Unsupported display format: ${parsedState.error.message}`)
    const state = parsedState.data
    const statePlantId = processDisplayStatePlantId(state)
    if (statePlantId !== payload.plantId) return rejectCapabilityInput(`Display state targets ${statePlantId}, not ${payload.plantId}`)
    if ('overview' in state) {
      if (payload.size === undefined) return rejectCapabilityInput('A unit overview is drawn for the view it is shown in: send its size')
      const display = overviewOrRejected(system, payload.size)
      return { kind: 'overview', plantId: display.plantId, plantLabel: plantLabelOf(display.plantId), simulationTime, display }
    }
    if ('detail' in state) {
      if (payload.size === undefined) return rejectCapabilityInput('Equipment opened from an overview is drawn for the view it is shown in: send its size')
      const components = state.detail.components
      const display = generatedOrRejected(system, `detail:${components.join(',')}`, payload.size, () => compileDetailDisplay(system, recordedSeriesIds, components, payload.size!), null)
      return { kind: 'detail', plantId: display.plantId, plantLabel: plantLabelOf(display.plantId), simulationTime, display }
    }
    const display = compiledOrRejected(system, state.composition, 'view', recordedSeriesIds)
    return {
      kind: 'advice',
      plantId: display.plantId,
      plantLabel: plantLabelOf(display.plantId),
      issuedAt: state.issuedAt,
      simulationTime,
      modelChanged: state.modelDigest !== display.modelDigest,
      drawingChanged: display.panels.flatMap(panel => panel.kind === 'mimic' ? [panel.mimic.hash] : []).some((hash, at) => hash !== state.drawings?.[at]),
      display,
    }
  }

  const payload = displaySampleQuerySchema.parse(config.request.input)
  const system = requirePlant(config.plants, payload.plantId)
  const protection = payload.alarms ? system.protection?.snapshot() : undefined
  if (payload.alarms && protection === undefined) return rejectCapabilityTarget(`Process Plant ${payload.plantId} has no configured alarms`)
  // Where the Plant declares operating modes, the one it is in, or null where none holds.
  const modes = system.plant.automation.operatingModes
  const mode = modes.length === 0 ? undefined : processPlantOperatingMode({ system: system.plant, runtime: system.runtime, modes })
  return {
    plantId: payload.plantId,
    simulationTime,
    plantElapsedMs: system.runtime.elapsedMs(),
    ...(mode === undefined ? {} : { mode: mode === null ? null : { id: mode.id, label: mode.label } }),
    ...(protection === undefined ? {} : {
      // Shelved, suppressed and out-of-service alarms annunciate nowhere; one
      // that cleared unacknowledged stays listed until it is acknowledged.
      alarms: [...protection.alarms, ...protection.trips]
        .filter(lifecycle => !lifecycle.shelved && !lifecycle.suppressed && !lifecycle.outOfService && (lifecycle.active || lifecycle.phase === 'clearedUnacknowledged'))
        .map(lifecycle => ({
          id: lifecycle.id,
          ruleId: lifecycle.ruleId,
          kind: lifecycle.kind,
          title: lifecycle.title,
          severity: lifecycle.severity,
          active: lifecycle.active,
          acknowledged: lifecycle.acknowledged,
          firstOut: lifecycle.firstOut,
          ...(lifecycle.firstActiveElapsedMs === undefined ? {} : { firstActiveElapsedMs: lifecycle.firstActiveElapsedMs }),
        })),
    }),
    values: payload.paths.map(path => {
      if (!system.plant.graph.signalBindingByPath.has(path)) return rejectCapabilityTarget(`Process Plant signal path not found: ${path}`)
      const variable = system.runtime.readVariableSnapshot(path)
      const quality = processPlantSignalQuality(variable)
      return { path, value: variable.value, quality: quality.status }
    }),
  }
}
