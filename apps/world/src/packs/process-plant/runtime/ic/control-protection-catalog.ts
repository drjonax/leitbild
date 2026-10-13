import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { processPlantSignalView, resolveProcessPlantSignalBinding } from '../../signals.ts'
import type { ProcessPlantSignalReference, ProcessPlantSignalView } from '../../signals.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcEffect, ProcessPlantIcOperatingMode, ProcessPlantIcRule } from './control-protection-model.ts'

/**
 * A signal as the I&C catalog names it. Its full view (span, limits,
 * capabilities, owner) is the signal's own and comes from signals.resolve or
 * signals.read: repeated in every rule that watches it, it was 58 % of the
 * reference PWR's 494 KB catalog.
 */
export interface ProcessPlantIcCatalogSignal {
  readonly path: ProcessPlantSignalView['path']
  readonly tagId?: ProcessPlantSignalView['tagId']
  readonly label: string
  readonly unit: ProcessPlantSignalView['unit']
}

export interface ProcessPlantIcEffectCatalogEntry {
  readonly id: string
  readonly type: ProcessPlantIcEffect['type']
  readonly title?: string
  readonly severity?: string
  readonly signal?: ProcessPlantIcCatalogSignal
  readonly value?: number | boolean
  readonly annunciator?: unknown
}

export interface ProcessPlantIcCommandGateCatalogEntry {
  readonly signal: ProcessPlantIcCatalogSignal
  readonly message?: string
}

export interface ProcessPlantIcRuleCatalogEntry {
  readonly id: string
  readonly label?: string
  readonly enabled: boolean
  readonly ruleClass: ProcessPlantIcRule['ruleClass']
  /** The operating modes it acts in, as declared ("Power operation"); absent, it acts in every mode. */
  readonly modes?: ReadonlyArray<string>
  readonly watchedSignals: ReadonlyArray<ProcessPlantIcCatalogSignal>
  readonly effects: ReadonlyArray<ProcessPlantIcEffectCatalogEntry>
  readonly commandGates: ReadonlyArray<ProcessPlantIcCommandGateCatalogEntry>
}

export interface ProcessPlantIcCatalog {
  readonly plantId: string
  readonly ruleCount: number
  readonly rules: ReadonlyArray<ProcessPlantIcRuleCatalogEntry>
}

const collectConditionSignals = (
  condition: ProcessPlantIcCondition,
  into: ProcessPlantSignalReference[],
): void => {
  if (condition.type === 'comparison') {
    into.push(condition.signal)
    return
  }
  if (condition.type === 'not') {
    collectConditionSignals(condition.condition, into)
    return
  }
  for (const child of condition.conditions) collectConditionSignals(child, into)
}

const catalogSignal = (system: CompiledProcessPlant, reference: ProcessPlantSignalReference): ProcessPlantIcCatalogSignal => {
  const { path, tagId, label, unit } = processPlantSignalView(resolveProcessPlantSignalBinding(system.graph, reference))
  return { path, ...(tagId === undefined ? {} : { tagId }), label, unit }
}

const uniqueSignals = (
  system: CompiledProcessPlant,
  references: ReadonlyArray<ProcessPlantSignalReference>,
): ReadonlyArray<ProcessPlantIcCatalogSignal> => {
  const byPath = new Map<string, ProcessPlantIcCatalogSignal>()
  for (const reference of references) {
    const signal = catalogSignal(system, reference)
    byPath.set(String(signal.path), signal)
  }
  return [...byPath.values()]
}

const effectCatalogEntry = (
  system: CompiledProcessPlant,
  effect: ProcessPlantIcEffect,
): ProcessPlantIcEffectCatalogEntry => {
  if (effect.type === 'writeSignal') {
    return {
      id: effect.id,
      type: effect.type,
      signal: catalogSignal(system, effect.signal),
      value: effect.value,
    }
  }
  return {
    id: effect.id,
    type: effect.type,
    title: effect.title,
    ...(effect.severity === undefined ? {} : { severity: effect.severity }),
    ...(effect.annunciator === undefined ? {} : { annunciator: effect.annunciator }),
  }
}

export const catalogForProcessPlantIcRules = (
  system: CompiledProcessPlant,
  rules: ReadonlyArray<ProcessPlantIcRule>,
  operatingModes: ReadonlyArray<ProcessPlantIcOperatingMode>,
): ProcessPlantIcCatalog => ({
  plantId: system.id,
  ruleCount: rules.length,
  rules: rules.map(rule => {
    const modes = (rule.modes ?? []).map(id => operatingModes.find(mode => mode.id === id)!)
    const watchedSignals: ProcessPlantSignalReference[] = []
    collectConditionSignals(rule.condition, watchedSignals)
    // A rule watches what decides the Plant's mode: every mode declared before its own can take precedence.
    if (modes.length > 0) for (const mode of operatingModes.slice(0, Math.max(...modes.map(mode => operatingModes.indexOf(mode))) + 1)) collectConditionSignals(mode.condition, watchedSignals)
    if (rule.clearCondition !== undefined) collectConditionSignals(rule.clearCondition, watchedSignals)
    if (rule.resetCondition !== undefined) collectConditionSignals(rule.resetCondition, watchedSignals)
    for (const effect of rule.effects) {
      if (effect.type === 'writeSignal') watchedSignals.push(effect.signal)
    }
    for (const gate of rule.commandGates) watchedSignals.push(gate.signal)
    return {
      id: rule.id,
      ...(rule.label === undefined ? {} : { label: rule.label }),
      enabled: rule.enabled,
      ruleClass: rule.ruleClass,
      ...(modes.length === 0 ? {} : { modes: modes.map(mode => mode.label) }),
      watchedSignals: uniqueSignals(system, watchedSignals),
      effects: rule.effects.map(effect => effectCatalogEntry(system, effect)),
      commandGates: rule.commandGates.map(gate => ({
        signal: catalogSignal(system, gate.signal),
        ...(gate.message === undefined ? {} : { message: gate.message }),
      })),
    }
  }),
})
