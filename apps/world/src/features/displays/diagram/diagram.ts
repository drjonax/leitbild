// The diagram engine's input and output. The engine lays out any directed
// flow graph as an orthogonal, P&ID-style drawing on OpenBridge's 24 px grid.
// It knows nothing about any pack: no kinds, media, partitions or ids have
// meaning to it. The caller (a pack's topology view, such as the process-plant
// mimic) states structure (footprints, ports, partitions, common nodes, bars,
// text) and rules (a DiagramProfile); the
// engine returns geometry and a verification report, or the reasons a graph
// cannot be drawn within the budget. The room a drawing is shown in only
// chooses among the graph's drawings; it never changes one.
//
// Determinism: the output is a pure function of the input, the profile, the
// room and DIAGRAM_ENGINE_VERSION. Every ordering decision breaks ties on structural
// keys (`rank`, partition `order`), never on ids, so renaming ids changes no
// geometry. Input the engine cannot order that way is rejected (it throws).

export const DIAGRAM_ENGINE_VERSION = 8

export type Face = 'top' | 'right' | 'bottom' | 'left'

export interface DiagramPort {
  readonly id: string
  /** Flow enters (`in`), leaves (`out`), or may go either way (`both`). The engine picks faces from flow direction. */
  readonly direction: 'in' | 'out' | 'both'
  /** Structural sort key of the port on its node (its name in the kind's definition); unique on its node. */
  readonly rank: string
}

export interface DiagramText {
  /**
   * The node's text stack, top to bottom, each line with its width and height
   * in px as measured by the caller (OpenBridge: a 16 px tag line, 20 px value
   * and state rows). A required line is never dropped to fit.
   */
  readonly lines: ReadonlyArray<{ readonly width: number; readonly height: number; readonly required: boolean }>
}

export interface DiagramNode {
  /** Opaque to the engine; used only to map the output back. */
  readonly id: string
  /**
   * Structural sort key that breaks every tie (kind, role in its partition, port
   * names). Unique per partition: repeated structure may reuse a rank across
   * partitions, because the partition `order` disambiguates it.
   */
  readonly rank: string
  /**
   * - `device`: a symbol of `cells` grid cells with ports on its faces;
   * - `bar`: a header or bus drawn as a line spanning what it connects;
   * - `common`: a large node the partitions leave and return to (a vessel a
   *   plant's loops share), drawn beside the partitions it serves;
   * - `stub`: where the drawing stops: an off-sheet end with its own text.
   */
  readonly role: 'device' | 'bar' | 'common' | 'stub'
  /**
   * Footprint in cells on screen (symbols never rotate): a device is 2×2, a
   * tank 2×4. Devices, common nodes and stubs; ignored for bars. A flow face carrying
   * more distinct ports than it has interior grid points grows, so every port
   * gets its own grid slot; the placed box reports the grown size.
   */
  readonly cells: { readonly width: number; readonly height: number }
  /**
   * A common node only: how far its box reaches past its outermost port tracks, in
   * px, at its top and at its bottom on screen (a vessel's head above its
   * nozzles, its core region and bottom below them), where its ports face
   * sideways; at least a grid step either way.
   */
  readonly ends?: { readonly top: number; readonly bottom: number }
  /**
   * How far inside the footprint a pipe ends, in px: a symbol whose visible
   * body is inset from its box (a tank) takes its pipes to the body edge.
   */
  readonly portInset: number
  readonly ports: ReadonlyArray<DiagramPort>
  /**
   * Parallel repeated structure (a plant's loop, a grid's feeder): nodes of one
   * partition line up in one column or row, partitions in `order`.
   */
  readonly partition?: { readonly key: string; readonly order: number }
  readonly text: DiagramText
  /**
   * An alarm frame may be drawn around the node's button box (the symbol and
   * its text stack, which form one box), with a flap below it; other text
   * keeps clear of the frame and flap.
   */
  readonly frameable: boolean
  /** The widest flap label the node can show, in px, measured by the caller. Frameable nodes only. */
  readonly flapWidth?: number
  /**
   * How many lines its flap may take, one under another (1 where absent): a
   * second counts the node's other active alarms. Frameable nodes only.
   */
  readonly flapLines?: number
}

export interface DiagramEdge {
  readonly id: string
  /** With its endpoints' ranks, the edge's structural sort key; that key is unique. */
  readonly rank: string
  readonly from: { readonly node: string; readonly port: string }
  readonly to: { readonly node: string; readonly port: string }
}

export interface DiagramGraph {
  readonly nodes: ReadonlyArray<DiagramNode>
  readonly edges: ReadonlyArray<DiagramEdge>
}

