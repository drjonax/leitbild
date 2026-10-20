import { recordingSeriesIdFor } from '../../core/model/index.ts'
import type {
  IsoTimestamp,
  PackRuntimeRecordingBatch,
  RecordingProfileDescriptor,
  RecordingSeriesDescriptor,
  ScenarioRecordingSelection,
} from '../../core/model/index.ts'
import type { ProcessPlantVariableHandle } from './runtime/variable-table.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import type { CompiledProcessPlant } from './plant-compiler.ts'
import type { VariablePath } from './graph/index.ts'
import { processPlantSignalQuality } from './signals.ts'

export const recordedPlantVariables = (plant: CompiledProcessPlant, profileId: string) => plant.graph.variables.filter(variable =>
  profileId === 'engineering' || ['state', 'control', 'discrete'].includes(variable.descriptor.kind) || variable.descriptor.tagId !== undefined || variable.descriptor.quantity === 'power')

export const processPlantRecordingProfiles: ReadonlyArray<RecordingProfileDescriptor> = [{
  id: 'operations',
  title: 'Operations',
  description: 'State, operator controls, discrete states, tagged instruments and power balances. Other derived engineering diagnostics are excluded. Unchanged values are recorded at most once per minute. Quality describes declared hard-range consistency, not qualified instrumentation.',
  defaultIntervalMs: 1_000,
  minimumIntervalMs: 250,
}, {
  id: 'engineering',
  title: 'Engineering detail',
  description: 'Every declared Plant variable for detailed analysis; intentionally slower and opt-in. Quality describes declared hard-range consistency, not qualified instrumentation.',
  defaultIntervalMs: 5_000,
  minimumIntervalMs: 1_000,
}]

interface ProcessPlantRecordingSeriesPlan {
  readonly plant: ProcessPlantRuntimeInstance
  readonly handle: ProcessPlantVariableHandle
  readonly descriptor: RecordingSeriesDescriptor
}

export interface ProcessPlantRecordingPlan {
  readonly profile: RecordingProfileDescriptor
  readonly intervalMs: number
  readonly descriptors: ReadonlyArray<RecordingSeriesDescriptor>
  readonly sample: (config: {
    readonly observedAt: IsoTimestamp
    readonly simulationTime: IsoTimestamp
  }) => PackRuntimeRecordingBatch
}

/**
 * A recorded series' title, standing alone among every series of the Run: the
 * unit it belongs to (its object's label), what it reads, the equipment that
 * reads it unless its label names it, or the equipment at a pipe's ends, and
 * its tag where it has one: "Halden Unit 2 · Speed · Reactor Coolant Pump A",
 * "Halden Unit 2 · Primary loop flow · Reactor Coolant Pump A to Reactor
 * Vessel", "Halden Unit 2 · Diesel generator voltage · Emergency Diesel
 * Generator A (EDG-A-V)". A title only describes its series: its id, unit and
 * quantity never change with it.
 */
export const recordingSeriesTitle = (plant: CompiledProcessPlant, unitLabel: string, path: VariablePath): string => {
  const graph = plant.graph
  const binding = graph.signalBindingByPath.get(path)
  if (binding === undefined) throw new Error(`recorded process plant variable has no signal binding: ${path}`)
  const label = binding.label
  const reads = binding.owner.type === 'component'
    ? (() => {
        const component = graph.components[binding.owner.componentIndex]!
        return label.toLowerCase().includes(component.label.toLowerCase()) ? label : `${label} · ${component.label}`
      })()
    : (() => {
        const link = graph.links[binding.owner.linkIndex]!
        return `${label} · ${graph.components[link.fromComponentIndex]!.label} to ${graph.components[link.toComponentIndex]!.label}`
      })()
  return `${unitLabel} · ${reads}${binding.tagId === undefined ? '' : ` (${binding.tagId})`}`
}

const recordingProfileFor = (profileId: string): RecordingProfileDescriptor => {
  const profile = processPlantRecordingProfiles.find(candidate => candidate.id === profileId)
  if (!profile) throw new Error(`unknown process plant recording profile: ${profileId}`)
  return profile
}

export const createProcessPlantRecordingPlan = (config: {
  readonly selection: ScenarioRecordingSelection
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  /** Each Plant's object label, which names its unit in every series title. */
  readonly unitLabels: ReadonlyMap<string, string>
}): ProcessPlantRecordingPlan => {
  const profile = recordingProfileFor(config.selection.profileId)
  const intervalMs = config.selection.intervalMs ?? profile.defaultIntervalMs
  if (intervalMs < profile.minimumIntervalMs) {
    throw new Error(`process plant recording profile ${profile.id} requires an interval of at least ${profile.minimumIntervalMs} ms`)
  }
  const unitLabelOf = (plant: ProcessPlantRuntimeInstance): string => {
    const label = config.unitLabels.get(plant.plant.id)
    if (label === undefined) throw new Error(`process plant ${plant.plant.id} has no object label to title its recorded series`)
    return label
  }
  const series: ProcessPlantRecordingSeriesPlan[] = [...config.plants.values()].flatMap(plant => {
    const unitLabel = unitLabelOf(plant)
    return recordedPlantVariables(plant.plant, profile.id)
      .map(variable => ({
        plant,
        handle: plant.runtime.resolveVariableHandle(variable.path),
        descriptor: {
          id: recordingSeriesIdFor(plant.plant.id, variable.path),
          subjectId: plant.plant.id,
          signalId: variable.path,
          title: recordingSeriesTitle(plant.plant, unitLabel, variable.path),
          valueType: variable.descriptor.quantity === 'boolean' ? 'boolean' as const : 'number' as const,
          quantity: variable.descriptor.quantity,
          unit: variable.descriptor.unit,
        },
      }))
  })
  const descriptors = series.map(item => item.descriptor)
  const lastRecorded = new Map<string, { value: number | boolean; at: number }>()
  return {
    profile,
    intervalMs,
    descriptors,
    sample: ({ observedAt, simulationTime }) => ({
      descriptors: [],
      samples: series.flatMap(item => {
        const variable = item.plant.runtime.readVariableSnapshotHandle(item.handle)
        const value = variable.value
        const at = Date.parse(simulationTime)
        const previous = lastRecorded.get(item.descriptor.id)
        if (previous && previous.value === value && at >= previous.at && at - previous.at < 60_000) return []
        lastRecorded.set(item.descriptor.id, { value, at })
        return [{
          seriesId: item.descriptor.id,
          observedAt,
          simulationTime,
          elapsedMs: item.plant.runtime.elapsedMs(),
          value,
          quality: processPlantSignalQuality(variable).status === 'outside-hard-range' ? 'bad' as const : 'good' as const,
        }]
      }),
    }),
  }
}
