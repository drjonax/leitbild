import type { CommandOrigin } from '../../../simulation/protocol.ts'
import type { ProcessSignalTagId, ProcessVariableValue, VariablePath } from '../graph/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { isInjectedFault } from '../signals.ts'
import { evaluateProcessPlantIcCondition, processPlantOperatingMode } from '../runtime/index.ts'
import { actuationResets, resetRefusal, type ActuationReset, type ResetContext } from './actuation-reset.ts'
import { actuationHold, throttledUnder, validateOperatorWrite } from './command-guard.ts'
import { itemCarrier, offVerb, operationConsequence, type ConsequenceContext, type OperationConsequence } from './consequence.ts'
import { optionStanding, ruleStatesFrom, type OptionStanding, type StandingContext } from './control-standing.ts'
import { offeredOption, plantControlsFor, type ControlOption, type ControlRule, type ItemControls, type OfferedControl, type WithheldControl } from './controls.ts'
import { pushbuttonProtection, type PushbuttonProtection } from './pushbutton-protection.ts'
import type { ProposalPorts } from './proposals.ts'

// The controls and proposals of one running Plant, read against its live
// state: what controls.list, control.proposals and the propose and decide
// commands share.

/** The Plant now, as an operation's consequence reads it: its values, its mode, and which rules stand. */
const consequenceContextFor = (instance: ProcessPlantRuntimeInstance): ConsequenceContext => {
  const states = new Map((instance.protection?.snapshot().rules ?? []).map(state => [state.ruleId, state]))
  return {
    read: path => instance.runtime.readVariable(path),
    mode: processPlantOperatingMode({ system: instance.plant, runtime: instance.runtime, modes: instance.plant.automation.operatingModes }),
    standing: rule => {
      const state = states.get(rule.id)
      return state !== undefined && (state.active || (rule.latch && state.latched))
    },
  }
}

/** What an option takes away now: an off option of a control that commands an aspect (stop, shut, disconnect); null for any other. */
const optionConsequence = (instance: ProcessPlantRuntimeInstance, entry: ItemControls, control: OfferedControl, option: ControlOption, context: ConsequenceContext): OperationConsequence | null => {
  if (control.aspect === undefined || control.form === 'pushbutton' || option.direction !== 'off') return null
  const carrier = itemCarrier(instance.plant, entry.item)
  return carrier === null ? null : operationConsequence(instance.plant, entry.item, offVerb(control, carrier), context, option.consequences)
}

/** What a demand control's setting below where it stands takes away now: the flow it throttles. */
const throttleConsequence = (instance: ProcessPlantRuntimeInstance, entry: ItemControls, context: ConsequenceContext): OperationConsequence | null =>
  operationConsequence(instance.plant, entry.item, 'throttles', context)

/** What a write takes away on the item that offers it: its off option's, or a throttle's below where the equipment stands. */
const writeConsequence = (instance: ProcessPlantRuntimeInstance, item: string, path: VariablePath, value: ProcessVariableValue): OperationConsequence | null => {
  const entry = plantControlsFor(instance.plant).items.find(candidate => candidate.id === item)!
  const control = entry.offered.find(candidate => candidate.path === path)!
  const context = consequenceContextFor(instance)
  const option = control.options.find(candidate => candidate.value === value)
  if (option !== undefined) return optionConsequence(instance, entry, control, option, context)
  if (control.demand === undefined || control.state === undefined || typeof value !== 'number') return null
  const position = instance.runtime.readVariable(control.state)
  return typeof position === 'number' && value < position ? throttleConsequence(instance, entry, context) : null
}

/** The Plant now, as an actuation's reset is judged against it. */
export const resetContextFor = (instance: ProcessPlantRuntimeInstance): ResetContext => ({
  holds: condition => evaluateProcessPlantIcCondition({ system: instance.plant, runtime: instance.runtime, condition }).matches,
  elapsedMs: instance.runtime.elapsedMs(),
})