/** Rules the caller's HMI standard sets; the engine enforces and verifies them. */
export interface DiagramProfile {
  /**
   * Grid pitch in px (OpenBridge GRID = 24). Symbols, ports and tracks sit on
   * it; a channel no crossing passes may pack its tracks at half pitch.
   */
  readonly grid: number
  /** Px per footprint cell. */
  readonly cell: number
  /** Pipe stroke (outline) width, bend corner radius, half a crossing's gap and the clear gap between parallel pipes, in px. */
  readonly pipe: { readonly outline: number; readonly cornerRadius: number; readonly crossingHalfGap: number; readonly trackGap: number }
  /** Text keeps this far from any other node's alarm frame, flap included. */
  readonly textClearance: number
  /** The alarm frame hugs the button box (symbol plus text stack) at this margin. */
  readonly frameMargin: number
  /** The flap sits below the frame and adds this much height for each of its lines. */
  readonly flapHeight: number
  /** The frame is as wide as the flap label plus this padding when that exceeds the button box. */
  readonly flapLabelPadding: number
  /**
   * The fit ladder, richest first: which text a drawing keeps (`full`, or
   * only each stack's required lines) and where stacks go (right of their
   * symbols, the same with partition stubs' labels below their ends, below partition
   * symbols, below every symbol). The first rung with a
   * drawing that fits wins; text never shrinks. Rungs a graph cannot use
   * (no optional lines, no partitions) are skipped.
   */
  readonly fit: ReadonlyArray<{ readonly detail: 'full' | 'required'; readonly text: 'right' | 'stubsBelow' | 'partitionsBelow' | 'allBelow' }>
  /** Density the HMI standard allows. */
  readonly limits: {
    readonly symbols: number
    /** Symbols in one partition, where two or more are drawn side by side; one partition alone answers to `symbols`. */
    readonly symbolsPerPartition: number
    readonly sharedSymbols: number
    readonly partitions: number
    /** The most crossings a drawing may have: absolute, never relative to the crossings a graph's structure forces. */
    readonly crossings: number
    readonly bendsPerEdge: number
  }
}

/** The room a caller shows a drawing in: the largest drawing it can show. Nothing but the choice among a graph's drawings depends on it. */
export interface DiagramRoom {
  readonly maxWidth: number
  readonly maxHeight: number
}

export interface PlacedNode {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /**
   * Where each connected port meets its pipe: on the node's face, `portInset` inside
   * the footprint, at a grid position along the face. In-ports face upstream
   * and out-ports downstream, except that in vertical flow a symbol whose text
   * stack sits below it takes its in-ports on its left face (the stack covers
   * its lower face); each such pipe rises beside the stack and turns in. A common node's ports sit on
   * their routing tracks, which may be half-grid. A bar's port is the bar's
   * centre on the side its pipes attach from; each pipe's own tee point on
   * the bar is its polyline's end.
   */
  readonly ports: Readonly<Record<string, { readonly x: number; readonly y: number; readonly face: Face }>>
  /**
   * The node's text, which side of the node it is on, and how many of the
   * node's leading lines it shows (all of them, or the prefix through the
   * last required line when the full text does not fit). A symbol's stack
   * touches it, right of it (centred on its height) or below it (centred on
   * its width); right is preferred, below is used when the drawing is too
   * large otherwise (partition symbols first, then all). A bar's label sits beyond
   * one of its ends, whichever no pipe passes.
   */
  readonly text: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly side: Face; readonly lines: number } | null
  /**
   * The room reserved for the alarm frame of a frameable node, flap included:
   * the button box grown by `frameMargin`, the flap's lines below it, and as
   * wide as the flap needs, centred on the button box. Null when not frameable.
   */
  readonly frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null
}

export interface RoutedEdge {
  readonly id: string
  /** Orthogonal polyline from the source port to the target port, in flow direction. */
  readonly points: ReadonlyArray<readonly [number, number]>
  /**
   * Points on this edge where another run crosses over it: the edge is drawn
   * with a gap there. Of two crossing pipes the vertical one takes the gap; a
   * pipe crossing a bar always does.
   */
  readonly gaps: ReadonlyArray<readonly [number, number]>
}

export interface DiagramZone {
  readonly partition: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface DiagramViolation {
  readonly rule: 'overlap' | 'textClearance' | 'outsideBox' | 'diagonal' | 'bends' | 'bendSpacing' | 'crossingAtJunction' | 'pipeSpacing' | 'pitch'
  readonly subject: string
  readonly detail: string
}

export type DiagramLayoutResult =
  | {
    readonly ok: true
    readonly width: number
    readonly height: number
    readonly nodes: ReadonlyArray<PlacedNode>
    readonly edges: ReadonlyArray<RoutedEdge>
    readonly zones: ReadonlyArray<DiagramZone>
    /** A stable hash of the geometry, independent of ids. */
    readonly hash: string
    /** Crossings drawn, each a gap. */
    readonly crossings: number
  }
  | {
    readonly ok: false
    /** Why no layout fits: density over its limits, or the size the graph needs. */
    readonly reasons: ReadonlyArray<
      | { readonly kind: 'density'; readonly limit: keyof DiagramProfile['limits']; readonly count: number; readonly max: number }
      | { readonly kind: 'size'; readonly width: number; readonly height: number }
      | { readonly kind: 'unverifiable'; readonly violations: ReadonlyArray<DiagramViolation> }
    >
  }
