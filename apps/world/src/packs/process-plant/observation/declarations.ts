import { recordingSeriesIdFor, type ObjectId } from '../../../core/model/index.ts'
import type { ObservationDeclaration } from '../../../core/observation/capabilities.ts'
import type { Observable } from '../../../core/observation/model.ts'
import type { CompiledComponent, ProcessSignalBinding, ProcessUnit } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { plantAlarmPriority } from '../ic/alarm-philosophy.ts'
import { isDemand, readsAsMeasured } from '../ic/key-values.ts'
import { icThresholdsForSignal, type ComposedDisplayThreshold } from '../ic/thresholds.ts'
import { derivedObservables } from './derived.ts'

// What a Plant declares to World's observation layer (plan v3.1 §2.2, A1):
// every signal it publishes and every signal the Run records, addressed
// `<plant object id>#<variable path>` (the Historian's signal id), with the
// I&C tag beside it, the equipment it is measured on, its limits projected
// from the I&C rules (ic/thresholds.ts, the one reading of them) and its
// recorded series. Labels are the unit's own: World writes "<object label> ·
// <label>" (R25).

/** What the Run records of a Plant: its series ids and the interval they are sampled at; null where it records none. */
export type PlantRecording = { readonly seriesIds: ReadonlySet<string>; readonly intervalMs: number } | null

/** The one table from the Plant's unit strings to core's unit codes (core/observation/model.ts quantityUnits, R26). */
export const unitCodes: Readonly<Record<ProcessUnit, string>> = {
  boolean: '', amps: 'A', count: '1', cps: 'cps', degC: 'degC', DPM: 'DPM', 'degC/s': 'degC/s', fraction: '1', Hz: 'Hz',
  kg: 'kg', 'kJ/kg': 'kJ/kg', 'kg/s': 'kg/s', kV: 'kV', kW: 'kW', MJ: 'MJ', MPa: 'MPa', 'mSv/h': 'mSv/h', m3: 'm3', MW: 'MW',
  Pa: 'Pa', pcm: 'pcm', percent: '%', ppm: 'ppm', rpm: 'rpm', s: 's', volts_dc: 'V',
}

/** A Plant quantity as World's quantity kind, by what the variable measures (R28: physical kinds, words in labels). */
const quantityOf = (binding: ProcessSignalBinding): Observable['quantity'] => {
  switch (binding.quantity) {
    case 'boolean': return 'state'
    case 'ratio': return binding.measurand === 'level' ? 'level' : binding.measurand === 'load' ? 'loading' : 'fraction'
    case 'power': case 'powerDelta':
      return binding.unit === 'percent' ? 'thermal-fraction' : binding.discipline === 'electrical' ? 'electric-power' : 'thermal-power'
    case 'flowRate': case 'flowRateDelta': return 'flow'
    case 'mass': case 'massDelta': return 'mass'
    case 'pressureDelta': case 'head': return 'pressure-difference'
    case 'temperatureDelta': return 'temperature-difference'
    case 'temperatureRate': return 'temperature-rate'
    case 'countRate': return 'count-rate'
    case 'electricalCurrent': return 'current'
    case 'radiationDoseRate': return 'dose-rate'
    case 'rotationalSpeed': return 'rotational-speed'
    case 'startupRate': return 'log-rate'
    case 'time': return 'duration'
    case 'energyPerMass': return 'specific-energy'
    default: return binding.quantity
  }
}

const nameOf = (component: CompiledComponent): string => component.metadata?.presentation?.shortLabel ?? component.label

/**
 * What crews call a reading (R37): the name its equipment's presentation
 * declares for it (CET, Tavg, reactor power), or a loop's measured
 * temperature where it leaves the heat source (Thot) or the transfer's
 * primary side (Tcold). Words a search finds it by, written into its label;
 * never an alias.
 */
const operatorName = (plant: CompiledProcessPlant, binding: ProcessSignalBinding): string | undefined => {
  const graph = plant.graph
  const local = String(binding.path).slice(String(binding.path).indexOf('.') + 1)
  if (binding.owner.type === 'component') return graph.components[binding.owner.componentIndex]!.metadata?.presentation?.names?.[local]
  if (binding.quantity !== 'temperature' || !binding.published) return undefined
  const link = graph.links[binding.owner.linkIndex]!
  const from = graph.components[link.fromComponentIndex]!
  const circuit = from.ports[String(link.fromPortName)]?.circuit
  return from.semantics.energy.some(role => role.role === 'source' && role.circuit === circuit) ? 'Thot'
    : from.semantics.energy.some(role => role.role === 'transfer' && role.from === circuit) ? 'Tcold' : undefined
}

