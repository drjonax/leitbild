import type { VariablePath } from '../../graph/index.ts'
import type { MimicFlowBinding, MimicItemBinding, MimicStubWord } from './bindings.ts'
import type { Face, PlacedNode } from '../../../../features/displays/diagram/index.ts'
import { DIAGRAM_ENGINE_VERSION } from '../../../../features/displays/diagram/index.ts'
import type { MimicPresentation } from './presentation.ts'
import type { FlapPart, MimicRow } from './rows.ts'
import type { MimicIntent } from './scope.ts'

// A generated equipment mimic: World resolves the agent's intent to part of
// the Plant graph, draws each component with the OpenBridge component its kind
// presents as, and lays the drawing out automatically. Nothing in it is drawn
// by hand. Geometry is fixed when the display is composed; samples only
// restyle it.

/** Changes whenever the same intent on the same model could draw differently. */
export const MIMIC_LAYOUT_VERSION = `diagram-${DIAGRAM_ENGINE_VERSION}/openbridge-2.0.0/mimic-11`

/**
 * A mimic may be up to 800 px wide (owner decision): OpenBridge's full-size
 * symbols need it for four loops. A narrower chat column shrinks the drawing
 * only as far as its smallest text stays 11 px; beyond that it scrolls.
 */
export const MIMIC_MAX_WIDTH = 800
/** The smallest text in a chat mimic is OpenBridge's 11.5 px readout row; it may shrink to 11 px (chatMimicProfile.minScale). */
export const MIMIC_MIN_SCALE = 11 / 11.5

export interface MimicDrawnItem {
  readonly id: string
  readonly binding: MimicItemBinding
  readonly presentation: MimicPresentation
  /** The symbol's box (devices: the 48 px symbol; tanks: the 48×96 box; bars: the bar). */
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  /** Inside a drawn loop, its pipes run horizontally or vertically through it; the icon follows. */
  readonly orientation: 'horizontal' | 'vertical'
  readonly text: PlacedNode['text']
  readonly frame: PlacedNode['frame']
  /**
   * A device's flap lines under the one OpenBridge draws, each the height
   * of a flap: the flap's action where the frame is too narrow for it
   * whole, and the count of its other active alarms. A vessel says the same
   * in its stack's alarm rows.
   */
  readonly flapLines: ReadonlyArray<FlapPart>
  /** The rows of its text stack that fit, below its label. */
  readonly rows: ReadonlyArray<MimicRow>
  /**
   * A compact marker: the valve's icon on its pipe; its one row is empty
   * unless the valve says something (rows.ts).
   */
  readonly marker: boolean
  /** The Plant components it stands for, by id (a group's members, a bundled device's host): what opening it shows. */
  readonly components: ReadonlyArray<string>
  /** A reactor vessel's drawing (MimicVesselDrawing); absent for any other symbol. */
  readonly vessel?: MimicVesselDrawing
  /** What it shows of its reading over the last minutes (MimicItemTrend); absent where it shows none. */
  readonly trend?: MimicItemTrend
}

/**
 * How a reactor vessel is drawn in its box (vessel-symbol.ts), from the
 * model: its nozzles where the layout brought its pipes, and its core
 * region where it is the energy's source, below its nozzles (`band`) or
 * overlapping the lowest of them (`overlap`). What it inserts into the core
 * (rod banks) is its binding's (MimicItemBinding.insertion).
 */
export interface MimicVesselDrawing {
  readonly core: 'band' | 'overlap' | null
  /** Its own span across its box, in the box's px: a vessel stands taller than wide, in a wider box beside where its pipes arrive (vessel-fit.ts). */
  readonly span: { readonly x: number; readonly width: number }
  readonly nozzles: ReadonlyArray<{ readonly x: number; readonly y: number; readonly face: Face }>
}

