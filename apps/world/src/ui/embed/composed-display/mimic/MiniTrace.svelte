<script lang="ts">
  import type { ComposedDisplayPen } from '../../../../packs/process-plant/displays/compose.ts'
  import type { TrendPoint } from '../../../../packs/process-plant/displays/trend-reading.ts'
  import { sparkline } from '../sparkline.ts'

  // A vessel's reading over the drawing's trend window, drawn as a lead
  // value's sparkline is (sparkline.ts: its own data's scale, broken where
  // nothing was recorded, starting where history starts): a heat
  // exchanger's level in a strip inside its box, a reactor vessel's value
  // under its row. A grey line, quiet when steady; no axes, no value to quote.
  let { pen, points, now, windowMs, width, height, framed = false }: {
    pen: ComposedDisplayPen
    points: ReadonlyArray<TrendPoint>
    now: number
    windowMs: number
    width: number
    height: number
    /** Drawn on a symbol: inside OpenBridge's mini graph frame, so it reads apart from the symbol under it. */
    framed?: boolean
  } = $props()

  const line = $derived(Number.isFinite(now) ? sparkline({ points, now, windowMs, size: { width, height }, limit: null, resolution: pen.resolution }) : null)
</script>

<svg class="trace" {width} {height} aria-hidden="true">
  {#if framed}<rect class="frame" x="0.5" y="0.5" width={width - 1} height={height - 1} rx="2.5" />{/if}
  {#if line !== null && line.path !== ''}<path class="line" d={line.path} />{/if}
  {#if line?.end}<circle class="end" cx={line.end.x} cy={line.end.y} r="1.5" />{/if}
</svg>

<style>
  .trace { display: block; flex: none; overflow: visible; }
  .frame { fill: var(--instrument-frame-primary-color); stroke: var(--instrument-frame-tertiary-color); stroke-width: 1; opacity: 0.9; }
  .line { fill: none; stroke: var(--element-neutral-color); stroke-width: 1; stroke-linejoin: round; }
  .end { fill: var(--element-neutral-color); }
</style>
