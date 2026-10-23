import type { IsoTimestamp, ObjectId, Priority } from '../../../core/model/index.ts'
import type { Observable, Observation } from '../../../core/observation/model.ts'
import type { PackRuntimeRecordedHistory } from '../../../simulation/protocol.ts'
import type { VariablePath } from '../graph/index.ts'
import { annunciating, colours, expectedAfterGroup, pendingActions, plantAlarmPriority, priorityOrder } from '../ic/alarm-philosophy.ts'
import { overviewCandidates, overviewKeyValues, plantNowOf } from '../ic/key-values.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { processPlantSignalQuality } from '../signals.ts'
import { evaluateSafetyFunctions, type SafetyFunctionEvaluation } from '../safety-functions.ts'
import { declaredObservable, qualifiedReadings, type PlantRecording } from './declarations.ts'
import { readDerived } from './derived.ts'

// A Plant's values as World reads them (plan v3.1 §2.2): the value and its
// quality now; its priority, the worst alarm or trip annunciating whose
// condition holds now with a limit on it the value is past (ic/alarm-
// philosophy.ts colours, the rule the alert slot names it by: so a value in
// caution or worse always has its alert, T05, and one only watched as a
// permissive, a gate or a state stays neutral); none where that alarm came in as the expected
// consequence of a first-out (a steam generator's shrink after a reactor
// trip); since when a discrete value holds, from the Run's record; the time
// left where a named delay runs down to one of its limits; the limit it is
// past (`past`). An operated item's state and a safety function's status are
// read in derived.ts. Reads only: nothing here is journalled.

/** How far back a discrete value's last change is looked for in the Run's record. */
const SINCE_WINDOW_MS = 30 * 60_000

export interface PlantReadContext {
  readonly objectId: ObjectId
  readonly system: ProcessPlantRuntimeInstance
  readonly recording: PlantRecording
  /** The Run time the Plant stands at. */
  readonly simulationTime: IsoTimestamp
  readonly history: PackRuntimeRecordedHistory | undefined
}

/** Since when a discrete value holds, as the Run recorded it: the first sample with its value after the last that differs; unknown beyond the window. */
const sinceOf = (context: PlantReadContext, seriesId: string, value: unknown): Observation['since'] => {
  const to = Date.parse(context.simulationTime)
  const samples = context.history?.read({ seriesId, from: new Date(to - SINCE_WINDOW_MS).toISOString() as IsoTimestamp, to: context.simulationTime, limit: 64 }) ?? []
  const changed = samples.findIndex(sample => sample.value !== value)
  const at = changed <= 0 ? undefined : samples[changed - 1]!.simulationTime
  return at === undefined ? undefined : { at, clock: 'simulation' }
}

type Limit = Observable['thresholds'][number]
const limitsByRule = new WeakMap<Observable, ReadonlyMap<string, ReadonlyArray<Limit>>>()

/**
 * A declared observable's limits by the rule that sets each (a limit's id is its rule's id, or that id and `#…`), found
 * once per declaration: a read looks each annunciating rule up on every value it reads.
 */
const limitsOf = (observable: Observable): ReadonlyMap<string, ReadonlyArray<Limit>> => limitsByRule.get(observable) ?? (() => {
  const index = new Map<string, Limit[]>()
  for (const limit of observable.thresholds) {
    const rules = new Set([limit.id, ...[...limit.id].flatMap((character, at) => (character === '#' ? [limit.id.slice(0, at)] : []))])
    for (const rule of rules) index.set(rule, [...index.get(rule) ?? [], limit])
  }
  limitsByRule.set(observable, index)
  return index
})()

