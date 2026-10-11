import { z } from 'zod'
import { EMBEDDED_VIEW_MAX_HEIGHT, embeddedViewContentSchema, embeddedViewPublicationSchema } from '@leitbild/contracts'
import { idSchema, type IsoTimestamp, type ObjectId, type OperationalObject } from '../../../core/model/index.ts'
import type { PackRuntimeQuery, PackRuntimeRecordedHistory } from '../../../simulation/protocol.ts'
import { rejectCapabilityInput, rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import { variablePathSchema, type VariablePath } from '../graph/index.ts'
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
  detailLeadKey,
  overviewLeadKey,
  compileOverviewDisplay,
  type CompiledComposedDisplay,
  type OverviewView,
  composedDisplayContent,
  shownQuantity,
  composedDisplayShows,
  composedDisplayMargins,
  readComposedDisplay,
  composedDisplaySignals,
  composedDisplayWarnings,
  formatComposedDisplayIssues,
  formatComposedViewIssues,
  withEvidence,
} from '../displays/compose.ts'
import { displayEvidence } from '../displays/evidence.ts'
import { requirePlant } from './common.ts'
import { displayValue, simulationClock, valueDigits, writtenDecimals } from '../displays/display-text.ts'
import { indexSample, itemLook } from '../displays/mimic/evaluate.ts'
import { valueRowReading } from '../displays/mimic/rows.ts'
import { mimicItemId } from '../displays/mimic/bindings.ts'
import { trendPoints, type PlantModeNow } from '../displays/trend-reading.ts'
import { evaluateSafetyFunctions } from '../safety-functions.ts'
import { safetyFunctionChip, safetyFunctionShows, safetyFunctionStatuses } from '../displays/safety-function-content.ts'

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
// resizing recompiles only for sizes not yet drawn. The display used longest
// ago is evicted first.
const GENERATED_CACHE_SIZE = 16
const generatedCache = new WeakMap<ProcessPlantRuntimeInstance, Map<string, CompiledComposedDisplay>>()

/**
 * The alarms and trips a display shows: shelved, suppressed and
 * out-of-service ones annunciate nowhere; one that cleared unacknowledged
 * stays listed until it is acknowledged.
 */
const annunciated = (system: ProcessPlantRuntimeInstance) => {
  const protection = system.protection?.snapshot()
  return protection === undefined ? undefined : [...protection.alarms, ...protection.trips]
    .filter(lifecycle => !lifecycle.shelved && !lifecycle.suppressed && !lifecycle.outOfService && (lifecycle.active || lifecycle.phase === 'clearedUnacknowledged'))
}

