// A topology view as laid out (architecture A5), for both families, in grid
// units: `flow` from the diagram engine (its px over the profile's grid),
// `network` from ELK. What a renderer draws; never stored.
import type { Face, RoutedEdge } from '../diagram/diagram.ts'

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface TopologyLayout {
  readonly family: 'flow' | 'network'; readonly unit: 'grid'; readonly width: number; readonly height: number
  /** A port is drawn where its first edge in rank order meets it; edges run from `from` to `to`, however laid out. */
  readonly nodes: ReadonlyArray<Box & { readonly id: string; readonly ports: Readonly<Record<string, { readonly x: number; readonly y: number; readonly face: Face }>> }>
  readonly edges: ReadonlyArray<RoutedEdge>; readonly groups: ReadonlyArray<Box & { readonly id: string }>
  readonly crossings: number; readonly hash: string; readonly attribution?: string
}
