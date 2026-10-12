<script lang="ts">
  import type { ComposedDisplaySnapshot } from './composed-display-session.ts'
  import { FACEPLATE_SPARKLINE_MS, fitParts, fitValuesRow, type FaceplateLine } from './faceplate-lines.ts'
  import { SPARKLINE_SIZE } from './sparkline.ts'
  import { panelFont, textMeasure } from './text-measure.ts'
  import AlarmChip from './AlarmChip.svelte'
  import Sparkline from './Sparkline.svelte'

  // One faceplate row on one line. Its values are never shortened (a tag is
  // whole or the row is wrong); what it says beside them gives way to its
  // room: a sparkline first, then a bar, then the note drops whole parts; a
  // rule's deciding readings drop from the last, a consequence takes its
  // fullest form that fits. Tooltips keep everything.
  let { line, now, history }: {
    line: Exclude<FaceplateLine, { readonly kind: 'loops' }>
    now: number
    history: Pick<ComposedDisplaySnapshot, 'historyMissing' | 'historyErrors'>
  } = $props()

  /** The space between a row's parts (the CSS gap below). */
  const GAP = 6
  /** A bar's length and thickness: a span at a glance, beside the number that reads it. */
  const BAR = { width: 64, thickness: 8 }

  const measureNote = { quiet: textMeasure(panelFont(11)), bold: textMeasure(panelFont(11, 600)) }
  const measureText = textMeasure(panelFont(12))

  let room = $state(0)
  let cellsWidth = $state(0)
  let leadWidth = $state(0)

  const fit = $derived.by(() => {
    if (line.kind !== 'values') return null
    const measure = line.note?.tone === 'quiet' ? measureNote.quiet : measureNote.bold
    return fitValuesRow({
      room,
      cells: cellsWidth,
      gap: GAP,
      // A pixel more than measured: the browser's layout rounds where the canvas does not.
      note: (line.note?.forms ?? []).map(form => Math.ceil(measure(form)) + 1),
      bar: line.bar === null ? null : BAR.width,
      sparkline: line.sparkline === null ? null : SPARKLINE_SIZE.width,
    })
  })
  // A rule's deciding readings, as many whole as fit beside its words (measured as drawn); a consequence's fullest form that fits.
  const deciding = $derived(line.kind === 'rule' ? fitParts(line.deciding, text => leadWidth + GAP + Math.ceil(measureText(`· ${text}`)) + 1 <= room) : [])
  const decidingTitle = $derived(line.kind === 'rule' ? line.deciding.join(' · ') : '')
  const consequence = $derived(line.kind === 'consequence' ? line.forms.find(form => Math.ceil(measureText(form)) + 1 <= room) ?? line.forms.at(-1)! : '')
</script>

