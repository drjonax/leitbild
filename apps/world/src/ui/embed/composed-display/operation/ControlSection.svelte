<script lang="ts">
  import '@oicl/openbridge-webcomponents/dist/components/button/button.js'
  import '@oicl/openbridge-webcomponents/dist/components/progress-bar/progress-bar.js'
  import '@oicl/openbridge-webcomponents/dist/components/slide-button/slide-button.js'
  import '@oicl/openbridge-webcomponents/dist/components/toggle-button-group/toggle-button-group.js'
  import '@oicl/openbridge-webcomponents/dist/components/toggle-button-option/toggle-button-option.js'
  import type { ProcessVariableValue, VariablePath } from '../../../../packs/process-plant/graph/index.ts'
  import { runOnMount } from '../../../svelte-lifecycle.svelte.ts'
  import { commandPhase, SELECTION_TIMEOUT_MS, type ControlView, type ItemControlView, type OperationNow, type OptionView, type SentCommand } from './operation-presenter.ts'

  // An item's CONTROL section (plan §4.2): select a command, see World check
  // it on the exact payload (the I&C's refusal in its own words), what it
  // sets going and what works against it, then execute it by a button or, for
  // what sets a trip going, a slide. Only the selected control is expanded;
  // a selection lapses after 30 s without Execute. A protective pushbutton's
  // slide selects and executes at once, checked when the section opens
  // (QA-8). Feedback stays here: sent → accepted or refused → travelling →
  // done or not followed. Esc clears a selection before the popover closes.

  type Write = { readonly path: VariablePath; readonly value: ProcessVariableValue }
  type Check = { readonly accepted: true } | { readonly accepted: false; readonly reason: string }
  type Outcome = { readonly ok: true; readonly commandId?: string } | { readonly ok: false; readonly reason: string }

  let { view, now, validate, execute, draft = null, onSelected, acceptedAt }: {
    view: ItemControlView
    now: OperationNow
    /** World's control.validate on the exact payload. */
    validate: (write: Write) => Promise<Check>
    /** Issues the command through the one validated queued write path; resolves with the command result. */
    execute: (write: Write) => Promise<Outcome>
    /** A proposal used as a draft: preselected, as this person's own command. */
    draft?: Write | null
    /** What is selected, so the symbol shows it activated; null when nothing is. */
    onSelected?: (path: VariablePath | null) => void
    /** The plant time the Run accepted a command at, once the Plant's operations log has it: its travel is timed from then. */
    acceptedAt?: (commandId: string) => number | undefined
  } = $props()

  // Raw: each is replaced whole, and a command's result is matched to the command it answers by identity.
  let selection = $state.raw<{ readonly path: VariablePath; readonly key: string } | null>(null)
  let check = $state.raw<'checking' | Check | null>(null)
  // A protective pushbutton's check, by its option, made as the section opens.
  let standing = $state.raw<Readonly<Record<string, Check | 'checking'>>>({})
  let sent = $state.raw<(SentCommand & { readonly key: string; readonly commandId?: string }) | null>(null)
  let busy = $state(false)

  const keyOf = (write: Write): string => `${write.path}=${String(write.value)}`
  const selectedControl = $derived(selection === null ? undefined : view.controls.find(control => control.path === selection!.path))
  const selectedOption = $derived(selectedControl?.options.find(option => option.key === selection!.key))
  const sentControl = $derived(sent === null ? undefined : view.controls.find(control => control.path === sent!.path))
  const sentOption = $derived(sentControl?.options.find(option => option.key === sent!.key))
  // Timed from when the Run accepted it where the log says so, else from the sample it was sent at.
  const phase = $derived.by(() => {
    if (sent === null || sentControl === undefined || sentOption === undefined) return null
    const accepted = sent.commandId === undefined ? undefined : acceptedAt?.(sent.commandId)
    return commandPhase(sentControl, sentOption, accepted === undefined ? sent : { ...sent, sentAtElapsedMs: accepted }, now)
  })

  const writeOf = (control: ControlView, option: OptionView): Write => ({ path: control.path, value: option.value })

  const clear = (): void => {
    selection = null
    check = null
    onSelected?.(null)
  }

  const select = async (control: ControlView, option: OptionView): Promise<void> => {
    if (option.current || option.slideOnly) return
    selection = { path: control.path, key: option.key }
    onSelected?.(control.path)
    check = 'checking'
    const result = await validate(writeOf(control, option))
    // A newer selection, or none, makes this check moot.
    if (selection?.key === option.key) check = result
  }

  const run = async (control: ControlView, option: OptionView): Promise<void> => {
    if (busy) return
    busy = true
    const fromState = control.statePath === undefined ? undefined : now.read(control.statePath)
    const command: SentCommand & { readonly key: string } = { path: control.path, value: option.value, sentAtElapsedMs: now.elapsedMs, ...(fromState === undefined ? {} : { fromState }), key: option.key }
    sent = command
    clear()
    try {
      const result = await execute(writeOf(control, option))
      if (sent === command) sent = { ...command, result: result.ok ? { ok: true } : result, ...(result.ok && result.commandId !== undefined ? { commandId: result.commandId } : {}) }
    } catch (error) {
      if (sent === command) sent = { ...command, result: { ok: false, reason: error instanceof Error ? error.message : String(error) } }
    } finally {
      busy = false
    }
  }

  const checkProtective = async (control: ControlView, option: OptionView): Promise<void> => {
    standing = { ...standing, [option.key]: 'checking' }
    const result = await validate(writeOf(control, option))
    standing = { ...standing, [option.key]: result }
  }

  // The selection lapses after 30 s without Execute (select-before-operate).
  $effect(() => {
    if (selection === null) return
    const timer = setTimeout(clear, SELECTION_TIMEOUT_MS)
    return () => clearTimeout(timer)
  })

  runOnMount(() => {
    for (const control of view.controls) for (const option of control.options) if (option.slideOnly) void checkProtective(control, option)
    const drafted = draft === null ? undefined : view.controls.find(control => control.path === draft.path)
    const option = drafted?.options.find(candidate => candidate.key === keyOf(draft!))
    if (drafted !== undefined && option !== undefined) void select(drafted, option)
  })

  const keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || selection === null) return
    // The first Esc clears the selection; the next closes the popover.
    event.stopPropagation()
    clear()
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- While a command is selected, Esc clears it before it closes the popover (MimicPanel lets a section that claims Esc have it). -->
<section class="control" aria-label={`Control ${view.label}`} onkeydown={keydown} data-claims-escape={selection === null ? undefined : ''}>
  {#each view.controls as control (control.path)}
    {@const expanded = selection?.path === control.path}
    <div class="row" class:expanded>
      <div class="head">
        <span class="target">{control.target}</span>
        {#if control.now !== null}<span class="now">Now: {control.now}</span>{/if}
      </div>
      {#if control.form === 'twoState'}
        <obc-toggle-button-group
          value={expanded ? selection!.key : ''}
          externalControl={true}
          allowEmptySelection={true}
          ariaLabel={`Command ${control.target}`}
          onvalue={(event: CustomEvent<{ value: string }>) => {
            const option = control.options.find(candidate => candidate.key === event.detail.value)
            if (option !== undefined && option.key !== selection?.key) void select(control, option)
          }}
        >
          {#each control.options as option (option.key)}
            <obc-toggle-button-option value={option.key} disabled={option.current}>{option.word}</obc-toggle-button-option>
          {/each}
        </obc-toggle-button-group>
      {:else}
        {#each control.options as option (option.key)}
          {#if option.slideOnly}
            {@const ready = standing[option.key]}
            {@const ok = ready !== undefined && ready !== 'checking' && ready.accepted && option.heldBy === null && !busy}
            <!-- The slide's handle carries the word, so it has the track's length to travel; the line above names verb, tag and label (QA-7). -->
            <p class="slide-what">{option.action}</p>
            <obc-slide-button aria-label={option.action} disabled={!ok} onslide={() => { if (ok) void run(control, option) }}>
              <span slot="label">{option.word}</span>
            </obc-slide-button>
            {#if ready !== undefined && ready !== 'checking' && !ready.accepted}<p class="refused">{ready.reason}</p>{/if}
            {#each option.consequences as line (line)}<p class="consequence">{line}</p>{/each}
          {:else}
            <!-- An obc-button is a button: the native button inside it takes Enter and Space. -->
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <obc-button variant="normal" onclick={() => { void select(control, option) }}>{option.word}</obc-button>
          {/if}
        {/each}
      {/if}
      {#each control.withheldOptions as withheld (withheld.word)}<p class="withheld">{withheld.word} not offered: {withheld.reason}</p>{/each}
      {#if expanded && selectedOption !== undefined}
        {@const allowed = check !== null && check !== 'checking' && check.accepted && selectedOption.heldBy === null && !busy}
        <div class="selected">
          {#if check === 'checking'}<p class="checking">Checking with the I&amp;C…</p>
          {:else if check !== null && check.accepted}<p class="allowed">I&amp;C allows this command now</p>
          {:else if check !== null}<p class="refused">{check.reason}</p>{/if}
          {#if selectedOption.heldBy !== null}<p class="refused">{selectedOption.heldBy}</p>{/if}
          {#if selectedOption.isolated !== null}<p class="note">{selectedOption.isolated}</p>{/if}
          {#each selectedOption.consequences as line (line)}<p class="consequence">{line}</p>{/each}
          {#each selectedOption.opposing as line (line)}<p class="opposing">{line}</p>{/each}
          {#if selectedOption.confirm === 'slide'}
            <p class="slide-what">{selectedOption.action}</p>
            <obc-slide-button aria-label={selectedOption.action} disabled={!allowed} onslide={() => { if (allowed) void run(control, selectedOption) }}>
              <span slot="label">{selectedOption.word}</span>
            </obc-slide-button>
          {:else}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <obc-button variant="raised" disabled={!allowed} onclick={() => { if (allowed) void run(control, selectedOption) }}>{selectedOption.action}</obc-button>
          {/if}
        </div>
      {/if}
      {#if phase !== null && sent?.path === control.path}
        <div class={`feedback ${phase.kind}`} role="status">
          <span>{phase.text}</span>
          {#if phase.kind === 'travelling' && phase.fraction !== null}
            <obc-progress-bar type="linear" mode="determinate" value={Math.round(phase.fraction * 100)}></obc-progress-bar>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
  {#if view.auto.length > 0}
    <ul class="auto">{#each view.auto as line (line)}<li>{line}</li>{/each}</ul>
  {/if}
  {#if view.withheld.length > 0}
    <details class="withheld-list">
      <summary>Not operated here ({view.withheld.length})</summary>
      <ul>{#each view.withheld as entry (entry.name)}<li><span class="name">{entry.name}</span> {entry.reason}</li>{/each}</ul>
    </details>
  {/if}
</section>

<style>
  .control { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
  .row { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; border-bottom: 1px solid var(--border-divider-color); }
  .row:last-of-type { border-bottom: 0; }
  .head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
  .target { font-weight: 600; color: var(--element-active-color); }
  .now { color: var(--element-neutral-color); white-space: nowrap; }
  .selected { display: flex; flex-direction: column; gap: 3px; padding-left: 6px; border-left: 2px solid var(--border-outline-color); }
  p { margin: 0; }
  /* Neutral: the I&C allows it, which is no endorsement (QA-9). */
  .allowed, .checking, .note, .consequence, .opposing, .withheld { color: var(--element-neutral-color); }
  .refused { color: var(--element-active-color); font-weight: 600; }
  .slide-what { font-weight: 600; color: var(--element-active-color); }
  .feedback { display: flex; flex-direction: column; gap: 2px; color: var(--element-active-color); }
  .feedback.notFollowed, .feedback.refused { font-weight: 600; }
  .auto, .withheld-list ul { list-style: none; margin: 0; padding: 0; color: var(--element-neutral-color); }
  .withheld-list summary { cursor: pointer; color: var(--element-neutral-color); }
  .name { font-weight: 600; }
</style>