/**
 * What an item shows of its reading over the drawing's trend window, in a
 * profile that shows trends (MimicProfile.trends):
 * - `fill`: a tank's own level, as the trace its fill draws (OpenBridge's
 *   tank graph), never another reading in a level-shaped body;
 * - `strip`: a heat exchanger's level as its row reads it now (`row`: NR,
 *   or WR while NR stands off its span), in a strip inside its box.
 * A reactor vessel's value rows carry their sparklines on the row (MimicRow
 * `sparkline`).
 */
export type MimicItemTrend =
  | { readonly kind: 'fill'; readonly path: VariablePath }
  | { readonly kind: 'strip'; readonly row: number }

export type MimicPipeState =
  /**
   * A pipe; where it stands for parallel pipes of grouped equipment (both
   * pumps' suctions), `parallel` holds the others' flows and the drawn pipe
   * carries flow while any of them does.
   */
  | { readonly kind: 'fluid'; readonly flow: MimicFlowBinding; readonly parallel: ReadonlyArray<MimicFlowBinding> }
  | { readonly kind: 'power'; readonly energizedPath: VariablePath | null }

export interface MimicDrawnPipe {
  readonly id: string
  /** The Plant links this pipe draws (one link, split where a bundled device sits on it). */
  readonly linkId: string
  readonly carrier: string
  readonly points: ReadonlyArray<readonly [number, number]>
  readonly gaps: ReadonlyArray<readonly [number, number]>
  readonly state: MimicPipeState
}

/** Where the drawing stops: the pipe leaves for, or comes from, equipment not drawn. */
export interface MimicDrawnStub {
  readonly id: string
  readonly direction: 'in' | 'out'
  /** The end point, and the face it points out of. */
  readonly end: { readonly x: number; readonly y: number; readonly face: Face }
  readonly text: string
  readonly textBox: PlacedNode['text']
  /** The lines it stands for: how its pipe is drawn. */
  readonly states: ReadonlyArray<MimicPipeState>
  /** A power line's: what it says under its name of the equipment it names (MimicStubWord); null for a pipe of fluid. */
  readonly word: MimicStubWord | null
}

/** Where a drawn loop's lane lies: its loop id, its box, and its name. */
export interface MimicZone {
  readonly lane: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly label: string
}

export interface CompiledMimic {
  /** The agent's intent; null for a drawing of a scope World resolved itself (the unit overview's principal circuits). */
  readonly intent: MimicIntent | null
  /** The profile it is drawn by (profiles.ts). */
  readonly profile: string
  readonly layoutVersion: string
  readonly width: number
  readonly height: number
  /** OpenBridge readout stack size of device symbols; the renderer sets the same size. */
  readonly readoutSize: 'small' | 'regular'
  /** The smallest scale the renderer may show the drawing at; below it the view scrolls. */
  readonly minScale: number
  /** Pipes crossing pipes or headers, each drawn with a gap. */
  readonly crossings: number
  readonly items: ReadonlyArray<MimicDrawnItem>
  readonly pipes: ReadonlyArray<MimicDrawnPipe>
  readonly stubs: ReadonlyArray<MimicDrawnStub>
  /** One zone per drawn loop, named as operators name it ("Loop B"). */
  readonly zones: ReadonlyArray<MimicZone>
  /** Every variable the mimic reads, for sampling. */
  readonly paths: ReadonlyArray<VariablePath>
  /** The readings its trends draw over time (MimicItemTrend, row sparklines), whose history a display keeps; empty where it shows none. */
  readonly trendPaths: ReadonlyArray<VariablePath>
  /** What the mimic draws, for the compose result. */
  readonly summary: {
    readonly equipment: ReadonlyArray<{ readonly id: string; readonly label: string }>
    readonly stops: ReadonlyArray<string>
    readonly carriers: ReadonlyArray<string>
    readonly unverifiedFlows: ReadonlyArray<string>
    readonly unmeasuredStates: ReadonlyArray<string>
  }
  /** Geometry hash, independent of ids: a stored display whose drawing changed says so. */
  readonly hash: string
}
