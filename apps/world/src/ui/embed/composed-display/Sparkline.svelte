<script lang="ts">
  import type { ComposedDisplayPen } from '../../../packs/process-plant/displays/compose.ts'
  import type { ComposedDisplayThreshold } from '../../../packs/process-plant/ic/thresholds.ts'
  import { alertTypeOf } from './panel-presenters.ts'
  import { historyStartX, SPARKLINE_SIZE, sparkline, sparklineText } from './sparkline.ts'
  import type { TrendPoint } from '../../../packs/process-plant/displays/trend-reading.ts'

  // A lead value's direction and rate at a glance (ISA-101 Level 1): a grey
  // line in OpenBridge's instrument frame, with no axes. It takes the alarm
  // colour only while the value is in alarm. A value the Run does not record
  // has no line; the empty frame says so.
  let { pen, windowMs, points, now, limit, inAlarm, historyMissing, historyError, size = SPARKLINE_SIZE, hatched = false }: {
    pen: ComposedDisplayPen
    windowMs: number
    /** Its recorded history as shown: readings below its resolution read 0. */
    points: ReadonlyArray<TrendPoint>
    /** The latest sample's Run time: where the line ends. */
    now: number
    /** The limit its row's margin names, drawn dashed where it lies inside the plotted range. */
    limit: ComposedDisplayThreshold | null
    /** The most severe of its limits in force whose rule is active now. */
    inAlarm: ComposedDisplayThreshold | null
    historyMissing: boolean
    historyError: string | undefined
    /** Its size: the lead values' column, or a quick look's trend column, which an overlay widens. */
    size?: { readonly width: number; readonly height: number }
    /** Hatch the part of the window its recorded history does not reach (a quick look's rows on one shared time axis). */
    hatched?: boolean
  } = $props()

  const width = $derived(size.width)
  const height = $derived(size.height)
  const hatchId = `sparkline-hatch-${Math.random().toString(36).slice(2)}`
  const line = $derived(pen.recorded && Number.isFinite(now) ? sparkline({ points, now, windowMs, size, limit, resolution: pen.resolution }) : null)
  const unreached = $derived(hatched && pen.recorded && Number.isFinite(now) ? historyStartX(points, now, windowMs, width) : 0)
  const text = $derived(sparklineText({ recorded: pen.recorded, windowMs, unit: pen.unit, resolution: pen.resolution, line, historyMissing, historyError }))
  const alert = $derived(inAlarm === null ? '' : alertTypeOf(inAlarm.severity ?? 'warning'))
</script>

{#if pen.recorded}
  <svg class={`sparkline ${alert}`} {width} {height} role="img" aria-label={text}>
    <title>{text}</title>
    <rect class="frame" x="0.5" y="0.5" width={width - 1} height={height - 1} rx="3.5" />
    {#if unreached > 1}
      <defs><pattern id={hatchId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="hatch" x1="0" y1="0" x2="0" y2="4" /></pattern></defs>
      <rect x="1" y="1" width={Math.max(0, unreached - 1)} height={height - 2} fill={`url(#${hatchId})`} />
    {/if}
    {#if line?.limit}<line class="limit" x1="1" x2={width - 1} y1={line.limit.y} y2={line.limit.y} />{/if}
    {#if line !== null && line.path !== ''}<path class="line" d={line.path} />{/if}
    {#if line?.end}<circle class="end" cx={line.end.x} cy={line.end.y} r="2" />{/if}
  </svg>
{:else}
  <span class="none" style={`width:${width}px;height:${height}px`} title={text}>not recorded</span>
{/if}

<style>
  .sparkline { display: block; flex: none; }
  /* OpenBridge's mini graph frame (obc-graph-mini), drawn here so the line can break at gaps and mark a limit. */
  .frame { fill: var(--instrument-frame-primary-color); stroke: var(--instrument-frame-tertiary-color); stroke-width: 1; }
  .line { fill: none; stroke: var(--element-neutral-color); stroke-width: 1.5; stroke-linejoin: round; }
  .end { fill: var(--element-neutral-color); stroke: var(--border-silhouette-color); stroke-width: 1; }
  .hatch { stroke: var(--element-neutral-color); stroke-width: 1; stroke-opacity: 0.35; }
  .limit { stroke: var(--element-neutral-color); stroke-width: 1; stroke-dasharray: 3 2; stroke-opacity: 0.8; }
  /* Colour and weight both carry the alarm, keyed by severity as everywhere else (alertTypeOf). */
  .alarm .line, .warning .line, .caution .line { stroke-width: 2; }
  .alarm .line { stroke: var(--alert-alarm-color); }
  .alarm .end { fill: var(--alert-alarm-color); }
  .warning .line { stroke: var(--alert-warning-color); }
  .warning .end { fill: var(--alert-warning-color); }
  .caution .line { stroke: var(--alert-caution-color); }
  .caution .end { fill: var(--alert-caution-color); }
  .none { flex: none; display: flex; align-items: center; justify-content: center; border: 1px dashed var(--border-divider-color); border-radius: 4px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--element-neutral-color); white-space: nowrap; }
</style>