/** A standing latched actuation's RESET as controls.list gives it, with the drawn items whose controls it holds, where a person finds it. */
export interface ListedReset extends ActuationReset {
  readonly items: ReadonlyArray<string>
}

/** Every standing latched actuation of the Plant with its RESET, offered or why not. */
export const listedResetsFor = (instance: ProcessPlantRuntimeInstance): ReadonlyArray<ListedReset> => {
  if (instance.protection === undefined) return []
  const controls = plantControlsFor(instance.plant)
  return actuationResets(instance.plant, instance.protection.snapshot(), resetContextFor(instance)).map(reset => ({
    ...reset,
    items: controls.items
      .filter(entry => [...entry.offered.flatMap(control => [control.path, ...(control.isolation === undefined ? [] : [control.isolation])]), ...entry.withheld.map(control => control.path)]
        .some(path => reset.holds.includes(path)))
      .map(entry => entry.id),
  }))
}

/**
 * What a proposal is held to on this Plant, for a command of this origin: a
 * control on offer, the I&C's validation with the origin's guards (S1,
 * QA-2), and the readings it publishes; an offered write carries what it
 * takes away now (consequence.ts).
 */
export const proposalPortsFor = (instance: ProcessPlantRuntimeInstance, origin: CommandOrigin | undefined): ProposalPorts => ({
  offered: write => {
    const offered = offeredOption(instance.plant, plantControlsFor(instance.plant), write, path => instance.runtime.readVariable(path))
    if (!offered.ok) return offered
    const consequence = writeConsequence(instance, offered.item, write.path, write.value)
    return { ok: true, item: offered.item, word: offered.word, ...(consequence === null ? {} : { consequence }) }
  },
  validate: write => {
    const validation = validateOperatorWrite({
      system: instance.plant,
      runtime: instance.runtime,
      ...(instance.protection === undefined ? {} : { protection: instance.protection }),
      payload: { plantId: instance.plant.id, path: write.path, value: write.value },
      origin,
    })
    return validation.accepted ? { accepted: true } : { accepted: false, reason: validation.reason }
  },
  reading: (tagId: ProcessSignalTagId) => {
    const binding = instance.plant.graph.signalBindingByTagId.get(tagId)
    if (binding?.published !== true) return { ok: false, reason: `${tagId} is no reading this Plant publishes` }
    // A proposal cites only what a person reads: never an injected fault or the model's truth about one.
    if (isInjectedFault(binding)) return { ok: false, reason: `${tagId} is an injected fault, not a reading: no person or AI agent cites it` }
    return { ok: true, path: binding.path, value: instance.runtime.readVariable(binding.path) }
  },
  // A reset is reviewed on the first drawn item whose controls its actuation holds.
  resettable: ruleId => {
    if (instance.protection === undefined) return { ok: false, reason: `Process Plant ${instance.plant.id} has no I&C to reset` }
    const refusal = resetRefusal(instance.plant, instance.protection.snapshot(), ruleId, resetContextFor(instance))
    if (refusal !== null) return { ok: false, reason: refusal }
    const reset = listedResetsFor(instance).find(candidate => candidate.ruleId === ruleId)!
    const item = reset.items[0]
    if (item === undefined) return { ok: false, reason: `${reset.word} is shown on no drawn item: nothing it holds is drawn` }
    return { ok: true, item, word: reset.word, label: reset.label, holds: reset.holds }
  },
})

