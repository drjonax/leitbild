<script lang="ts">
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import type { VignetteSection } from '../../../features/displays/compose/model.ts'
  import { alertDetail, alertIcon, sectionLines, UNACK_WORD, unacknowledged, wordsThatFit } from './alerts.ts'

  // A vignette's alerts (architecture B): the shared alert rows of its
  // objects, or of the whole Run, in the sample's order, one row each, with
  // OpenBridge's alert icon drawn steady: nothing here acknowledges until
  // W2.7, and a flash says "acknowledge me" (EEMUA 191, ISA-18.2), so the
  // word UNACK on the row and in the counts carries the state (register
  // deviation alert-icon-steady-unacknowledged); what does not fit its rows
  // is counted on the last. In a row only the message gives way, by whole
  // words (wordsThatFit), so the icon, UNACK, a FIRST OUT mark, the state and
  // the time are never cut; the full message stays in the row's title and in
  // its text for assistive technology.
  let { rows, section, room, members }: {
    rows: ReadonlyArray<AlertRow>
    /** Its objects (or the whole Run), and the elements or observables it narrows to. */
    section: Pick<Extract<VignetteSection, { kind: 'alerts' }>, 'objectIds' | 'elements' | 'refs'>
    /** A set's members now (the sample's), where the section lists a set's alerts. */
    members?: ReadonlyArray<string> | undefined
    /** The section's rows: one for its head, the rest for lines. */
    room: number
  } = $props()

  const shown = $derived(sectionLines(rows, section, Math.max(1, room - 1), members))
  const count = $derived(shown.lines.length + shown.more)

  /** A message as many of its whole words as its room shows, fitted again when its room or its text changes. */
  const fitted = (node: HTMLElement, text: string) => {
    let full = text
    const fit = (): void => {
      node.textContent = wordsThatFit(full, candidate => {
        node.textContent = candidate
        return node.scrollWidth <= node.clientWidth
      })
    }
    fit()
    const resized = new ResizeObserver(fit)
    resized.observe(node)
    return { update: (next: string) => { full = next; fit() }, destroy: () => resized.disconnect() }
  }
</script>

<section class="alerts" aria-label="Alerts">
  <h2>{section.objectIds === 'run' ? 'Alerts in the Run' : 'Alerts'} · {count === 0 ? 'none' : count}{#if shown.unacknowledged.all > 0}{' · '}<span class="unack">{shown.unacknowledged.all} {UNACK_WORD}</span>{/if}</h2>
  <ul>
    {#each shown.lines as line (line.row.key)}
      {@const icon = alertIcon(line.row)}
      <li title={`${line.row.objectLabel}: ${unacknowledged(line.row) ? `${UNACK_WORD} · ` : ''}${line.row.alert.message} · ${alertDetail(line.row)}`}>
        {#if 'type' in icon}
          <span class="icon"><obc-alert-icon alertType={icon.type} acknowledged={icon.acknowledged} active={icon.active}></obc-alert-icon></span>
        {:else}
          <span class="word">{icon.word}</span>
        {/if}
        {#if unacknowledged(line.row)}<span class="unack">{UNACK_WORD}</span>{/if}
        {#if line.heading !== undefined}<strong>{line.heading}</strong>{/if}
        {#if line.firstOut}<span class="mark">first out</span>{/if}
        <span class="message" aria-hidden="true" use:fitted={line.row.alert.message}></span>
        <span class="full">{line.row.alert.message}</span>
        <span class="detail">{alertDetail(line.row)}</span>
      </li>
    {/each}
  </ul>
  {#if shown.more > 0}<p class="more">+{shown.more} more{#if shown.unacknowledged.more > 0}, {shown.unacknowledged.more} {UNACK_WORD}{/if}</p>{/if}
</section>

<style>
  h2 { margin: 0; height: var(--row); line-height: var(--row); font-size: 12px; font-weight: 600; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { position: relative; display: flex; align-items: center; gap: 6px; height: var(--row); min-width: 0; white-space: nowrap; overflow: hidden; }
  .icon { flex: none; display: block; width: 20px; height: 20px; }
  .icon obc-alert-icon { display: block; width: 20px; height: 20px; }
  .word { flex: none; font-weight: 700; }
  strong, .mark, .unack { flex: none; }
  .mark, .unack { font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
  .unack { color: var(--element-active-color); }
  /* The one part that gives way: its room is what the others leave, and its words are fitted to it. */
  .message { flex: 1 1 0; min-width: 0; overflow: hidden; }
  .detail { flex: none; color: var(--element-neutral-color); }
  /* The whole message, read by assistive technology, not shown. */
  .full { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .more { margin: 0; height: var(--row); line-height: var(--row); color: var(--element-neutral-color); }
</style>
