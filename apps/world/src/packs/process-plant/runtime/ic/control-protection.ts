import type { SimulationRunId } from '../../../../core/model/index.ts'
import type { PackRuntimeEvent } from '../../../../simulation/protocol.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import type { ProcessPlantSignalReference } from '../../signals.ts'
import type { ProcessPlantRuntime } from '../model.ts'
import { evaluateProcessPlantIcCondition } from './control-protection-conditions.ts'
import { assertProcessPlantIcOperatingModesValid, assertProcessPlantIcRulesValid } from './control-protection-validation.ts'
import { applyProcessPlantIcWriteEffect, processPlantIcWriteTargetPath } from './control-protection-effects.ts'
import { rememberProcessPlantIcLifecycleHistory, updateProcessPlantIcLifecyclePhase } from './control-protection-history.ts'
import {
  catalogForProcessPlantIcRules,
  type ProcessPlantIcCatalog,
  type ProcessPlantIcRuleCatalogEntry,
  type ProcessPlantIcEffectCatalogEntry,
  type ProcessPlantIcCommandGateCatalogEntry,
} from './control-protection-catalog.ts'
import {
  processPlantIcConfigSchema,
  processPlantIcRuleSchema,
  type ProcessPlantIcCondition,
  type ProcessPlantIcConfig,
  type ProcessPlantIcEffect,
  type ProcessPlantIcFailure,
  type ProcessPlantIcLifecycleHistoryEntry,
  type ProcessPlantIcLifecycleAction,
  type ProcessPlantIcOperatingMode,
  type ProcessPlantIcRule,
  type ProcessPlantIcSnapshot,
} from './control-protection-model.ts'
import {
  eventForProcessPlantIcLifecycleTransition,
  mutableLifecycleFor,
  processPlantIcLifecycleIdFor,
  type MutableLifecycleState,
} from './control-protection-lifecycle.ts'
import {
  assertRestoredProcessPlantIcSnapshotMatchesRules,
  processPlantIcFailureFor,
  stateForProcessPlantIcRule,
} from './control-protection-rule-state.ts'
export * from './control-protection-model.ts'
export * from './control-protection-conditions.ts'
export { assertProcessPlantIcRulesValid } from './control-protection-validation.ts'
export type {
  ProcessPlantIcCatalog,
  ProcessPlantIcRuleCatalogEntry,
  ProcessPlantIcEffectCatalogEntry,
  ProcessPlantIcCommandGateCatalogEntry,
} from './control-protection-catalog.ts'

export interface ProcessPlantProtectionRunner {
  readonly evaluate: (config: {
    readonly runtime: ProcessPlantRuntime
    readonly elapsedMs: number
    readonly simulationRunId: SimulationRunId
    readonly sourceRuntimeId: string
  }) => ReadonlyArray<PackRuntimeEvent>
  readonly snapshot: () => ProcessPlantIcSnapshot
  readonly catalog: () => ProcessPlantIcCatalog
  readonly applyLifecycleAction: (config: {
    readonly id: string
    readonly action: ProcessPlantIcLifecycleAction
    readonly elapsedMs: number
    readonly simulationRunId: SimulationRunId
    readonly sourceRuntimeId: string
    readonly actorId?: string
    readonly clientId?: string
    readonly reason?: string
    readonly shelveDurationMs?: number
  }) => ReadonlyArray<PackRuntimeEvent>
  readonly evaluateWrite: (config: {
    readonly runtime: ProcessPlantRuntime
    readonly signal: ProcessPlantSignalReference
    readonly elapsedMs: number
  }) => { readonly ok: true } | { readonly ok: false; readonly reason: string }
}

const shouldResetLatchedState = (config: {
  readonly system: CompiledProcessPlant
  readonly runtime: ProcessPlantRuntime
  readonly rule: ProcessPlantIcRule
}): boolean => {
  if (config.rule.resetCondition === undefined) return false
  return evaluateProcessPlantIcCondition({
    system: config.system,
    runtime: config.runtime,
    condition: config.rule.resetCondition as ProcessPlantIcCondition,
  }).matches
}

