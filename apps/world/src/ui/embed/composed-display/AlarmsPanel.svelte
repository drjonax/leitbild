<script lang="ts">
  import type { DisplayAnnunciation } from '../../../packs/process-plant/displays/annunciators.ts'
  import type { ComposedAlarmsPanel } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout, composedPanelHeight } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplayAlarm, ComposedDisplaySample } from './composed-display-client.ts'
  import { alarmAge, alertTypeOf, expectedAfter, firstOutFlag, visibleAlarms } from './panel-presenters.ts'

  // Filling a unit overview's narrow column, the list takes the height left
  // there: each alarm gets its whole title, over two lines where it needs
  // them, then its tag, flags and age, and as many show as that height holds.
  // Narrowed to one annunciator system, the list says so and always ends with
  // what the other systems hold. Each row is tagged as its limit is named on a
  // chip, a badge and a trend line ("LO-LO · RX TRIP"), or by what it does.
  let { panel, latest, annunciation, fill = false, only = null, showAll }: {
    panel: ComposedAlarmsPanel
    latest: ComposedDisplaySample | undefined
    annunciation: DisplayAnnunciation
    fill?: boolean
    /** `drawn`: whether the drawing beside the list shows anything of the system. */
    only?: { readonly name: string; readonly label: string; readonly ruleIds: ReadonlyArray<string>; readonly drawn: boolean } | null
    showAll?: () => void
  } = $props()

  /** A stacked row at its tallest (two title lines and its meta line) and the gap under it, and the title line with its gap (the CSS below). */
  const STACKED_PITCH = 53
  const TITLE = 17
  let height = $state<number>(composedDisplayLayout.alarms)
  // At its least height (composedDisplayLayout.alarms) the column's list holds two alarms.
  // Beside other panels it holds the rows compose gave it: fewer where a drawing took the room (panel.rows).
  const rows = $derived(fill ? Math.max(2, Math.floor((height - TITLE) / STACKED_PITCH)) : panel.rows)
  // Every alarm and trip has a tag, from what it annunciates; one the display was not compiled with says only its kind.
  const tagOf = (alarm: ComposedDisplayAlarm): string => annunciation.tags[alarm.id] ?? alarm.kind.toUpperCase()

  // An alarm the I&C declares expected after a first-out it followed (expectedAfter) is listed after the
  // others, faded and saying so ("after RX TRIP"), never left out: the first-out and its initiator lead.
  const expectedOf = (alarm: ComposedDisplayAlarm): string | null => expectedAfter(alarm, latest?.alarms ?? [], annunciation)
  const all = $derived.by(() => {
    const visible = visibleAlarms(latest?.alarms ?? [], panel.scope, panel.ruleIds, annunciation)
    return [...visible.filter(alarm => expectedOf(alarm) === null), ...visible.filter(alarm => expectedOf(alarm) !== null)]
  })
  const onlyRules = $derived(only === null ? null : new Set(only.ruleIds))
  const alarms = $derived(onlyRules === null ? all : all.filter(alarm => onlyRules.has(alarm.ruleId)))
  const elsewhere = $derived(onlyRules === null ? [] : all.filter(alarm => !onlyRules.has(alarm.ruleId)))
  // When some do not fit, the last row says how many and how many are unacknowledged; narrowed, a row is kept for the other systems.
  const room = $derived(rows - (elsewhere.length > 0 ? 1 : 0))
  const shown = $derived(alarms.length > room ? alarms.slice(0, Math.max(0, room - 1)) : alarms)
  const hidden = $derived(alarms.slice(shown.length))
  const unacknowledged = (list: ReadonlyArray<{ readonly acknowledged: boolean }>) => list.filter(alarm => !alarm.acknowledged).length
</script>