{#if line.kind === 'values'}
  <li class="line values" bind:clientWidth={room}>
    <span class="cells" bind:clientWidth={cellsWidth}>
      {#each line.cells as cell, index (cell.pen.path)}
        {#if index > 0}<span class="sep">·</span>{/if}
        {#if cell.value.kind === 'state'}
          <!-- A state in its declared words; colour only while an I&C limit on it acts. -->
          <obc-status-indicator class="state" status={cell.inAlarm !== null ? 'alarm' : cell.value.on ? 'active' : 'inactive'} title={cell.pen.described}><span data-text>{cell.value.words}</span></obc-status-indicator>
        {:else}
          <span class="tag" data-text title={`${cell.pen.name} · ${cell.pen.label}${cell.pen.command ? ' · operator or automation demand, not a measured state' : ''}`}>{cell.name}</span>
          {#if cell.pen.command}<span class="badge">demand</span>{/if}
          {#if cell.pen.simulatorOnly}<span class="badge" title="Computed by the simulator only: no instrument of a real plant reads it">sim</span>{/if}
          <!-- OpenBridge's readout block and its unit on the row's line, as a drawing's value rows set them. -->
          <span class="reading" title={cell.value.text}>
            <obc-readout-block
              variant="value"
              size="small"
              alignment="left"
              hintedZeros={false}
              value={cell.value.value}
              valueType={typeof cell.value.value === 'string' ? 'text' : 'number'}
              dataQuality={cell.value.offScale === null ? undefined : 'low-integrity'}
              off={cell.value.value === null}
              offText="—"
              fractionDigits={cell.value.fractionDigits}
              maxDigits={cell.value.maxDigits}
            ></obc-readout-block>
            {#if cell.value.unit !== ''}<span class="unit">{cell.value.unit}</span>{/if}
          </span>
          {#if cell.inAlarm !== null}<AlarmChip threshold={cell.inAlarm} />{/if}
        {/if}
      {/each}
    </span>
    {#if line.note !== null && fit !== null && fit.note !== null}
      <span class="note" class:beyond={line.note.tone === 'beyond'} class:unmet={line.note.tone === 'unmet'} data-text title={line.note.title}>{line.note.forms[fit.note]}</span>
    {/if}
    {#if (line.bar !== null && fit?.bar) || (line.sparkline !== null && fit?.sparkline)}
      <!-- At the row's end: its bar, then its sparkline, each where its room allows. -->
      <span class="end">
        {#if line.bar !== null && fit?.bar}
          <obc-bar-horizontal
            class="bar"
            width={BAR.width}
            minValue={line.bar.min}
            maxValue={line.bar.max}
            value={line.bar.value}
            hasBar={true}
            hasScale={false}
            showLabels={false}
            barThickness={BAR.thickness}
            paddingLeft={0}
            paddingRight={0}
            advices={line.bar.advices}
            advicePosition="center"
          ></obc-bar-horizontal>
        {/if}
        {#if line.sparkline !== null && fit?.sparkline}
          <Sparkline
            pen={line.sparkline.pen}
            windowMs={FACEPLATE_SPARKLINE_MS}
            points={line.sparkline.points}
            {now}
            limit={line.sparkline.limit}
            inAlarm={line.sparkline.inAlarm}
            historyMissing={history.historyMissing.has(String(line.sparkline.pen.path))}
            historyError={history.historyErrors.get(String(line.sparkline.pen.path))}
          />
        {/if}
      </span>
    {/if}
  </li>
{:else if line.kind === 'rule'}
  <!-- An I&C trip acts: its row takes its alarm's colour, as its alarm row does. -->
  <li class="line" bind:clientWidth={room} title={`${line.title}${line.firstOut ? ' · first out' : ''}${decidingTitle === '' ? '' : ` · ${decidingTitle}`}`}>
    <span class="lead" bind:clientWidth={leadWidth}><obc-status-indicator class="rule" status={line.status}><span data-text>{line.title}{line.firstOut ? ' · 1st' : ''}</span></obc-status-indicator></span>
    {#if deciding.length > 0}<span class="deciding" data-text>· {deciding.join(' · ')}</span>{/if}
  </li>
{:else if line.kind === 'consequence'}
  <li class="line quiet" class:idle={line.idle} bind:clientWidth={room} title={line.title}><span data-text>{consequence}</span></li>
{:else if line.kind === 'flows'}
  <li class="line quiet"><span data-text title={line.parts.join(' · ')}>{line.parts.join(' · ')}</span></li>
{:else}
  <li class="line quiet" title={line.title}><span data-text>{line.text}</span></li>
{/if}

<style>
  .line { display: flex; align-items: center; gap: 6px; /* GAP */ height: var(--row); min-width: 0; white-space: nowrap; overflow: hidden; font-size: 12px; font-variant-numeric: tabular-nums; }
  .cells { flex: none; display: flex; align-items: center; gap: 5px; }
  .tag { font-size: 11.5px; color: var(--element-neutral-color); }
  .sep { color: var(--element-neutral-color); }
  .badge { flex: none; padding: 0 4px; border: 1px solid var(--border-outline-color); border-radius: 3px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  .reading { display: inline-flex; align-items: baseline; gap: 3px; }
  /* As a drawing's value row sets the unit after a readout block (MimicPanel), at the faceplate's size. */
  .unit { font-size: 12px; color: var(--element-neutral-color); }
  /* OpenBridge's indicator at a faceplate row's height: its 48 px box overlaps the rows by its padding, its label set as the row's text. */
  obc-status-indicator { display: block; margin: -10px -8px; --global-typography-ui-button-font-size: 12px; --global-typography-ui-button-line-height: 16px; --global-typography-ui-body-font-size: 12px; --global-typography-ui-body-line-height: 16px; }
  .note { flex: 0 1 auto; min-width: 0; font-size: 11px; color: var(--element-neutral-color); }
  .note.beyond { color: var(--alert-caution-color); font-weight: 600; }
  /* A safety function's criterion its reading does not meet: set apart by weight, its chip carries the colour. */
  .note.unmet { font-weight: 600; color: var(--element-active-color); }
  .end { flex: none; margin-left: auto; display: flex; align-items: center; gap: 6px; /* GAP */ }
  .bar { flex: none; display: block; }
  .lead { flex: none; display: flex; align-items: center; }
  .deciding { flex: 0 1 auto; min-width: 0; color: var(--element-neutral-color); }
  .quiet { color: var(--element-neutral-color); }
  /* Idle: faint, as an idle limit's label on a trend. */
  .idle { opacity: 0.6; }
</style>
