import type { CompiledPlantGraph, ProcessSignalBinding } from '../graph/index.ts'

// Shorter names for a signal where its whole name does not fit, decided from
// the model, never by cutting: the QA review of run 22 read "Process … outlet
// flow · …Header", whole words dropped from the wrong end. Its equipment is
// named by its short name; then the words every signal of that equipment
// shares go ("Process header"), as they tell nothing apart there; then each
// leading word whose loss still leaves the name unique on its equipment.

const wordsOf = (label: string): ReadonlyArray<string> => label.split(' ').filter(word => word.length > 0)
const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** Each component's signal labels, by component index, read once per graph. */
const labelsByGraph = new WeakMap<CompiledPlantGraph, ReadonlyMap<number, ReadonlyArray<string>>>()

const componentLabels = (graph: CompiledPlantGraph, component: number): ReadonlyArray<string> => {
  let known = labelsByGraph.get(graph)
  if (known === undefined) {
    const labels = new Map<number, string[]>()
    for (const binding of graph.signalBindings) {
      if (binding.owner.type !== 'component') continue
      const list = labels.get(binding.owner.componentIndex) ?? []
      if (!list.includes(binding.label)) list.push(binding.label)
      labels.set(binding.owner.componentIndex, list)
    }
    known = labels
    labelsByGraph.set(graph, known)
  }
  return known.get(component) ?? []
}

/** Words every label of the equipment's signals has, lowercased; none where it has fewer than three signals to compare. */
const sharedWords = (labels: ReadonlyArray<string>): ReadonlySet<string> => {
  if (labels.length < 3) return new Set()
  const [first, ...rest] = labels.map(label => new Set(wordsOf(label.toLowerCase())))
  return new Set([...first!].filter(word => rest.every(words => words.has(word))))
}

/**
 * Shorter names for a component's signal, from longest to shortest, each
 * still telling it apart from the equipment's other signals; empty for a
 * tagged signal (a tag is never shortened, nor cut) and for one on a link.
 */
export const shorterSignalNames = (graph: CompiledPlantGraph, binding: ProcessSignalBinding, name: string): ReadonlyArray<string> => {
  if (binding.tagId !== undefined || binding.owner.type !== 'component') return []
  const component = graph.components[binding.owner.componentIndex]!
  const short = component.metadata?.presentation?.shortLabel ?? component.label
  const label = binding.label
  const labels = componentLabels(graph, binding.owner.componentIndex)
  const shared = sharedWords(labels)
  const named = (quantity: string): string => quantity.toLowerCase().includes(short.toLowerCase()) ? capitalized(quantity) : `${capitalized(quantity)} · ${short}`
  // The label naming its equipment in full reads it by its short name ("Pressurizer relief flow" → "PZR relief flow").
  const at = label.toLowerCase().indexOf(component.label.toLowerCase())
  const own = at < 0 ? named(label) : `${label.slice(0, at)}${short}${label.slice(at + component.label.length)}`
  const specific = wordsOf(label).filter(word => !shared.has(word.toLowerCase()))
  // Each shorter tail of the specific words, while no other label on the equipment ends the same way.
  const others = labels.filter(other => other !== label).map(other => wordsOf(other.toLowerCase()).filter(word => !shared.has(word)).join(' '))
  const tails = specific.slice(1).map((_, index) => specific.slice(index + 1).join(' '))
    .filter(tail => !others.some(other => other === tail.toLowerCase() || other.endsWith(` ${tail.toLowerCase()}`)))
  return [...new Set([own, ...(shared.size > 0 && specific.length > 0 ? [named(specific.join(' '))] : []), ...tails.map(named)])]
    .filter(form => form !== name && form.length < name.length)
}