<section class="alarms" class:fill style={fill ? `min-height:${composedDisplayLayout.alarms}px` : `height:${composedPanelHeight({ kind: 'alarms', rows: panel.rows })}px`} bind:clientHeight={height} aria-label="Active alarms">
  {#if only !== null}
    <h2 class="narrowed" title={`${only.name}${only.drawn ? '' : ': none of its equipment is drawn here'}`}><span>{only.label} · {alarms.length} of {all.length}{only.drawn ? '' : ' · not drawn'}</span><button type="button" onclick={() => showAll?.()}>All ✕</button></h2>
  {:else}
    <h2>{panel.scope === 'related' ? 'Related active alarms' : 'Active alarms in this unit'}</h2>
  {/if}
  {#if latest?.alarms === undefined}
    <p class="empty">Alarm state not received yet.</p>
  {:else if alarms.length === 0 && elsewhere.length === 0}
    <p class="empty">{panel.scope === 'related' ? 'No active alarm or trip on the displayed signals.' : 'No active alarm or trip.'}</p>
  {:else}
    {#if alarms.length === 0}<p class="empty">No active alarm or trip in this system.</p>{/if}
    <ul>
      {#each shown as alarm (alarm.id)}
        {@const first = firstOutFlag(alarm, annunciation)}
        {#if fill}
          {@const after = expectedOf(alarm)}
          <li class={`alert-${alertTypeOf(alarm.severity)} stacked`} class:unacknowledged={!alarm.acknowledged} class:cleared={!alarm.active} class:expected={after !== null}>
            <span class="title" title={alarm.title}>{alarm.title}</span>
            <span class="meta"><span class="kind">{tagOf(alarm)}</span><span class="flags">{#if after !== null}<span class="flag">after {after}</span>{/if}{#if !alarm.active}<span class="flag">cleared</span>{/if}{#if first !== null}<span class="flag">{first}</span>{/if}{#if !alarm.acknowledged}<span class="flag">unack</span>{/if}<span class="age">{alarmAge(latest.plantElapsedMs, alarm.firstActiveElapsedMs)}</span></span></span>
          </li>
        {:else}
          {@const after = expectedOf(alarm)}
          <li class={`alert-${alertTypeOf(alarm.severity)}`} class:unacknowledged={!alarm.acknowledged} class:cleared={!alarm.active} class:expected={after !== null}>
            <span class="kind">{tagOf(alarm)}</span>
            <span class="title" title={alarm.title}>{alarm.title}</span>
            {#if after !== null}<span class="flag">after {after}</span>{/if}
            {#if !alarm.active}<span class="flag">cleared</span>{/if}
            {#if first !== null}<span class="flag">{first}</span>{/if}
            {#if !alarm.acknowledged}<span class="flag">unack</span>{/if}
            <span class="age">{alarmAge(latest.plantElapsedMs, alarm.firstActiveElapsedMs)}</span>
          </li>
        {/if}
      {/each}
    </ul>
    {#if hidden.length > 0}<p class="more">+{hidden.length} more{#if unacknowledged(hidden) > 0}{' '}({unacknowledged(hidden)} unacknowledged){/if}</p>{/if}
    {#if elsewhere.length > 0}
      <!-- Never hidden by the filter: what the other systems hold, in the colour of the worst of it. -->
      <p class={`more elsewhere alert-${alertTypeOf(elsewhere[0]!.severity)}`}>+{elsewhere.length} in other systems{#if unacknowledged(elsewhere) > 0}{' '}({unacknowledged(elsewhere)} unacknowledged){/if}</p>
    {/if}
  {/if}
</section>

<style>
  .alarms { display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
  .alarms.fill { flex: 1 1 auto; }
  /* At most three lines of 17 px (STACKED_PITCH with the list's gap): the whole title across the row, over two lines where it needs them, never cut; then tag, flags and age. */
  li.stacked { display: flex; flex-direction: column; align-items: stretch; justify-content: center; gap: 0; height: auto; min-height: 38px; padding-top: 2px; padding-bottom: 2px; }
  li.stacked .title { white-space: normal; line-height: 17px; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  li.stacked .meta { display: flex; justify-content: space-between; align-items: center; gap: 8px; height: 17px; }
  li.stacked .flags { display: flex; align-items: center; gap: 8px; }
  h2 { margin: 0; font-size: 11px; font-weight: 600; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li { display: flex; align-items: center; gap: 8px; min-width: 0; height: 21px; padding: 0 6px; border-left: 4px solid var(--border-divider-color); background: var(--container-section-color); font-size: 12px; }
  /* Alarm colour appears only for real alarms, keyed by severity (alertTypeOf); a cleared one keeps it, dimmed, until acknowledged. */
  li.alert-alarm, .elsewhere.alert-alarm { border-left-color: var(--alert-alarm-color); }
  li.alert-warning, .elsewhere.alert-warning { border-left-color: var(--alert-warning-color); }
  li.alert-caution, .elsewhere.alert-caution { border-left-color: var(--alert-caution-color); }
  li.unacknowledged .title { font-weight: 600; }
  li.cleared .title { color: var(--element-neutral-color); }
  /* Expected after a first-out it followed: its alarm colour and text faded, its row still listed. */
  li.expected { opacity: 0.6; }
  li.expected .title { font-weight: 400; }
  .elsewhere { margin: 0; padding: 2px 6px; border-left: 4px solid var(--border-divider-color); background: var(--container-section-color); }
  h2.narrowed { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--element-active-color); }
  h2.narrowed span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  h2 button { font: inherit; font-size: 11px; text-transform: none; letter-spacing: 0; padding: 0 6px; border: 1px solid var(--border-outline-color); border-radius: 3px; background: var(--container-section-color); color: var(--element-active-color); cursor: pointer; }
  /* The tag names the limit or action whole; it is never cut. */
  .kind { font-size: 10.5px; font-weight: 700; min-width: 32px; flex: none; white-space: nowrap; }
  .title { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .flag { font-size: 10.5px; color: var(--element-neutral-color); flex: none; }
  .age { font-size: 11px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; flex: none; }
  .empty, .more { margin: 2px 0; font-size: 12px; color: var(--element-neutral-color); }
</style>
