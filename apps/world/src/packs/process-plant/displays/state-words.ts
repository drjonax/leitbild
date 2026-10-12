import type { CompiledPlantGraph, ProcessSignalBinding } from '../graph/index.ts'

// How a display words an on/off signal's two states, from what the model
// declares: the words its equipment's presentation gives them, with its name
// ("Source-range HV off · Core"); else, for a signal that reads or commands
// a state aspect, its equipment's name and the aspect's words ("EDG A RUN",
// "Offsite BKR A OPEN", "RCP A CMD STOP"); else its label, answered yes or
// no. Never a negated label ("Not source-range detector high voltage on":
// HMI review of run 23).

export interface StateTexts {
  readonly on: string
  readonly off: string
}

export const stateTexts = (graph: CompiledPlantGraph, binding: ProcessSignalBinding): StateTexts => {
  const owner = binding.owner.type === 'component' ? graph.components[binding.owner.componentIndex]! : undefined
  const local = owner === undefined ? undefined : String(binding.path).slice(String(owner.id).length + 1)
  const declared = local === undefined ? undefined : owner?.metadata?.presentation?.states?.[local]
  // A row of alike states (two buses' voltage) is told apart by its equipment, where the words do not name it.
  const short = owner?.metadata?.presentation?.shortLabel ?? owner?.label
  const named = (text: string): string => short === undefined || text.includes(short) ? text : `${text} · ${short}`
  if (declared !== undefined) return { on: named(declared.on), off: named(declared.off) }
  const served = owner?.semantics.aspects.find(aspect => aspect.command === binding.path || aspect.state?.path === binding.path)
  const words = served?.aspect === 'running' ? ['RUN', 'STOP']
    : served?.aspect === 'energized' ? ['LIVE', 'DEAD']
      : served?.aspect === 'position' && served.state?.reading === 'closedWhileTrue' ? ['CLOSED', 'OPEN']
        : served?.aspect === 'position' ? ['OPEN', 'SHUT']
          : undefined
  if (owner === undefined || served === undefined || words === undefined) return { on: `${binding.label}: yes`, off: `${binding.label}: no` }
  const name = `${owner.metadata?.presentation?.shortLabel ?? owner.label}${served.command === binding.path ? ' CMD' : ''}`
  return { on: `${name} ${words[0]}`, off: `${name} ${words[1]}` }
}

/** Whether a signal is a valve's position or its demand read as a fraction of its travel (the state or command of a position aspect). */
export const servesPosition = (graph: CompiledPlantGraph, binding: ProcessSignalBinding): boolean => {
  if (binding.owner.type !== 'component' || binding.quantity !== 'ratio') return false
  const owner = graph.components[binding.owner.componentIndex]!
  return [...owner.semantics.aspects, ...owner.semantics.embedded.flatMap(device => device.aspects)]
    .some(aspect => aspect.aspect === 'position' && (aspect.command === binding.path || aspect.state?.path === binding.path))
}