/** The Plant's values at these paths; null for a path it does not declare. */
export const readPlant = (context: PlantReadContext, paths: ReadonlyArray<string>): ReadonlyArray<Observation | null> => {
  const { system, recording } = context
  const plant = system.plant
  const snapshot = system.protection?.snapshot()
  const alarms = snapshot === undefined ? [] : annunciating(snapshot)
  const all = snapshot === undefined ? [] : [...snapshot.alarms, ...snapshot.trips]
  const pending = snapshot === undefined ? [] : pendingActions(plant, snapshot, system.runtime.elapsedMs())
  let judged: ReadonlyArray<SafetyFunctionEvaluation> | undefined
  const safetyFunctions = () => judged ??= evaluateSafetyFunctions(plant, system.runtime)
  return paths.map(path => {
    const declared = declaredObservable(context.objectId, plant, recording, path)
    if (declared === null) return null
    const binding = plant.graph.signalBindingByPath.get(path as VariablePath)
    if (binding === undefined) return { ref: declared.ref, ...readDerived(system, path, safetyFunctions), at: context.simulationTime, clock: 'simulation' }
    // A reading the model qualifies measures nothing while its flag is off: no value, not applicable, never a colour.
    const qualified = qualifiedReadings(plant).get(path)
    if (qualified !== undefined && system.runtime.readVariableSnapshot(qualified.flag).value !== true) {
      return { ref: declared.ref, value: null, quality: 'not-applicable', at: context.simulationTime, clock: 'simulation', priority: 'none', why: `measures nothing unless ${qualified.words}` }
    }
    const variable = system.runtime.readVariableSnapshot(binding.path)
    // Only a rule that sets a limit on it can colour it (colours): the rest are not asked.
    const limits = limitsOf(declared)
    const ruled = (ruleId: string): ReadonlyArray<Limit> => limits.get(ruleId) ?? []
    const reading = typeof variable.value === 'number' ? variable.value : null
    const on = snapshot === undefined || limits.size === 0 ? [] : alarms.filter(lifecycle => limits.has(lifecycle.ruleId) && colours(snapshot, lifecycle, ruled(lifecycle.ruleId), reading))
      .map(lifecycle => ({ lifecycle, priority: plantAlarmPriority(lifecycle.severity, lifecycle.annunciator?.priority), after: expectedAfterGroup(plant, lifecycle, all) }))
      .sort((left, right) => priorityOrder[right.priority] - priorityOrder[left.priority])
    const colouring = on.find(entry => entry.after === null)
    const expected = colouring === undefined ? on[0] : undefined
    const priority: Priority = colouring?.priority ?? 'none'
    // The deepest limit an annunciating rule sets on it that the value is past, coloured or expected after a first-out:
    // the chip names the trip past which it stands (LO-LO), as the drawing did, while its colour stays its alarm's.
    const named = on[0]
    const past = named === undefined || reading === null ? undefined : ruled(named.lifecycle.ruleId).find(limit => (limit.direction === 'low' ? reading < limit.value : reading > limit.value))
    const due = pending.filter(entry => limits.has(entry.rule.id)).sort((left, right) => left.leftMs - right.leftMs)[0]
    const value = typeof variable.value === 'number' && !Number.isFinite(variable.value) ? null : declared.valueType === 'enum' ? String(variable.value) : variable.value
    const since = declared.series !== null && declared.valueType !== 'number' ? sinceOf(context, declared.series.seriesId, variable.value) : undefined
    return {
      ref: declared.ref,
      value,
      quality: value === null || processPlantSignalQuality(variable).status === 'outside-hard-range' ? 'bad' : 'good',
      at: context.simulationTime,
      clock: 'simulation',
      priority,
      ...(expected === undefined ? {} : { expected: { after: expected.after!.label } }),
      ...(since === undefined ? {} : { since }),
      ...(past === undefined ? {} : { past: past.id }),
      ...(due === undefined ? {} : { timeToAct: { threshold: due.rule.id, seconds: due.leftMs / 1_000 } }),
      ...(colouring !== undefined ? { why: colouring.lifecycle.title } : expected !== undefined ? { why: `${expected.lifecycle.title}, expected after ${expected.after!.label}` } : {}),
    }
  })
}

/** The values the unit leads with in the mode it is in (ic/key-values.ts), first first: its overview's, then the rest it watches. */
export const leadPaths = (system: ProcessPlantRuntimeInstance, count: number): ReadonlyArray<VariablePath> => {
  const now = plantNowOf(system)
  const first = overviewKeyValues(system.plant, now)
  const { leads, ends } = overviewCandidates(system.plant, now)
  return [...new Set([...first, ...leads, ...ends])].slice(0, count)
}
