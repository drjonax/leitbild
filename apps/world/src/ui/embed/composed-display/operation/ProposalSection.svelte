<script lang="ts">
  import '@oicl/openbridge-webcomponents/dist/components/button/button.js'
  import '@oicl/openbridge-webcomponents/dist/components/slide-button/slide-button.js'
  import '@oicl/openbridge-webcomponents/dist/components/text-input-field/text-input-field.js'
  import type { ComposedDisplayPen } from '../../../../packs/process-plant/displays/compose.ts'
  import type { TrendPoint } from '../../../../packs/process-plant/displays/trend-reading.ts'
  import Sparkline from '../Sparkline.svelte'
  import type { ProposalCard } from './operation-presenter.ts'

  // A proposal's approval card, first in its item's popover while pending
  // (plan §4.4, QA-9): the exact command World stored, from → to, who
  // proposed it and why in their own quoted words, what the I&C says of it
  // now (neutral, no tick), each cited reading then → now with its history,
  // World's margins soonest first, the expected response and whether it can
  // be undone, and the fixed expiry with one explicit extension. Approve and
  // Reject carry equal weight and neither takes focus; Approve names verb, tag
  // and label, and is a slide where the command sets a trip going.

  type Outcome = { readonly ok: true } | { readonly ok: false; readonly reason: string }

  let { card, histories = {}, approve, reject, extend, useAsDraft }: {
    card: ProposalCard
    /** Each cited reading's pen and recorded history, where the display has them, for its sparkline. */
    histories?: Readonly<Record<string, { readonly pen: ComposedDisplayPen; readonly points: ReadonlyArray<TrendPoint>; readonly windowMs: number; readonly now: number }>>
    approve: () => Promise<Outcome>
    reject: (reason: string | null) => Promise<Outcome>
    extend: () => Promise<Outcome>
    /** Copies the command into CONTROL as this person's own selection. */
    useAsDraft: () => void
  } = $props()

  let reason = $state('')
  let busy = $state(false)
  let outcome = $state<string | null>(null)

  const decide = async (what: string, act: () => Promise<Outcome>): Promise<void> => {
    if (busy) return
    busy = true
    outcome = null
    try {
      const result = await act()
      outcome = result.ok ? null : `${what} refused: ${result.reason}`
    } catch (error) {
      outcome = `${what} could not be sent: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      busy = false
    }
  }

  const open = $derived(card.status === 'pending' || card.status === 'blocked')
  const left = $derived(card.expires === null ? '' : `${Math.floor(card.expires.inMs / 60_000)}:${String(Math.floor((card.expires.inMs % 60_000) / 1_000)).padStart(2, '0')}`)
</script>

<section class="proposal" class:closed={!open} aria-label={`Proposal: ${card.action}`}>
  <header>
    <span class="who">{card.proposer}</span>
    {#if card.expires !== null}<span class="expires">expires {card.expires.at} ({left} left)</span>{/if}
  </header>
  <p class="action">{card.action}</p>
  {#if open && (card.from !== null || card.to !== null)}<p class="change">{card.from ?? '—'} → {card.to ?? '—'}</p>{/if}
  <blockquote>
    <span class="label">Why ({card.proposerOrigin === 'ai' ? 'AI' : 'operator'}):</span> “{card.reason}”
    {#if card.procedureStep !== undefined}<span class="step">{card.procedureStep}</span>{/if}
  </blockquote>
  {#if open}<p class="checked" class:refused={!card.checked.permitted}>{card.checked.text}</p>{/if}
  {#if card.changed}<p class="changed">Plant changed since proposed</p>{/if}
  <ul class="evidence" aria-label="Cited readings">
    {#each card.evidence as entry (entry.tagId)}
      {@const history = histories[entry.tagId]}
      <li>
        <span class="tag">{entry.tagId}</span>
        <span class="values" class:changed={entry.changed}>{entry.then}{#if entry.changed} → {entry.now}{/if}</span>
        {#if history !== undefined}<Sparkline pen={history.pen} windowMs={history.windowMs} points={history.points} now={history.now} limit={null} inAlarm={null} historyMissing={false} historyError={undefined} />{/if}
      </li>
    {/each}
  </ul>
  {#each card.margins as margin (margin.tagId)}<p class="margin">{margin.tagId}: {margin.text}</p>{/each}
  <p class="expected">Expected: {card.expected}</p>
  {#each card.consequences as line (line)}<p class="consequence">{line}</p>{/each}
  {#each card.opposing as line (line)}<p class="opposing">{line}</p>{/each}
  <p class="reversibility">{card.reversibility}</p>
  {#if open && card.approve !== null}
    <!-- What Approve executes, in full (QA-7): verb, tag and label, and whether the plant changed since it was proposed. -->
    <p class="approve-what">{card.approve.label}</p>
    <div class="decisions">
      {#if card.approve.confirm === 'slide'}
        <!-- The slide's handle says Approve, so it has the track's length to travel; its name says what it approves. -->
        <obc-slide-button aria-label={card.approve.label} disabled={busy || !card.approve.enabled} onslide={() => { if (card.approve?.enabled) void decide('Approval', approve) }}>
          <span slot="label">Approve</span>
        </obc-slide-button>
      {:else}
        <!-- An obc-button is a button: the native button inside it takes Enter and Space. -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <obc-button variant="normal" aria-label={card.approve.label} disabled={busy || !card.approve.enabled} onclick={() => { if (card.approve?.enabled) void decide('Approval', approve) }}>Approve</obc-button>
      {/if}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <obc-button variant="normal" disabled={busy} onclick={() => { void decide('Rejection', () => reject(reason.trim() === '' ? null : reason.trim())) }}>Reject</obc-button>
    </div>
    <obc-text-input-field label="Reason to reject (optional)" maxlength={300} value={reason} onchange={(event: Event) => { reason = (event.currentTarget as HTMLElement & { value: string }).value }}></obc-text-input-field>
    <div class="secondary">
      {#if card.extendable}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <obc-button variant="flat" disabled={busy} onclick={() => { void decide('Extension', extend) }}>Extend once</obc-button>
      {/if}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <obc-button variant="flat" disabled={busy} onclick={useAsDraft}>Use as draft</obc-button>
    </div>
  {/if}
  {#if card.closed !== null}<p class="closed-text">{card.closed}</p>{/if}
  {#if outcome !== null}<p class="refused" role="status">{outcome}</p>{/if}
</section>

<style>
  .proposal { display: flex; flex-direction: column; gap: 4px; font-size: 12px; padding: 6px 0; border-bottom: 1px solid var(--border-divider-color); }
  header { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; color: var(--element-neutral-color); }
  .approve-what { font-weight: 600; color: var(--element-active-color); }
  p { margin: 0; }
  .action { font-weight: 700; color: var(--element-active-color); }
  .change, .margin, .expected, .consequence, .opposing, .reversibility, .closed-text { color: var(--element-neutral-color); }
  blockquote { margin: 0; padding-left: 6px; border-left: 2px solid var(--border-outline-color); }
  .label, .step { color: var(--element-neutral-color); }
  .step { display: block; }
  /* What the I&C says, in plain words: allowed reads as plainly as refused (QA-9). */
  .checked { color: var(--element-active-color); }
  .refused, .changed { font-weight: 600; color: var(--element-active-color); }
  .evidence { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .evidence li { display: flex; align-items: center; gap: 8px; }
  .tag { font-weight: 600; min-width: 96px; }
  .values { font-variant-numeric: tabular-nums; }
  .values.changed { font-weight: 600; }
  /* Equal weight: the same variant and width, neither focused first (QA-9). */
  .decisions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .secondary { display: flex; gap: 6px; }
  .closed .action { color: var(--element-neutral-color); }
</style>