const firstOutGroupFor = (lifecycle: MutableLifecycleState): string | undefined =>
  lifecycle.annunciator?.firstOutGroup

const assignFirstOut = (
  lifecycle: MutableLifecycleState,
  lifecycles: ReadonlyMap<string, MutableLifecycleState>,
  elapsedMs: number,
): void => {
  const group = firstOutGroupFor(lifecycle)
  if (group === undefined) return
  const activeInGroup = [...lifecycles.values()].filter(candidate =>
    candidate.id !== lifecycle.id
    && firstOutGroupFor(candidate) === group
    && (candidate.active || candidate.latched || candidate.resettable),
  )
  lifecycle.firstOutRank = activeInGroup.length + 1
  lifecycle.firstOut = activeInGroup.length === 0
  lifecycle.firstOutElapsedMs = elapsedMs
}

/**
 * The Plant's operating mode: the first declared mode whose condition holds;
 * null where it declares none, or none holds.
 */
export const processPlantOperatingMode = (config: {
  readonly system: CompiledProcessPlant
  readonly runtime: ProcessPlantRuntime
  readonly modes: ReadonlyArray<ProcessPlantIcOperatingMode>
}): ProcessPlantIcOperatingMode | null =>
  config.modes.find(mode => evaluateProcessPlantIcCondition({ system: config.system, runtime: config.runtime, condition: mode.condition }).matches) ?? null

// A rule qualified by modes acts only while the Plant is in one of them.
const inRuleModes = (rule: ProcessPlantIcRule, mode: () => string | null): boolean => {
  if (rule.modes === undefined) return true
  const current = mode()
  return current !== null && rule.modes.includes(current)
}

const evaluateRuleCondition = (config: {
  readonly system: CompiledProcessPlant
  readonly runtime: ProcessPlantRuntime
  readonly rule: ProcessPlantIcRule
  readonly mode: () => string | null
}): boolean => {
  if (!inRuleModes(config.rule, config.mode)) return false
  return evaluateProcessPlantIcCondition({
    system: config.system,
    runtime: config.runtime,
    condition: config.rule.condition,
  }).matches
}

// An alarm qualified by a mode clears when the Plant leaves the mode: outside
// it the alarm no longer applies, whatever its own clear condition reads.
const evaluateAlarmClearCondition = (config: {
  readonly system: CompiledProcessPlant
  readonly runtime: ProcessPlantRuntime
  readonly rule: ProcessPlantIcRule
  readonly setConditionMatches: boolean
  readonly mode: () => string | null
}): boolean => {
  if (config.rule.clearCondition === undefined) return !config.setConditionMatches
  if (!inRuleModes(config.rule, config.mode)) return true
  return evaluateProcessPlantIcCondition({
    system: config.system,
    runtime: config.runtime,
    condition: config.rule.clearCondition,
  }).matches
}