/** Unique within the unit and at most 80 characters: the signal's label with the equipment it belongs to, or the line's ends, by short name. */
const labelOf = (plant: CompiledProcessPlant, binding: ProcessSignalBinding): string => {
  const graph = plant.graph
  const name = operatorName(plant, binding)
  const reads = name === undefined ? binding.label : `${binding.label} (${name})`
  if (binding.owner.type === 'link') {
    const link = graph.links[binding.owner.linkIndex]!
    return `${reads} · ${nameOf(graph.components[link.fromComponentIndex]!)} → ${nameOf(graph.components[link.toComponentIndex]!)}`
  }
  const component = graph.components[binding.owner.componentIndex]!
  return binding.label.toLowerCase().includes(component.label.toLowerCase()) ? reads : `${reads} · ${nameOf(component)}`
}

/** A bus a diesel generator feeds, directly or through its breaker, is the unit's emergency bus: crews name it so (R37). */
const elementLabel = (plant: CompiledProcessPlant, component: CompiledComponent): string => {
  const graph = plant.graph
  const feeders = (index: number) => (graph.incomingLinksByComponent[index] ?? []).map(link => graph.links[link]!.fromComponentIndex)
  const dieselBacked = component.kind === 'electricalBus' && feeders(component.index)
    .some(feeder => graph.components[feeder]!.kind === 'dieselGenerator' || feeders(feeder).some(source => graph.components[source]!.kind === 'dieselGenerator'))
  return dieselBacked ? `${component.label} (emergency bus)` : component.label
}

/**
 * The equipment a signal is measured on: the component or line that owns it,
 * a declared element, as an alarm's annunciator names it (its subject). A
 * binding's `equipmentId` may name a system instead ("rcs", "afw-system").
 */
export const elementOf = (binding: ProcessSignalBinding): string => String(binding.path).split('.')[0]!

/** Whether the Plant declares the signal: it publishes it, or the Run records it. */
const declares = (plant: CompiledProcessPlant, recording: PlantRecording, binding: ProcessSignalBinding): boolean =>
  binding.published || recording?.seriesIds.has(recordingSeriesIdFor(plant.id, binding.path)) === true

/**
 * A count the I&C only steps through (a diesel's load sequencer, R29) is a
 * program position, not a value nearing limits: each control set point it
 * reaches loads equipment. It is declared an enum whose states name what the
 * I&C does at each step, and carries no ordered limits; nothing is lost, as
 * every step's action is its state's label.
 */
const programSteps = (binding: ProcessSignalBinding, thresholds: ReadonlyArray<ComposedDisplayThreshold>): Observable['states'] | null => {
  const max = binding.limits?.hardRange?.max
  if (binding.quantity !== 'count' || max === undefined || thresholds.length === 0) return null
  if (!thresholds.every(threshold => threshold.kind === 'control' && threshold.operator === '>=' && Number.isInteger(threshold.value))) return null
  return Array.from({ length: max + 1 }, (_, step) => {
    const acting = thresholds.filter(threshold => threshold.value === step)
    return { value: String(step), label: acting.length === 0 ? `step ${step}` : `step ${step} · ${acting.map(threshold => threshold.label).join('; ')}` }
  })
}

const thresholdsOf = (plant: CompiledProcessPlant, thresholds: ReadonlyArray<ComposedDisplayThreshold>): Observable['thresholds'] => {
  const seen = new Map<string, number>()
  return thresholds.map(threshold => {
    const count = (seen.get(threshold.ruleId) ?? 0) + 1
    seen.set(threshold.ruleId, count)
    const rule = plant.automation.rules.find(candidate => candidate.id === threshold.ruleId)!
    const annunciated = rule.effects.find(effect => effect.type === 'alarm.enter' || effect.type === 'trip.enter')
    const when = [threshold.modeNames, ...(threshold.gatedBy ?? []), ...(threshold.delayMs === undefined ? [] : [`after ${Math.round(threshold.delayMs / 60_000)} min`])].filter(Boolean).join('; ')
    return {
      id: count === 1 ? threshold.ruleId : `${threshold.ruleId}#${count}`,
      direction: threshold.direction,
      value: threshold.value,
      order: threshold.order,
      effect: threshold.kind,
      priority: threshold.severity === undefined ? 'notice' : plantAlarmPriority(threshold.severity, annunciated?.annunciator?.priority),
      consequence: threshold.action,
      ...(when === '' ? {} : { when }),
    }
  })
}

