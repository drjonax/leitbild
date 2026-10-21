// The T32 harness (plan v3.1 Appendix F): measures a `network` layout's
// crossings, box overlaps and warm CPU, and reports the cold call. CPU is the
// main thread's, in references timed beside each call (cpu-cost.ts), scaled to
// quiet milliseconds; ELK runs on the main thread, so its time is all there.
import { referenceComputation, referenceQuietMs, threadCpuMs } from '../cpu-cost.ts'
import type { TopologyLayout } from '../../src/features/displays/topology/layout.ts'

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** Node boxes that overlap another node, as `a × b`. */
export const overlaps = (layout: TopologyLayout): ReadonlyArray<string> =>
  layout.nodes.flatMap((a, i) => layout.nodes.slice(i + 1).filter(b => overlap(a, b)).map(b => `${a.id} × ${b.id}`))

/** Edge segments that pass through the inside of a node box other than the edge's own ends, as `edge × node`. */
export const edgesThroughNodes = (layout: TopologyLayout, endsOf: (edge: string) => ReadonlyArray<string>): ReadonlyArray<string> => layout.edges.flatMap(edge => {
  const segments = edge.points.slice(1).map((b, i) => [edge.points[i]!, b] as const)
  return layout.nodes.filter(node => !endsOf(edge.id).includes(node.id) && segments.some(([a, b]) => overlap(node, {
    x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.max(Math.abs(a[0] - b[0]), 1e-9), height: Math.max(Math.abs(a[1] - b[1]), 1e-9),
  }))).map(node => `${edge.id} × ${node.id}`)
})

const cpuMsOf = async (run: () => Promise<unknown>): Promise<number> => {
  const before = process.threadCpuUsage()
  await run()
  const used = process.threadCpuUsage(before)
  return (used.user + used.system) / 1_000
}

export interface CpuReport {
  /** The first call of the process: ELK's script loaded and compiled, its first layout. */
  readonly coldMs: number
  readonly warmP95Ms: number
  readonly warmMedianMs: number
  readonly rounds: number
}

/**
 * The call's CPU per round as references (the reference timed just before it on
 * the same thread) times the reference's quiet cost; p95 and median over the
 * warm rounds. `cold` must be the process's first call.
 */
export const measureCpu = async (run: () => Promise<unknown>, rounds: number): Promise<CpuReport> => {
  const coldMs = await cpuMsOf(run)
  const quiet: number[] = []
  for (let round = 0; round < rounds; round += 1) {
    const referenceMs = threadCpuMs(referenceComputation)
    quiet.push((await cpuMsOf(run)) / referenceMs * referenceQuietMs)
  }
  quiet.sort((a, b) => a - b)
  return { coldMs, warmP95Ms: quiet[Math.ceil(0.95 * quiet.length) - 1]!, warmMedianMs: quiet[Math.floor(quiet.length / 2)]!, rounds }
}
