import type { CommandOrigin } from '../../../simulation/protocol.ts'
import type { ProcessSignalTagId, VariablePath } from '../graph/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { processPlantOperatingMode } from '../runtime/index.ts'
import { validateOperatorWrite } from './command-guard.ts'
import { optionStanding, ruleStatesFrom, type OptionStanding, type StandingContext } from './control-standing.ts'
import { offeredOption, plantControlsFor, type OfferedControl, type WithheldControl } from './controls.ts'
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
  const numberAt = (path: VariablePath): number => {
    const value = instance.runtime.readVariable(path)
    if (typeof value !== 'number') throw new Error(`${path} reads no number`)
    return value
  }
  const context: StandingContext = {
    read: path => instance.runtime.readVariable(path),
    mode: processPlantOperatingMode({ system: instance.plant, runtime: instance.runtime, modes: instance.plant.automation.operatingModes })?.id ?? null,
    rules: instance.protection === undefined ? new Map() : ruleStatesFrom(instance.protection.snapshot()),
  }
  return controls.items
    .filter(entry => itemIds === undefined || itemIds.includes(entry.id))
    .map(entry => ({
      id: entry.id,
      label: entry.label,
      ...(entry.position === undefined ? {} : { position: { path: entry.position, value: numberAt(entry.position) } }),
      offered: entry.offered.map(control => {
        const travel = control.options.flatMap(option => option.travelMs === null ? [] : [option.travelMs])
        return {
          control,
          standing: control.options.map(option => optionStanding(instance.plant, control, option, context)),
          travelMs: travel.length === 0 ? null : Math.max(...travel),
          ...(control.demand === undefined || control.state === undefined ? {} : { now: { demand: numberAt(control.path), position: numberAt(control.state) } }),
        }
      }),
      withheld: entry.withheld,
    }))
}