/** One declared signal. */
const observableOf = (objectId: ObjectId, plant: CompiledProcessPlant, recording: PlantRecording, binding: ProcessSignalBinding): Observable => {
  const thresholds = icThresholdsForSignal(plant, binding.path).thresholds
  const steps = programSteps(binding, thresholds)
  const seriesId = recordingSeriesIdFor(plant.id, binding.path)
  return {
    ref: `${objectId}#${binding.path}`,
    label: labelOf(plant, binding),
    quantity: quantityOf(binding),
    unit: unitCodes[binding.unit],
    valueType: steps !== null ? 'enum' : binding.quantity === 'boolean' ? 'boolean' : 'number',
    ...(steps === null ? {} : { states: steps }),
    thresholds: steps === null ? thresholdsOf(plant, thresholds) : [],
    basis: isDemand(binding) ? 'command' : readsAsMeasured(binding) && binding.simulatorOnly !== true ? 'instrument' : 'model',
    series: recording !== null && recording.seriesIds.has(seriesId) ? { seriesId, intervalMs: recording.intervalMs } : null,
    ...(binding.tagId === undefined ? {} : { tag: binding.tagId }),
    element: elementOf(binding),
  }
}

const revisions = new WeakMap<ReadonlySet<string>, WeakMap<CompiledProcessPlant, string>>()

/** Changes whenever what is declared does: the Plant's model digest and what the Run records of it (one Run's series set is fixed). */
export const declarationRevision = (plant: CompiledProcessPlant, recording: PlantRecording): string => {
  if (recording === null) return `${plant.modelDigest}:unrecorded`
  const known = revisions.get(recording.seriesIds) ?? new WeakMap<CompiledProcessPlant, string>()
  revisions.set(recording.seriesIds, known)
  const recorded = () => plant.graph.signalBindings.filter(binding => recording.seriesIds.has(recordingSeriesIdFor(plant.id, binding.path))).length
  const revision = known.get(plant) ?? `${plant.modelDigest}:${recording.intervalMs}ms:${recorded()}`
  known.set(plant, revision)
  return revision
}

const declarationCache = new WeakMap<CompiledProcessPlant, Map<string, ObservationDeclaration>>()

/** The Plant's declaration: its equipment and lines as elements, and its observables (its signals, then those derived.ts reads); only those on `elementIds` where named. */
export const plantDeclaration = (objectId: ObjectId, plant: CompiledProcessPlant, recording: PlantRecording, elementIds?: ReadonlyArray<string>): ObservationDeclaration => {
  const revision = declarationRevision(plant, recording)
  const known = declarationCache.get(plant) ?? new Map<string, ObservationDeclaration>()
  declarationCache.set(plant, known)
  const whole = known.get(revision) ?? (() => {
    const graph = plant.graph
    const declaration: ObservationDeclaration = {
      objectId,
      revision,
      observables: [
        ...graph.signalBindings.filter(binding => declares(plant, recording, binding)).map(binding => observableOf(objectId, plant, recording, binding)),
        ...derivedObservables(objectId, plant),
      ],
      elements: [
        ...graph.components.map(component => ({
          id: String(component.id), class: component.metadata?.equipmentClass ?? component.kind, label: elementLabel(plant, component),
          ...(component.metadata?.presentation?.shortLabel === undefined ? {} : { shortLabel: component.metadata.presentation.shortLabel }),
          ...(component.metadata?.loopId === undefined ? {} : { group: component.metadata.loopId }),
        })),
        ...graph.links.map(link => {
          const [from, to] = [graph.components[link.fromComponentIndex]!, graph.components[link.toComponentIndex]!]
          const short = `${nameOf(from)} → ${nameOf(to)}`
          return {
            id: String(link.id), class: link.kind, label: `${from.label} to ${to.label}`, ...(short.length > 24 ? {} : { shortLabel: short }),
            // A loop's own line is in its loop, as its readings group (a loop's hot and cold leg).
            ...(link.metadata?.loopId === undefined ? {} : { group: link.metadata.loopId }),
          }
        }),
      ],
    }
    known.set(revision, declaration)
    return declaration
  })()
  if (elementIds === undefined) return whole
  const named = new Set(elementIds)
  return { ...whole, observables: whole.observables.filter(observable => named.has(observable.element!)), elements: whole.elements.filter(element => named.has(element.id)) }
}

const byRef = new WeakMap<ObservationDeclaration, ReadonlyMap<string, Observable>>()

/** The observable a path of this Plant names, as declared; null for one it does not declare. */
export const declaredObservable = (objectId: ObjectId, plant: CompiledProcessPlant, recording: PlantRecording, path: string): Observable | null => {
  const declaration = plantDeclaration(objectId, plant, recording)
  const index = byRef.get(declaration) ?? new Map(declaration.observables.map(observable => [observable.ref, observable]))
  byRef.set(declaration, index)
  return index.get(`${objectId}#${path}`) ?? null
}
