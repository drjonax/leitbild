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
export const readingRefs = (bindings: ReadonlyArray<Pick<TopologyNode['bindings'][number], 'role' | 'ref'>>): ReadonlyArray<string> =>
  [...new Set(READING_ROLES.flatMap(role => bindings.filter(binding => binding.role === role).map(binding => binding.ref)))].slice(0, MAX_READINGS)

/** "MFW A/B" for MFW A and MFW B: the words their names share in front, then what tells each apart; names sharing no leading word are joined whole. */
export const groupName = (names: ReadonlyArray<string>): string => {
  const split = names.map(name => name.split(' '))
  let shared = 0
  while (split.every(words => words.length > shared + 1 && words[shared] === split[0]![shared])) shared += 1
  return shared === 0 ? names.join('/') : `${split[0]!.slice(0, shared).join(' ')} ${split.map(words => words.slice(shared).join(' ')).join('/')}`
}
