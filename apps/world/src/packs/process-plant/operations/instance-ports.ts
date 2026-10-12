import type { CommandOrigin } from '../../../simulation/protocol.ts'
import type { CompiledPlantGraph, ProcessSignalTagId, VariablePath } from '../graph/index.ts'
import { PROCESS_DISPLAY_DETAIL_MAX_COMPONENTS } from '../displays/composition.ts'
import type { MimicItem } from '../displays/mimic/bindings.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { processPlantOperatingMode } from '../runtime/index.ts'
import { throttledUnder, validateOperatorWrite } from './command-guard.ts'
import { optionStanding, ruleStatesFrom, type OptionStanding, type StandingContext } from './control-standing.ts'
import { offeredOption, plantControlsFor, type ControlRule, type OfferedControl, type WithheldControl } from './controls.ts'
import { pushbuttonProtection, type PushbuttonProtection } from './pushbutton-protection.ts'
import { evaluateProcessPlantIcCondition } from '../runtime/ic/control-protection-conditions.ts'
import type { ProposalPorts } from './proposals.ts'

// The controls and proposals of one running Plant, read against its live
// state: what controls.list, control.proposals and the propose and decide
// commands share.

/**
 * What a proposal is held to on this Plant, for a command of this origin: a
 * control on offer, the I&C's validation with the origin's guards (S1,
 * QA-2), and the readings it publishes.
 */
export const proposalPortsFor = (instance: ProcessPlantRuntimeInstance, origin: CommandOrigin | undefined): ProposalPorts => ({
  offered: write => offeredOption(instance.plant, plantControlsFor(instance.plant), write),
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
    return binding?.published === true
      ? { ok: true, path: binding.path, value: instance.runtime.readVariable(binding.path) }
      : { ok: false, reason: `${tagId} is no reading this Plant publishes` }
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
  /** A protective pushbutton: whether it trips, actuates or blocks, where its block and the permissive gating it stand now (pushbutton-protection.ts). */
  readonly protection?: PushbuttonProtection
}

export interface ListedItem {
  readonly id: string
  readonly label: string
  /** Where a valve stands now: the value its popover shows (ItemControls.position). */
  readonly position?: { readonly path: VariablePath; readonly value: number }
  /** The component whose detail draws the item around it: the item itself, or the one that bundles it (a detail display's state names it). */
  readonly components: ReadonlyArray<string>
  /** A bundled device: the components at the far ends of the line it sits on (lineEnds), for a detail that draws it on its own symbol. */
  readonly line?: ReadonlyArray<string>
  readonly offered: ReadonlyArray<ListedControl>
  readonly withheld: ReadonlyArray<WithheldControl>
}

/**
 * A device its host bundles (a pressurizer's relief or block valve): the
 * components at the far ends of the line it sits on. A detail around its host
 * alone may draw the device inside the host's symbol (HMI review of run 26c,
 * g2); one around the host and these draws the line and the device on it.
 */
const lineEnds = (graph: CompiledPlantGraph, item: MimicItem): { readonly line?: ReadonlyArray<string> } => {
  if (item.kind === 'component') return {}
  const port = graph.components[item.component]!.semantics.embedded.find(device => device.id === item.device)?.port
  if (port === undefined) return {}
  const ends = [
    ...(graph.outgoingLinksByComponent[item.component] ?? []).map(index => graph.links[index]!).filter(link => link.fromPortName === port).map(link => link.toComponentIndex),
    ...(graph.incomingLinksByComponent[item.component] ?? []).map(index => graph.links[index]!).filter(link => link.toPortName === port).map(link => link.fromComponentIndex),
  ]
  const line = [...new Set(ends.filter(index => index !== item.component).map(index => String(graph.components[index]!.id)))].slice(0, PROCESS_DISPLAY_DETAIL_MAX_COMPONENTS - 1)
  return line.length === 0 ? {} : { line }
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
  const context: StandingContext = {
    read: path => instance.runtime.readVariable(path),
    mode: processPlantOperatingMode({ system: instance.plant, runtime: instance.runtime, modes: instance.plant.automation.operatingModes })?.id ?? null,
    rules: snapshot === undefined ? new Map() : ruleStatesFrom(snapshot),
  }
  return controls.items
    .filter(entry => itemIds === undefined || itemIds.includes(entry.id))
    .map(entry => ({
      id: entry.id,
      label: entry.label,
      ...(entry.position === undefined ? {} : { position: { path: entry.position, value: numberAt(entry.position) } }),
      components: [String(instance.plant.graph.components[entry.item.component]!.id)],
      ...lineEnds(instance.plant.graph, entry.item),
      offered: entry.offered.map(control => {
        const travel = control.options.flatMap(option => option.travelMs === null ? [] : [option.travelMs])
        const demand = control.demand === undefined ? undefined : numberAt(control.path)
        const under = demand === undefined || snapshot === undefined ? [] : throttledUnder(instance.plant, snapshot, { path: control.path, value: demand })
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
          ...(protection === undefined ? {} : { protection }),
        }
      }),
      withheld: entry.withheld,
    }))
}
