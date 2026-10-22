// A topology view as laid out (architecture A5), for both families, in grid
// units: `flow` from the diagram engine (its px over the profile's grid),
// `network` from ELK. What a renderer draws; never stored.
import type { Face, RoutedEdge } from '../diagram/diagram.ts'
import type { TopologyNode } from '../../../core/observation/topology.ts'

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface TopologyLayout {
  readonly family: 'flow' | 'network'; readonly unit: 'grid'; readonly width: number; readonly height: number
  /**
   * A port is drawn where its first edge in rank order meets it; edges run from `from` to `to`, however laid out.
   * A flow item drawn for alike nodes lists them as `members` (in label order, its own id first); its `text` is the
   * box the engine kept for its lines beside it, how many of them it shows (its name first), and on which side.
   */
  readonly nodes: ReadonlyArray<Box & {
    readonly id: string; readonly ports: Readonly<Record<string, { readonly x: number; readonly y: number; readonly face: Face }>>
    readonly members?: ReadonlyArray<string>; readonly text?: Box & { readonly lines: number; readonly side: Face }
  }>
  readonly edges: ReadonlyArray<RoutedEdge>
  readonly crossings: number; readonly hash: string; readonly attribution?: string
}

/** The roles a flow item writes as readings under its name, at most two, one per observable. */
export const READING_ROLES: ReadonlyArray<TopologyNode['bindings'][number]['role']> = ['level', 'value', 'flow', 'loading']
export const MAX_READINGS = 2
type Bound = Pick<TopologyNode['bindings'][number], 'role' | 'ref'>
/**
 * What a flow item writes under its name: the word of its state (its running or conducting binding, in the words
 * its observable declares), or in its place the command it does not follow; then its readings.
 */
export const itemText = (bindings: ReadonlyArray<Bound>): { readonly state: string | null; readonly readings: ReadonlyArray<string> } => {
  const state = bindings.find(binding => binding.role === 'running' || binding.role === 'conducting')?.ref ?? null
  return { state, readings: [...new Set(READING_ROLES.flatMap(role => bindings.filter(binding => binding.role === role && binding.ref !== state).map(binding => binding.ref)))].slice(0, MAX_READINGS) }
}

/** The word a level reading is written with on a drawing (ISA's abbreviation). */
const LEVEL_WORD = 'LVL'
/**
 * The word a flow item writes before a reading, or null: a level says it is one, since its percent alone would read
 * as a power or an opening (a core's "100.0 %" after a trip). The sizing reserves its room beside the value's.
 */
export const readingWord = (bindings: ReadonlyArray<Bound>, ref: string): string | null =>
  bindings.some(binding => binding.ref === ref && binding.role === 'level') ? LEVEL_WORD : null

/** "MFW A/B" for MFW A and MFW B: the words their names share in front, then what tells each apart; names sharing no leading word are joined whole. */
export const groupName = (names: ReadonlyArray<string>): string => {
  const split = names.map(name => name.split(' '))
  let shared = 0
  while (split.every(words => words.length > shared + 1 && words[shared] === split[0]![shared])) shared += 1
  return shared === 0 ? names.join('/') : `${split[0]!.slice(0, shared).join(' ')} ${split.map(words => words.slice(shared).join(' ')).join('/')}`
}