/** Where the Plant declares operating modes, the one it is in, or null where none holds. */
const modeNow = (system: ProcessPlantRuntimeInstance): PlantModeNow => {
  const modes = system.plant.automation.operatingModes
  if (modes.length === 0) return undefined
  const mode = processPlantOperatingMode({ system: system.plant, runtime: system.runtime, modes })
  return mode === null ? null : { id: mode.id, label: mode.label }
}

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
  /** What the Run's historian holds: a composed display reads the recent history of the signals it draws over time. */
  readonly recordedHistory?: PackRuntimeRecordedHistory
}): unknown | undefined => {
  if (!processPlantComposedDisplayQueryKinds.some(kind => kind === config.request.capabilityId)) return undefined
  const simulationTime = config.simulationTime
  if (simulationTime === undefined) throw new Error(`${config.request.capabilityId} requires the Simulation Run time of the answering runtime`)
  const recordedSeriesIds = config.recordedSeriesIds
  if (recordedSeriesIds === undefined) throw new Error(`${config.request.capabilityId} requires the series recorded by the answering runtime`)

  if (config.request.capabilityId === 'world.process-plant.display.compose') {
    const plantId = idSchema.parse((config.request.input as { plantId?: unknown } | null)?.plantId)
    const system = requirePlant(config.plants, plantId)
    const chosen = compiledOrRejected(system, config.request.input, 'compose', recordedSeriesIds)
    const read = (path: VariablePath) => system.runtime.readVariableSnapshot(path).value
    // The display opens on the history the Run recorded, as the operator's
    // view reads it: one bounded read per signal it draws over time, kept
    // for the second reading once World's evidence is added.
    const recordedHistory = config.recordedHistory
    const histories = new Map<string, ReturnType<typeof trendPoints>>()
    const opening = {
      read,
      simulationMs: Date.parse(simulationTime),
      mode: modeNow(system),
      activeRuleIds: new Set((annunciated(system) ?? []).filter(lifecycle => lifecycle.active).map(lifecycle => lifecycle.ruleId)),
      history: (seriesId: string, window: { readonly from: number; readonly to: number }, limit: number) => {
        if (recordedHistory === undefined) throw new Error(`${config.request.capabilityId} requires the history recorded by the answering runtime`)
        const key = `${seriesId}|${window.from}|${window.to}|${limit}`
        const known = histories.get(key)
        if (known !== undefined) return known
        const points = trendPoints(recordedHistory.read({ seriesId, from: new Date(window.from).toISOString() as IsoTimestamp, to: new Date(window.to).toISOString() as IsoTimestamp, limit }))
        histories.set(key, points)
        return points
      },
    }
    const sample = (path: VariablePath) => {
      const snapshot = system.runtime.readVariableSnapshot(path)
      return { value: snapshot.value, quality: processPlantSignalQuality(snapshot).status }
    }
    // What the Plant's model says bears on the question besides what the agent chose, read as the agent's panels open.
    const completed = withEvidence(system, chosen, displayEvidence(system, chosen, readComposedDisplay(chosen, opening), sample, recordedSeriesIds), recordedSeriesIds)
    if (!completed.ok) throw new Error(`evidence World adds must resolve: ${completed.issues.map(issue => issue.message).join('; ')}`)
    const display = completed.display
    const mimics = display.panels.flatMap(panel => panel.kind === 'mimic' ? [panel.mimic] : [])
    const state = composedDisplayStateSchema.parse({
      composition: composedDisplayCompositionSchema.parse(config.request.input),
      issuedAt: simulationTime,
      modelDigest: display.modelDigest,
      ...(mimics.length === 0 ? {} : { drawings: mimics.map(mimic => mimic.hash) }),
      ...(completed.evidence.length === 0 ? {} : { evidence: completed.evidence }),
    })
    const now = indexSample(mimics.flatMap(mimic => mimic.paths).map(path => ({ path, ...sample(path) })))
    const opened = readComposedDisplay(display, opening)
    // The critical safety functions its header shows, judged as it opens.
    const safetyFunctions = evaluateSafetyFunctions(system.plant, system.runtime)
    // Elapsed age sizes the trend axis (rounded up, minimum one minute); it
    // does not establish how much Historian data exists within that axis.
    const historyMs = system.runtime.elapsedMs()
    const drawn = mimics.flatMap(mimic => mimic.items.map(item => ({
      id: mimicItemId(system.plant.graph, item.binding.item),
      label: item.binding.label,
      state: itemLook(item.binding, now).words || 'no state drawn',
      // The values written beside it, and what they measure: the wider instrument's where a reading is off its span.
      values: item.rows.flatMap(row => {
        if (row.kind !== 'value') return []
        const reading = valueRowReading(row, now)
        if (reading === null) return []
        const label = system.runtime.readVariableSnapshot(reading.path as VariablePath).label
        // Written as its readout block writes it: the wider instrument in whole units, a reading off its span as the span's end.
        const decimals = reading.end !== null ? writtenDecimals(displayValue(reading.end === 'below' ? reading.span!.min : reading.span!.max, row.unit))
          : reading.wider ? 0 : valueDigits(displayValue(reading.value, row.unit))
        return shownQuantity(reading.value, row.unit, decimals).map(quantity => ({ quantity, label }))
      }),
    })))
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
      shows: [...composedDisplayShows(display, historyMs), ...safetyFunctionShows(safetyFunctions)],
      margins: composedDisplayMargins(opened),
      warnings: composedDisplayWarnings(display),
      // What the mimic draws now, so the answer states equipment exactly as the operator sees it.
      equipment: drawn.map(({ id, label, state }) => ({ id, label, state })),
      // What the view shows, for Agents to check the answer that presents it against.
      viewContent: embeddedViewContentSchema.parse({
        ...composedDisplayContent(display, opened, historyMs, drawn.map(item => ({
          names: [...new Set([item.label, item.id, ...item.values.map(value => value.label)])],
          values: item.values.map(value => value.quantity),
          limits: [],
          history: false,
          state: item.state,
        }))),
        ...(safetyFunctions.length === 0 ? {} : { statuses: safetyFunctionStatuses(safetyFunctions) }),
      }),
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
    const displays = generatedCache.get(system) ?? new Map<string, CompiledComposedDisplay>()
    const cached = displays.get(key)
    if (cached !== undefined) {
      // Used last, evicted last: sweeping a display's zoom through many sizes never evicts the size its window shows.
      displays.delete(key)
      displays.set(key, cached)
      return cached
    }
    const result = compile()
    if (!result.ok) return rejectCapabilityTarget(`${refusal === null ? '' : `${refusal}: `}${result.issues.map(issue => issue.message).join('; ')}`)
    if (displays.size >= GENERATED_CACHE_SIZE) displays.delete(displays.keys().next().value!)
    displays.set(key, result.display)
    generatedCache.set(system, displays)
    return result.display
  }
  const overviewOrRejected = (system: ProcessPlantRuntimeInstance, view: OverviewView | null) =>
    generatedOrRejected(system, `overview|${overviewLeadKey(system)}`, view, () => compileOverviewDisplay(system, recordedSeriesIds, view), `Process Plant ${system.plant.id} has no unit overview`)

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
      shows: [...composedDisplayShows(display, system.runtime.elapsedMs()), ...safetyFunctionShows(evaluateSafetyFunctions(system.plant, system.runtime))],
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
      // A detail's lead values follow the Plant's mode at opening: one opened in another mode is compiled again.
      const display = generatedOrRejected(system, `detail:${components.join(',')}|${detailLeadKey(system)}`, payload.size, () => compileDetailDisplay(system, recordedSeriesIds, components, payload.size!), null)
      return { kind: 'detail', plantId: display.plantId, plantLabel: plantLabelOf(display.plantId), simulationTime, display }
    }
    const compiled = compiledOrRejected(system, state.composition, 'view', recordedSeriesIds)
    const completed = withEvidence(system, compiled, state.evidence ?? [], recordedSeriesIds)
    if (!completed.ok) return rejectCapabilityInput(formatComposedViewIssues(completed.issues))
    const display = completed.display
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
  const alarms = payload.alarms ? annunciated(system) : undefined
  if (payload.alarms && alarms === undefined) return rejectCapabilityTarget(`Process Plant ${payload.plantId} has no configured alarms`)
  const mode = modeNow(system)
  const safetyFunctions = evaluateSafetyFunctions(system.plant, system.runtime)
  return {
    plantId: payload.plantId,
    simulationTime,
    plantElapsedMs: system.runtime.elapsedMs(),
    ...(mode === undefined ? {} : { mode }),
    ...(safetyFunctions.length === 0 ? {} : { safetyFunctions: safetyFunctions.map(safetyFunctionChip) }),
    ...(alarms === undefined ? {} : {
      alarms: alarms
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
