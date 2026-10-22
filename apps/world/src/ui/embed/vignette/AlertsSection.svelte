<script lang="ts">
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import type { VignetteSection } from '../../../features/displays/compose/model.ts'
  import { alertDetail, alertIcon, sectionLines, UNACK_WORD, unacknowledged } from './alerts.ts'

  // A vignette's alerts (architecture B): the shared alert rows of its
  // objects, or of the whole Run, in the sample's order, one row each, with
  // OpenBridge's alert icon drawn steady: nothing here acknowledges until
  // W2.7, and a flash says "acknowledge me" (EEMUA 191, ISA-18.2), so the
  // word UNACK on the row and in the counts carries the state (register
  // deviation alert-icon-steady-unacknowledged); what does not fit its rows
  // is counted on the last.
  let { rows, section, room }: {
    rows: ReadonlyArray<AlertRow>
    /** Its objects (or the whole Run), and the elements or observables it narrows to. */
    section: Pick<Extract<VignetteSection, { kind: 'alerts' }>, 'objectIds' | 'elements' | 'refs'>
    /** The section's rows: one for its head, the rest for lines. */
    room: number
  } = $props()

  const shown = $derived(sectionLines(rows, section, Math.max(1, room - 1)))
  const count = $derived(shown.lines.length + shown.more)
</script>

<section class="alerts" aria-label="Alerts">
  <h2>{section.objectIds === 'run' ? 'Alerts in the Run' : 'Alerts'} · {count === 0 ? 'none' : count}{#if shown.unacknowledged.all > 0}{' · '}<span class="unack">{shown.unacknowledged.all} {UNACK_WORD}</span>{/if}</h2>
  <ul>
    {#each shown.lines as line (line.row.key)}
      {@const icon = alertIcon(line.row)}
      <li title={`${line.row.objectLabel}: ${line.row.alert.message} · ${alertDetail(line.row)}`}>
        {#if 'type' in icon}
          <span class="icon"><obc-alert-icon alertType={icon.type} acknowledged={icon.acknowledged} active={icon.active}></obc-alert-icon></span>
        {:else}
          <span class="word">{icon.word}</span>
        {/if}
        {#if unacknowledged(line.row)}<span class="unack">{UNACK_WORD}</span>{/if}
        {#if line.heading !== undefined}<strong>{line.heading}</strong>{/if}
        {#if line.firstOut}<span class="mark">first out</span>{/if}
        <span class="message">{line.row.alert.message}</span>
        <span class="detail">{alertDetail(line.row)}</span>
      </li>
    {/each}
  </ul>
  {#if shown.more > 0}<p class="more">+{shown.more} more{#if shown.unacknowledged.more > 0}, {shown.unacknowledged.more} {UNACK_WORD}{/if}</p>{/if}
</section>

<style>
  h2 { margin: 0; height: var(--row); line-height: var(--row); font-size: 12px; font-weight: 600; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 6px; height: var(--row); min-width: 0; white-space: nowrap; overflow: hidden; }
  .icon { flex: none; display: block; width: 20px; height: 20px; }
  .icon obc-alert-icon { display: block; width: 20px; height: 20px; }
  .word { flex: none; font-weight: 700; }
  strong, .mark, .unack { flex: none; }
  .mark, .unack { font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
  .unack { color: var(--element-active-color); }
  .message { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .detail { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--element-neutral-color); }
  .more { margin: 0; height: var(--row); line-height: var(--row); color: var(--element-neutral-color); }
</style>
