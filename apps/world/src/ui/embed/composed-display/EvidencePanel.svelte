<script lang="ts">
  import type { ComposedDisplayPen, ComposedEvidencePanel, ComposedEvidenceRow } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout, type DisplayEvidenceKind } from '../../../packs/process-plant/displays/composition.ts'
  import { offScale, readingValueText, shownReading, unitLabel } from '../../../packs/process-plant/displays/display-text.ts'
  import { readingStateText, trendReading } from '../../../packs/process-plant/displays/trend-reading.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { sampledGates } from './panel-presenters.ts'
  import AlarmChip from './AlarmChip.svelte'

  // What World added to an agent's display, one line per row of values read
  // together (the wide-range level of every steam generator, a valve's
  // position beside its demand): why in a word, the values, and what the row
  // says beside them. A row of one value words its limit state as a legend
  // does; a row of several marks each value past a limit or off its span.
  let { panel, latest, activeRuleIds }: {
    panel: ComposedEvidencePanel
    latest: ComposedDisplaySample | undefined
    activeRuleIds: ReadonlySet<string>
  } = $props()

  const WORDS: Readonly<Record<DisplayEvidenceKind, string>> = {
    cause: 'cause',
    isolation: 'isolation',
    wider: 'wider span',
    delivers: 'delivers',
    trip: 'trip check',
    program: 'program',
    isolates: 'isolates',
    reference: 'reference',
    mode: 'mode watch',
    flow: 'flow',
  }

  interface ItemReading {
    readonly text: string
    readonly unit: string
    readonly state: string
    readonly offSpan: boolean
    readonly beyond: boolean
    readonly inAlarm: ReturnType<typeof trendReading>['inAlarm']
  }

  // A value as its row reads it now: as a readout shows it, "<0" at an end of its span, a state as on or off.
  const readingOf = (pen: ComposedDisplayPen): ItemReading => {
    const raw = latest?.values.find(entry => entry.path === String(pen.path))?.value
    if (typeof raw === 'boolean') return { text: raw ? 'ON' : 'OFF', unit: '', state: '', offSpan: false, beyond: false, inAlarm: null }
    if (typeof raw !== 'number') return { text: '—', unit: '', state: '', offSpan: false, beyond: false, inAlarm: null }
    const value = shownReading(raw, pen.resolution)
    const span = pen.limits?.instrumentSpan
    const reading = trendReading({ value, points: null, windowMs: 0, unit: pen.unit, thresholds: pen.thresholds, mode: latest?.mode, gates: sampledGates(latest), activeRuleIds, resolution: pen.resolution, ...(span === undefined ? {} : { span }) })
    // A row says what limits act on its value, not that it has none.
    const limit = reading.limit === null || reading.limit.kind === 'unlimited' || reading.limit.kind === 'idle' ? null : reading.limit
    return {
      text: readingValueText(value, pen.unit, pen.resolution, span),
      unit: unitLabel(pen.unit),
      state: readingStateText({ offScale: reading.offScale, limit }, pen.unit, pen.resolution),
      offSpan: offScale(value, span) !== null,
      beyond: reading.offScale !== null || reading.limit?.kind === 'past',
      inAlarm: reading.inAlarm,
    }
  }

  // One unit after the last value where every value shares it ("SG A 28.5 · SG B 28.5 kg/s"), else after each, as
  // beside a demand ("35.0 % · 0 % DEMAND").
  const sharedUnit = (row: ComposedEvidenceRow): boolean => new Set(row.items.map(item => unitLabel(item.pen.unit))).size === 1 && !row.items.some(item => item.pen.command)
  const rowText = (row: ComposedEvidenceRow, readings: ReadonlyArray<ItemReading>): string => [
    WORDS[row.kind].toUpperCase(),
    row.name,
    row.items.map((item, at) => `${item.label} ${readings[at]!.text}${readings[at]!.unit === '' ? '' : ` ${readings[at]!.unit}`}${item.pen.command ? ' demand' : ''}${item.pen.simulatorOnly ? ' sim' : ''}`).join(' · '),
    row.items.length === 1 ? readings[0]!.state : '',
    row.note ?? '',
  ].filter(part => part !== '').join('  ')
</script>

<!-- The line over values World added to an agent's display (composedDisplayLayout.evidenceCaption), then a line per row (evidenceRow). -->
<section aria-label="Added by World">
  <h2 style={`height:${composedDisplayLayout.evidenceCaption}px`}><span>Added from the Plant model</span></h2>
  <ul style={`grid-auto-rows:${composedDisplayLayout.evidenceRow}px`}>
    {#each panel.rows as row, rowIndex (rowIndex)}
      {@const readings = row.items.map(item => readingOf(item.pen))}
      {@const unitOnce = sharedUnit(row)}
      <li title={`${rowText(row, readings)}\nAdded by World from the Plant model: ${row.reason}`}>
        <span class="why">{WORDS[row.kind]}</span>
        {#if row.name !== ''}<span class="name">{row.name}</span>{/if}
        {#each row.items as item, at (item.pen.path)}
          {@const reading = readings[at]!}
          <span class="item">
            <span class="label" class:tag={item.pen.tagId === item.label}>{item.label}</span>
            <span class="value" class:beyond={reading.beyond} class:offspan={reading.offSpan}>{reading.text}</span>
            {#if reading.unit !== '' && (!unitOnce || at === row.items.length - 1)}<span class="unit">{reading.unit}</span>{/if}
            {#if item.pen.command}<span class="demand">demand</span>{/if}
            {#if item.pen.simulatorOnly}<span class="demand" title="Computed by the simulator only: no instrument of a real plant reads it">sim</span>{/if}
            {#if reading.inAlarm !== null && row.items.length > 1}<AlarmChip threshold={reading.inAlarm} compact />{/if}
          </span>
        {/each}
        {#if row.items.length === 1}
          {#if readings[0]!.inAlarm !== null}<AlarmChip threshold={readings[0]!.inAlarm} />{/if}
          {#if readings[0]!.state !== ''}<span class="state" class:beyond={readings[0]!.beyond}>{readings[0]!.state}</span>{/if}
        {/if}
        {#if row.note !== undefined}<span class="note">{row.note}</span>{/if}
      </li>
    {/each}
  </ul>
</section>

<style>
  h2 { margin: 0; font-size: 11px; line-height: 12px; font-weight: 600; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; overflow: hidden; }
  /* One line each, cut at its end where it is too long: the tooltip has all of it. A dashed rule: added by World, never an alarm colour. */
  li { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 0 8px; border-left: 2px dashed var(--border-divider-color); white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums; }
  .why { flex: none; padding: 0 4px; border: 1px dashed var(--border-outline-color); border-radius: 3px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--element-neutral-color); }
  .name, .label, .unit { font-size: 11.5px; color: var(--element-neutral-color); }
  .name { flex: none; }
  .item { flex: none; display: inline-flex; align-items: baseline; gap: 4px; }
  .value { font-size: 13px; font-weight: 700; color: var(--element-active-color); }
  .value.beyond, .state.beyond { color: var(--alert-caution-color); }
  /* A reading at an end of its instrument's span is no value: drawn as low integrity. */
  .value.offspan { font-weight: 400; font-style: italic; }
  .demand { padding: 0 4px; border: 1px solid var(--border-outline-color); border-radius: 3px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  .state { font-size: 11px; color: var(--element-neutral-color); overflow: hidden; text-overflow: ellipsis; }
  .note { min-width: 0; font-size: 11px; color: var(--element-neutral-color); overflow: hidden; text-overflow: ellipsis; }
</style>
