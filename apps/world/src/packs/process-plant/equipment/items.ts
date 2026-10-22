import type { CompiledComponent, CompiledEmbeddedDevice, CompiledPlantGraph } from '../graph/index.ts'
import { SUGGESTION_COUNT, letters, matchedWords, words } from '../../../core/model/text-search.ts'

// The Plant's equipment as people name and operate it, read from the model:
// each component that is equipment, and each device the model bundles inside
// one (the PORV). Operations, queries and displays name an item by the id
// here; a display draws the items, it does not decide what they are.

/** An item of equipment: a component, or a device the model bundles inside one (the PORV). */
export type EquipmentItem =
  | { readonly kind: 'component'; readonly component: number }
  | { readonly kind: 'device'; readonly component: number; readonly device: string }

/** The id an agent names an item by: its component, or its component and the bundled device ("pressurizer.reliefValve"). */
export const equipmentItemId = (graph: CompiledPlantGraph, item: EquipmentItem): string =>
  item.kind === 'component' ? String(graph.components[item.component]!.id) : `${graph.components[item.component]!.id}.${item.device}`

/**
 * The name operators know an item by: a component's short label, else its
 * label; a bundled device's as its component's presentation names it, else
 * the component's short label and the device's own.
 */
export const equipmentItemLabel = (component: CompiledComponent, device: CompiledEmbeddedDevice | undefined): string => {
  const short = component.metadata?.presentation?.shortLabel ?? component.label
  return device === undefined ? short : component.metadata?.presentation?.embedded?.[device.id] ?? `${short} ${device.label}`
}

/** "sgB (Steam Generator B, SG B)". */
export const componentDescription = (graph: CompiledPlantGraph, index: number): string => {
  const component = graph.components[index]!
  const short = component.metadata?.presentation?.shortLabel
  return `${component.id} (${component.label}${short === undefined ? '' : `, ${short}`})`
}

/** Components whose id, label, short label or tags match the guessed words best. */
export const equipmentSuggestions = (graph: CompiledPlantGraph, guess: string): ReadonlyArray<string> => {
  const guessed = words(guess)
  if (guessed.length === 0) return []
  const tagsByComponent = new Map<number, string[]>()
  for (const binding of graph.signalBindings) {
    if (binding.tagId === undefined || binding.owner.type !== 'component') continue
    tagsByComponent.set(binding.owner.componentIndex, [...(tagsByComponent.get(binding.owner.componentIndex) ?? []), String(binding.tagId)])
  }
  return graph.components
    .map(component => {
      const keys = [String(component.id), component.label, component.metadata?.presentation?.shortLabel ?? '', ...(tagsByComponent.get(component.index) ?? [])]
      const matched = matchedWords(guessed, [...new Set(keys.flatMap(words))])
      return { component, score: letters(matched) / letters(guessed), substantive: matched.some(word => word.length >= 2) }
    })
    .filter(entry => entry.substantive && entry.score >= 0.5)
    .sort((left, right) => right.score - left.score || String(left.component.id).localeCompare(String(right.component.id)))
    .slice(0, SUGGESTION_COUNT)
    .map(entry => {
      const tags = (tagsByComponent.get(entry.component.index) ?? []).slice(0, 2)
      return `${componentDescription(graph, entry.component.index)}${tags.length === 0 ? '' : `; tags ${tags.join(', ')}`}`
    })
}

/** Component kinds that are no item of equipment a person sees and operates, with what each is instead. */
const notEquipmentKinds: Readonly<Record<string, string>> = {
  electricalLoad: 'a load is where power ends; it is named where its supply stops',
  deltaTProtectionChannel: 'an instrument channel moves no fluid; it is read through the values it computes',
  rcsInventoryBalance: 'an instrument channel moves no fluid; it is read through the values it computes',
  atmosphereBoundary: 'the atmosphere is where a release leaves the Plant; it is named where each discharge pipe ends',
  safetyInjectionBlockLogic: 'protection logic moves no fluid; it is read through its permissive and block states',
  loadSequencer: 'a load sequencer carries no power; it is read through its step',
  manualActuation: 'a manual actuation pushbutton moves nothing; it is operated where the equipment its rule acts on is drawn',
}

/**
 * Why a component is no item of equipment, undefined for one that is: its
 * kind is a load, an instrument channel, logic or a boundary; or it is a valve
 * that declares no function, so nothing says how it is operated or shown.
 */
export const notEquipmentReason = (component: CompiledComponent): string | undefined => {
  const reason = notEquipmentKinds[String(component.kind)]
  if (reason !== undefined) return reason
  const valve = String(component.kind) === 'processValve' || String(component.kind) === 'steamValve'
  return valve && component.semantics.function === undefined ? `valve ${component.id} declares no function` : undefined
}