/** One offered control as controls.list gives it: the derivation, where each option's rules stand now, and how long it takes to follow. */
export interface ListedControl {
  readonly control: OfferedControl
  /** optionStanding for each option, in option order. */
  readonly standing: ReadonlyArray<OptionStanding>
  /** The longest declared travel of its options; null where none declares one (the state is then awaited, never judged not followed). */
  readonly travelMs: number | null
  /** A demand control's setting now and where the equipment stands, in the command's unit. */
  readonly now?: { readonly demand: number; readonly position: number }
  /**
   * The standing protection actuations its demand is throttled under: they
   * drove it to an end and it is set between ("Throttled under <label>");
   * absent otherwise.
   */
  readonly throttledUnder?: ReadonlyArray<ControlRule>
  /**
   * What each option takes away now, in option order (consequence.ts): the
   * flow an off option stops, shuts off or disconnects, where it goes, its
   * share, the mode and what may actuate; null for an option that takes
   * nothing away (START, OPEN, a pushbutton).
   */
  readonly consequenceLines: ReadonlyArray<OperationConsequence | null>
  /** A demand control's: what a setting below where it stands throttles now. */
  readonly throttleLine?: OperationConsequence
  /**
   * A demand control's, while standing actuations drove it to an end: the
   * rules, and the least it may be throttled to under them with why, or
   * null where only their end is accepted (no floor declared).
   */
  readonly actuationHold?: { readonly rules: ReadonlyArray<ControlRule>; readonly floor: { readonly value: number; readonly basis: string } | null }
  /** A protective pushbutton: whether it trips, actuates or blocks, where its block and the permissive gating it stand now (pushbutton-protection.ts). */
  readonly protection?: PushbuttonProtection
}

export interface ListedItem {
  readonly id: string
  readonly label: string
  /** Where a valve stands now: the value its popover shows (ItemControls.position). */
  readonly position?: { readonly path: VariablePath; readonly value: number }
  readonly offered: ReadonlyArray<ListedControl>
  readonly withheld: ReadonlyArray<WithheldControl>
}

/** The Plant's drawn items with their controls where they stand now; only the named items where ids are given, in the derivation's order. */
export const listedControlsFor = (instance: ProcessPlantRuntimeInstance, itemIds?: ReadonlyArray<string>): ReadonlyArray<ListedItem> => {
  const controls = plantControlsFor(instance.plant)
  const snapshot = instance.protection?.snapshot()
  const numberAt = (path: VariablePath): number => {
    const value = instance.runtime.readVariable(path)
    if (typeof value !== 'number') throw new Error(`${path} reads no number`)
    return value
  }
  const consequences = consequenceContextFor(instance)
  const context: StandingContext = {
    read: path => instance.runtime.readVariable(path),
    mode: consequences.mode?.id ?? null,
    rules: snapshot === undefined ? new Map() : ruleStatesFrom(snapshot),
  }
  return controls.items
    .filter(entry => itemIds === undefined || itemIds.includes(entry.id))
    .map(entry => ({
      id: entry.id,
      label: entry.label,
      ...(entry.position === undefined ? {} : { position: { path: entry.position, value: numberAt(entry.position) } }),
      offered: entry.offered.map(control => {
        const travel = control.options.flatMap(option => option.travelMs === null ? [] : [option.travelMs])
        const demand = control.demand === undefined ? undefined : numberAt(control.path)
        const under = demand === undefined || snapshot === undefined ? [] : throttledUnder(instance.plant, snapshot, { path: control.path, value: demand })
        const hold = demand === undefined || snapshot === undefined ? null : actuationHold(instance.plant, snapshot, control.path)
        const throttle = demand === undefined ? null : throttleConsequence(instance, entry, consequences)
        const protection = pushbuttonProtection(instance.plant, control, {
          read: path => instance.runtime.readVariable(path),
          holds: condition => evaluateProcessPlantIcCondition({ system: instance.plant, runtime: instance.runtime, condition }).matches,
        })
        return {
          control,
          standing: control.options.map(option => optionStanding(instance.plant, control, option, context)),
          travelMs: travel.length === 0 ? null : Math.max(...travel),
          ...(demand === undefined || control.state === undefined ? {} : { now: { demand, position: numberAt(control.state) } }),
          ...(under.length === 0 ? {} : { throttledUnder: under }),
          consequenceLines: control.options.map(option => optionConsequence(instance, entry, control, option, consequences)),
          ...(throttle === null ? {} : { throttleLine: throttle }),
          ...(hold === null ? {} : { actuationHold: hold }),
          ...(protection === undefined ? {} : { protection }),
        }
      }),
      withheld: entry.withheld,
    }))
}