export const createProcessPlantProtectionRunner = (config: {
  readonly system: CompiledProcessPlant
  readonly protection: ProcessPlantIcConfig
  readonly restoredSnapshot?: ProcessPlantIcSnapshot
}): ProcessPlantProtectionRunner => {
  const protection = processPlantIcConfigSchema.parse(config.protection)
  const rules = protection.rules.map(rule => processPlantIcRuleSchema.parse(rule))
  assertProcessPlantIcOperatingModesValid(config.system.graph, protection.operatingModes)
  assertProcessPlantIcRulesValid(config.system, rules)
  const ruleIds = new Set<string>()
  const effectIds = new Set<string>()
  for (const rule of rules) {
    if (ruleIds.has(rule.id)) throw new Error(`duplicate process plant I&C rule id: ${rule.id}`)
    ruleIds.add(rule.id)
    for (const effect of rule.effects) {
      const scopedEffectId = `${rule.id}:${effect.id}`
      if (effectIds.has(scopedEffectId)) throw new Error(`duplicate process plant I&C effect id for rule ${rule.id}: ${effect.id}`)
      effectIds.add(scopedEffectId)
    }
  }
  assertRestoredProcessPlantIcSnapshotMatchesRules(rules, config.restoredSnapshot)

  const restoredRules = new Map((config.restoredSnapshot?.rules ?? []).map(rule => [rule.ruleId, rule]))
  const restoredLifecycles = new Map([
    ...(config.restoredSnapshot?.alarms ?? []),
    ...(config.restoredSnapshot?.trips ?? []),
  ].map(lifecycle => [lifecycle.id, lifecycle]))
  const states = new Map(rules.map(rule => [rule.id, stateForProcessPlantIcRule(rule.id, restoredRules)]))
  const lifecycles = new Map<string, MutableLifecycleState>()
  for (const rule of rules) {
    for (const effect of rule.effects) {
      if (effect.type === 'writeSignal') continue
      const lifecycle = mutableLifecycleFor(effect, rule, restoredLifecycles)
      lifecycles.set(lifecycle.id, lifecycle)
    }
  }
  const failures: ProcessPlantIcFailure[] = [...(config.restoredSnapshot?.failures ?? [])]
  const history: ProcessPlantIcLifecycleHistoryEntry[] = [...(config.restoredSnapshot?.history ?? [])]

  const evaluateWriteAgainstGates = (input: {
    readonly runtime: ProcessPlantRuntime
    readonly signal: ProcessPlantSignalReference
    readonly elapsedMs: number
  }): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
    const targetPath = processPlantIcWriteTargetPath({ system: config.system, signal: input.signal })
    for (const rule of rules) {
      if (!rule.enabled || (rule.ruleClass !== 'permissive' && rule.ruleClass !== 'interlock')) continue
      const applies = rule.commandGates.some(gate =>
        processPlantIcWriteTargetPath({ system: config.system, signal: gate.signal }) === targetPath,
      )
      if (!applies) continue
      try {
        const matches = evaluateProcessPlantIcCondition({ system: config.system, runtime: input.runtime, condition: rule.condition }).matches
        const blocked = rule.ruleClass === 'permissive' ? !matches : matches
        if (!blocked) continue
        const message = rule.commandGates.find(gate =>
          processPlantIcWriteTargetPath({ system: config.system, signal: gate.signal }) === targetPath,
        )?.message
        return {
          ok: false,
          reason: message ?? `process plant I&C ${rule.ruleClass} rule ${rule.id} blocks write to ${targetPath}`,
        }
      } catch (error) {
        failures.push(processPlantIcFailureFor({ ruleId: rule.id, elapsedMs: input.elapsedMs, error }))
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    }
    return { ok: true }
  }

  const enterLifecycle = (input: {
    readonly rule: ProcessPlantIcRule
    readonly effect: Extract<ProcessPlantIcEffect, { readonly type: 'alarm.enter' | 'trip.enter' }>
    readonly elapsedMs: number
    readonly simulationRunId: SimulationRunId
    readonly sourceRuntimeId: string
  }): ReadonlyArray<PackRuntimeEvent> => {
    const kind = input.effect.type === 'alarm.enter' ? 'alarm' : 'trip'
    const lifecycle = lifecycles.get(processPlantIcLifecycleIdFor(kind, input.rule.id, input.effect.id))
    if (!lifecycle) throw new Error(`process plant I&C lifecycle state missing for effect: ${input.rule.id}/${input.effect.id}`)
    if (lifecycle.active && lifecycle.latched) return []
    if (lifecycle.active) return []
    lifecycle.active = true
    lifecycle.acknowledged = false
    lifecycle.latched = input.rule.latch
    lifecycle.resettable = false
    lifecycle.firstActiveElapsedMs ??= input.elapsedMs
    lifecycle.lastActiveElapsedMs = input.elapsedMs
    lifecycle.lastTransitionElapsedMs = input.elapsedMs
    lifecycle.transitionCount += 1
    lifecycle.occurrenceCount += 1
    assignFirstOut(lifecycle, lifecycles, input.elapsedMs)
    updateProcessPlantIcLifecyclePhase(lifecycle)
    rememberProcessPlantIcLifecycleHistory({
      history,
      lifecycle,
      transition: 'entered',
      elapsedMs: input.elapsedMs,
    })
    if (lifecycle.firstOut) {
      rememberProcessPlantIcLifecycleHistory({
        history,
        lifecycle,
        transition: 'firstOut',
        elapsedMs: input.elapsedMs,
      })
    }
    if (lifecycle.suppressed || lifecycle.shelved) return []
    return [eventForProcessPlantIcLifecycleTransition({
      simulationRunId: input.simulationRunId,
      sourceRuntimeId: input.sourceRuntimeId,
      plantId: config.system.id,
      rule: input.rule,
      lifecycle,
      transition: 'entered',
      elapsedMs: input.elapsedMs,
    })]
  }

  const expireShelvedLifecycles = (input: {
    readonly elapsedMs: number
    readonly simulationRunId: SimulationRunId
    readonly sourceRuntimeId: string
  }): ReadonlyArray<PackRuntimeEvent> => {
    const events: PackRuntimeEvent[] = []
    for (const lifecycle of lifecycles.values()) {
      if (!lifecycle.shelved || lifecycle.shelvedUntilElapsedMs === undefined || lifecycle.shelvedUntilElapsedMs > input.elapsedMs) continue
      const rule = rules.find(candidate => candidate.id === lifecycle.ruleId)
      if (!rule) throw new Error(`process plant I&C rule missing for lifecycle: ${lifecycle.ruleId}`)
      lifecycle.shelved = false
      delete lifecycle.shelvedUntilElapsedMs
      lifecycle.lastTransitionElapsedMs = input.elapsedMs
      lifecycle.transitionCount += 1
      updateProcessPlantIcLifecyclePhase(lifecycle)
      rememberProcessPlantIcLifecycleHistory({
        history,
        lifecycle,
        transition: 'shelveExpired',
        elapsedMs: input.elapsedMs,
      })
      events.push(eventForProcessPlantIcLifecycleTransition({
        simulationRunId: input.simulationRunId,
        sourceRuntimeId: input.sourceRuntimeId,
        plantId: config.system.id,
        rule,
        lifecycle,
        transition: 'shelveExpired',
        elapsedMs: input.elapsedMs,
      }))
    }
    return events
  }

  const clearLifecycle = (input: {
    readonly rule: ProcessPlantIcRule
    readonly elapsedMs: number
    readonly simulationRunId: SimulationRunId
    readonly sourceRuntimeId: string
  }): ReadonlyArray<PackRuntimeEvent> => {
    const events: PackRuntimeEvent[] = []
    for (const effect of input.rule.effects) {
      if (effect.type === 'writeSignal') continue
      const kind = effect.type === 'alarm.enter' ? 'alarm' : 'trip'
      const lifecycle = lifecycles.get(processPlantIcLifecycleIdFor(kind, input.rule.id, effect.id))
      if (!lifecycle || !lifecycle.active) continue
      if (lifecycle.latched && !input.rule.resetWhenClear) {
        lifecycle.resettable = true
        continue
      }
      lifecycle.active = false
      lifecycle.resettable = false
      lifecycle.firstOut = false
      delete lifecycle.firstOutRank
      lifecycle.lastClearedElapsedMs = input.elapsedMs
      lifecycle.lastTransitionElapsedMs = input.elapsedMs
      lifecycle.transitionCount += 1
      lifecycle.clearCount += 1
      updateProcessPlantIcLifecyclePhase(lifecycle)
      rememberProcessPlantIcLifecycleHistory({
        history,
        lifecycle,
        transition: 'cleared',
        elapsedMs: input.elapsedMs,
      })
      events.push(eventForProcessPlantIcLifecycleTransition({
        simulationRunId: input.simulationRunId,
        sourceRuntimeId: input.sourceRuntimeId,
        plantId: config.system.id,
        rule: input.rule,
        lifecycle,
        transition: 'cleared',
        elapsedMs: input.elapsedMs,
      }))
    }
    return events
  }

  return {
    evaluate: ({ runtime, elapsedMs, simulationRunId, sourceRuntimeId }): ReadonlyArray<PackRuntimeEvent> => {
      const events: PackRuntimeEvent[] = [
        ...expireShelvedLifecycles({ elapsedMs, simulationRunId, sourceRuntimeId }),
      ]
      // The operating mode is read once per pass, when a rule first needs it.
      let current: { readonly id: string | null } | undefined
      const mode = (): string | null => (current ??= { id: processPlantOperatingMode({ system: config.system, runtime, modes: protection.operatingModes })?.id ?? null }).id
      for (const rule of rules) {
        const state = states.get(rule.id)
        if (!state) throw new Error(`process plant I&C state missing for rule: ${rule.id}`)
        if (!rule.enabled) continue
        let matches = false
        try {
          matches = evaluateRuleCondition({ system: config.system, runtime, rule, mode })
        } catch (error) {
          failures.push(processPlantIcFailureFor({ ruleId: rule.id, elapsedMs, error }))
          continue
        }
        if (shouldResetLatchedState({ system: config.system, runtime, rule })) {
          state.latched = false
          for (const lifecycle of lifecycles.values()) {
            if (lifecycle.ruleId !== rule.id || !lifecycle.latched) continue
            lifecycle.latched = false
            lifecycle.resettable = false
            if (!matches) lifecycle.active = false
          }
        }
        if (rule.ruleClass === 'alarm') {
          if (state.active) {
            const clearMatches = evaluateAlarmClearCondition({
              system: config.system,
              runtime,
              rule,
              setConditionMatches: matches,
              mode,
            })
            if (!clearMatches) {
              delete state.clearSinceElapsedMs
              continue
            }
            state.clearSinceElapsedMs ??= elapsedMs
            const clearDelaySatisfied = elapsedMs - state.clearSinceElapsedMs >= rule.clearDelayMs
            if (!clearDelaySatisfied) continue
            delete state.activeSinceElapsedMs
            delete state.clearSinceElapsedMs
            state.active = false
            state.lastTransitionElapsedMs = elapsedMs
            if (rule.resetWhenClear) state.latched = false
            events.push(...clearLifecycle({ rule, elapsedMs, simulationRunId, sourceRuntimeId }))
            continue
          }
          if (!matches) {
            delete state.activeSinceElapsedMs
            delete state.clearSinceElapsedMs
            continue
          }
        } else {
          if (!matches) {
            delete state.activeSinceElapsedMs
            delete state.clearSinceElapsedMs
            if (state.active) {
              state.active = false
              state.lastTransitionElapsedMs = elapsedMs
            }
            if (rule.resetWhenClear) state.latched = false
            events.push(...clearLifecycle({ rule, elapsedMs, simulationRunId, sourceRuntimeId }))
            continue
          }
        }
        if (matches && state.activeSinceElapsedMs === undefined) state.activeSinceElapsedMs = elapsedMs
        const delaySatisfied = state.activeSinceElapsedMs !== undefined && elapsedMs - state.activeSinceElapsedMs >= rule.delayMs
        if (!delaySatisfied || state.active || (rule.latch && state.latched)) continue
        for (const effect of rule.effects) {
          try {
            if (effect.type === 'writeSignal') {
              applyProcessPlantIcWriteEffect({
                system: config.system,
                runtime,
                effect,
                evaluateWrite: signal => evaluateWriteAgainstGates({ runtime, signal, elapsedMs }),
              })
              continue
            }
            events.push(...enterLifecycle({ rule, effect, elapsedMs, simulationRunId, sourceRuntimeId }))
          } catch (error) {
            failures.push(processPlantIcFailureFor({ ruleId: rule.id, effectId: effect.id, elapsedMs, error }))
          }
        }
        state.active = true
        state.latched = rule.latch
        state.lastTransitionElapsedMs = elapsedMs
        state.firedCount += 1
      }
      return events
    },
    snapshot: (): ProcessPlantIcSnapshot => ({
      rules: rules.map(rule => {
        const state = states.get(rule.id)
        if (!state) throw new Error(`process plant I&C state missing for rule: ${rule.id}`)
        return {
          ruleId: rule.id,
          active: state.active,
          latched: state.latched,
          ...(state.activeSinceElapsedMs === undefined ? {} : { activeSinceElapsedMs: state.activeSinceElapsedMs }),
          ...(state.clearSinceElapsedMs === undefined ? {} : { clearSinceElapsedMs: state.clearSinceElapsedMs }),
          ...(state.lastTransitionElapsedMs === undefined ? {} : { lastTransitionElapsedMs: state.lastTransitionElapsedMs }),
          firedCount: state.firedCount,
        }
      }),
      alarms: [...lifecycles.values()].filter(lifecycle => lifecycle.kind === 'alarm'),
      trips: [...lifecycles.values()].filter(lifecycle => lifecycle.kind === 'trip'),
      failures: [...failures],
      history: [...history],
    }),
    catalog: (): ProcessPlantIcCatalog => catalogForProcessPlantIcRules(config.system, rules, protection.operatingModes),
    applyLifecycleAction: input => {
      const lifecycle = lifecycles.get(input.id)
      if (!lifecycle) throw new Error(`unknown process plant I&C lifecycle id: ${input.id}`)
      const rule = rules.find(candidate => candidate.id === lifecycle.ruleId)
      if (!rule) throw new Error(`process plant I&C rule missing for lifecycle: ${lifecycle.ruleId}`)
      const events: PackRuntimeEvent[] = []
      const transition = (() => {
        if (input.action === 'acknowledge') return 'acknowledged'
        if (input.action === 'suppress') return 'suppressed'
        if (input.action === 'unsuppress') return 'unsuppressed'
        if (input.action === 'shelve') return 'shelved'
        if (input.action === 'unshelve') return 'unshelved'
        return 'reset'
      })()
      if (input.action === 'acknowledge') {
        lifecycle.acknowledged = true
        lifecycle.acknowledgeCount += 1
        lifecycle.lastAcknowledgedElapsedMs = input.elapsedMs
      } else if (input.action === 'reset') {
        const state = states.get(lifecycle.ruleId)
        if (!state) throw new Error(`process plant I&C state missing for rule: ${lifecycle.ruleId}`)
        lifecycle.active = false
        lifecycle.latched = false
        lifecycle.resettable = false
        lifecycle.acknowledged = false
        lifecycle.firstOut = false
        delete lifecycle.firstOutRank
        delete lifecycle.firstOutElapsedMs
        lifecycle.lastClearedElapsedMs = input.elapsedMs
        lifecycle.lastResetElapsedMs = input.elapsedMs
        state.active = false
        state.latched = false
        delete state.activeSinceElapsedMs
        delete state.clearSinceElapsedMs
      } else if (input.action === 'suppress') {
        lifecycle.suppressed = true
        lifecycle.lastSuppressedElapsedMs = input.elapsedMs
      } else if (input.action === 'unsuppress') {
        lifecycle.suppressed = false
      } else if (input.action === 'shelve') {
        lifecycle.shelved = true
        lifecycle.acknowledged = true
        lifecycle.acknowledgeCount += 1
        lifecycle.lastShelvedElapsedMs = input.elapsedMs
        lifecycle.lastAcknowledgedElapsedMs = input.elapsedMs
        lifecycle.shelvedUntilElapsedMs = input.shelveDurationMs === undefined
          ? undefined
          : input.elapsedMs + input.shelveDurationMs
      } else {
        lifecycle.shelved = false
        delete lifecycle.shelvedUntilElapsedMs
      }
      lifecycle.lastTransitionElapsedMs = input.elapsedMs
      lifecycle.lastActorId = input.actorId
      if (input.clientId === undefined) delete lifecycle.lastClientId
      else lifecycle.lastClientId = input.clientId
      if (input.reason === undefined) delete lifecycle.lastReason
      else lifecycle.lastReason = input.reason
      lifecycle.transitionCount += 1
      updateProcessPlantIcLifecyclePhase(lifecycle)
      rememberProcessPlantIcLifecycleHistory({
        history,
        lifecycle,
        transition,
        elapsedMs: input.elapsedMs,
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
      events.push(eventForProcessPlantIcLifecycleTransition({
        simulationRunId: input.simulationRunId,
        sourceRuntimeId: input.sourceRuntimeId,
        plantId: config.system.id,
        rule,
        lifecycle,
        transition,
        elapsedMs: input.elapsedMs,
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }))
      return events
    },
    evaluateWrite: evaluateWriteAgainstGates,
  }
}
