<script module lang="ts">
  import type { AlertRow } from '../../features/displays/alerts/rows.ts'

  export interface AlertLine {
    readonly row: AlertRow
    readonly heading?: string
    readonly firstOut: boolean
    /** Further first-outs, named after the row's own, earliest first. */
    readonly also?: ReadonlyArray<AlertRow>
    readonly detail?: string
  }
</script>

<script lang="ts">
  import { raisedWords, stateWords } from '../../features/displays/alerts/rows.ts'
  import { severityStyle, type Palette, type SeverityGlyph } from './severity.ts'

  // Alert rows as the strip draws them, read-only: the priority's glyph and
  // hue from the severity table (no hue without a priority, R1), the alert's
  // own words, its state and its simulation time. Spans, so a list can sit in
  // a disclosure's summary.
  let { lines, palette }: { lines: ReadonlyArray<AlertLine>; palette: Palette } = $props()

  const shapes: Readonly<Record<SeverityGlyph, string>> = {
    hexagon: 'M1 6 3.5 1.5h5L11 6l-2.5 4.5h-5z', triangle: 'M6 1 11.5 11H.5z', circle: 'M1 6a5 5 0 1 0 10 0A5 5 0 1 0 1 6', square: 'M1.5 1.5h9v9h-9z',
  }
  const time = (at: string): string => `${at.slice(11, 19)} UTC`
  const styleOf = (row: AlertRow) => severityStyle(row.priority, row.alert.severity)!
</script>

{#snippet sign(row: AlertRow)}
  {@const style = styleOf(row)}
  {#if style.glyph !== null}
    <svg viewBox="0 0 12 12" role="img" aria-label={style.word} style:--hue={style.rgb?.[palette]}><path d={shapes[style.glyph]} /></svg>
  {:else}
    <span class="word">{style.word}</span>
  {/if}
{/snippet}

<span class="alert-list" role="list">
  {#each lines as line (line.row.key)}
    {@const style = styleOf(line.row)}
    <span class="line" role="listitem" class:neutral={style.rgb === null} style:--hue={style.rgb?.[palette]}>
      {#if line.heading !== undefined}<strong>{line.heading}</strong>{/if}
      {#if line.firstOut}<span class="mark">first out</span>{/if}
      <span>{@render sign(line.row)} {line.row.alert.message}</span>
      {#each line.also ?? [] as row (row.key)}<span>· {@render sign(row)} {row.alert.message}</span>{/each}
      {#if line.row.alert.standing === true}<span class="mark">standing</span>{/if}
      <span class="muted">{stateWords(line.row)} · {raisedWords(line.row, time)}{line.detail === undefined ? '' : ` · ${line.detail}`}</span>
    </span>
  {/each}
</span>

<style>
  .alert-list { display: flex; flex-direction: column; gap: 2px; }
  .line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; padding-left: 6px; border-left: 3px solid var(--hue); font-size: 12px; line-height: 16px; }
  .line.neutral { border-left-color: var(--muted); }
  .word { font-weight: 700; }
  svg { width: 12px; height: 12px; vertical-align: -1px; fill: var(--hue); stroke: var(--text); stroke-width: 0.75; stroke-opacity: 0.6; }
  .mark { font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
  .muted { color: var(--muted); }
</style>
