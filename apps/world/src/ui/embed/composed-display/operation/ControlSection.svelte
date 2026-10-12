<script lang="ts">
  import '@oicl/openbridge-webcomponents/dist/components/button/button.js'
  import '@oicl/openbridge-webcomponents/dist/components/progress-bar/progress-bar.js'
  import '@oicl/openbridge-webcomponents/dist/components/slide-button/slide-button.js'
  import '@oicl/openbridge-webcomponents/dist/components/slider/slider.js'
  import '@oicl/openbridge-webcomponents/dist/icons/icon-chevron-left-google.js'
  import '@oicl/openbridge-webcomponents/dist/icons/icon-chevron-right-google.js'
  import '@oicl/openbridge-webcomponents/dist/components/toggle-button-group/toggle-button-group.js'
  import '@oicl/openbridge-webcomponents/dist/components/toggle-button-option/toggle-button-option.js'
  import type { ProcessVariableValue, VariablePath } from '../../../../packs/process-plant/graph/index.ts'
  import { runOnMount } from '../../../svelte-lifecycle.svelte.ts'
  import { commandPhase, optionOf, SELECTION_TIMEOUT_MS, type ControlView, type DemandView, type ItemControlView, type OperationNow, type OptionView, type SentCommand } from './operation-presenter.ts'

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
  let selection = $state.raw<{ readonly path: VariablePath; readonly key: string; readonly value: ProcessVariableValue } | null>(null)
  // A demand control's slider while it is moved, as a person reads it (%), before it is let go and selected.
  let moving = $state.raw<{ readonly path: VariablePath; readonly shown: number } | null>(null)
  let check = $state.raw<'checking' | Check | null>(null)
  // A protective pushbutton's check, by its option, made as the section opens.
  let standing = $state.raw<Readonly<Record<string, Check | 'checking'>>>({})
  let sent = $state.raw<(SentCommand & { readonly key: string; readonly commandId?: string }) | null>(null)
  let busy = $state(false)

  /** A demand control's setting from where its slider stands (%), on its step, in the command's unit. */
  const settingAt = (demand: DemandView, shown: number): number => {
    const share = (shown - demand.shown.min) / (demand.shown.max - demand.shown.min)
    const steps = Math.round((share * (demand.max - demand.min)) / demand.step)
    return Number(Math.min(demand.max, Math.max(demand.min, demand.min + steps * demand.step)).toPrecision(12))
  }
  const shownAt = (demand: DemandView, value: number): number =>
    Number((demand.shown.min + ((value - demand.min) / (demand.max - demand.min)) * (demand.shown.max - demand.shown.min)).toPrecision(12))
  const selectSetting = (control: ControlView, demand: DemandView, shown: number): void => {
    moving = null
    const option = optionOf(control, settingAt(demand, shown))
    if (option !== undefined && option.key !== selection?.key) void select(control, option)
  }
  const selectedControl = $derived(selection === null ? undefined : view.controls.find(control => control.path === selection!.path))
  // Read from the control as it stands now: a demand setting between its ends is an option of its own (optionOf).
  const selectedOption = $derived(selectedControl === undefined || selection === null ? undefined : optionOf(selectedControl, selection.value))
  const sentControl = $derived(sent === null ? undefined : view.controls.find(control => control.path === sent!.path))
  const sentOption = $derived(sentControl === undefined || sent === null ? undefined : optionOf(sentControl, sent.value))
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
    selection = { path: control.path, key: option.key, value: option.value }
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
    const option = drafted === undefined ? undefined : optionOf(drafted, draft!.value)
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
        {#if control.now !== null}<span class="now">Now: {control.now}{#if control.commanded !== null} · {control.commanded}{/if}</span>{/if}
      </div>
      {#each control.throttled as line (line)}<span class="throttled">{line}</span>{/each}
      {#if control.form === 'demand' && control.demand !== undefined}
        {@const demand = control.demand}
        {@const shut = control.options.find(option => option.value === demand.min)}
        {@const open = control.options.find(option => option.value === demand.max)}
        {@const pending = moving?.path === control.path ? moving.shown : expanded && typeof selection?.value === 'number' ? shownAt(demand, selection.value) : shownAt(demand, demand.setting)}
        <!-- A demand on its 1 % grid: SHUT and OPEN at its ends, the slider (or its step buttons, or the arrow keys) between; let go, the setting is selected. -->
        <div class="demand">
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          {#if shut !== undefined}<obc-button variant="normal" disabled={shut.current} onclick={() => { void select(control, shut) }}>{shut.word}</obc-button>{/if}
          <obc-slider
            class="slider"
            min={demand.shown.min}
            max={demand.shown.max}
            step={demand.shown.step}
            stepClick={demand.shown.step}
            value={pending}
            hasLeftIcon={true}
            hasRightIcon={true}
            decrementLabel={`${control.target}: ${demand.shown.step} ${demand.shown.unit} less`}
            incrementLabel={`${control.target}: ${demand.shown.step} ${demand.shown.unit} more`}
            aria-label={`Set ${control.target}`}
            onvalue={(event: CustomEvent<number>) => { moving = { path: control.path, shown: event.detail } }}
            onchange={(event: CustomEvent<number>) => selectSetting(control, demand, event.detail)}
          ><obi-chevron-left-google slot="icon-left"></obi-chevron-left-google><obi-chevron-right-google slot="icon-right"></obi-chevron-right-google></obc-slider>
          <span class="setting">{Math.round(pending)} {demand.shown.unit}</span>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          {#if open !== undefined}<obc-button variant="normal" disabled={open.current} onclick={() => { void select(control, open) }}>{open.word}</obc-button>{/if}
        </div>
      {:else if control.form === 'twoState'}
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
  {#if view.controls.length === 0 && view.position !== null}<p class="now">Position {view.position}</p>{/if}
  {#if view.auto.length > 0}
    <!-- What a controller holds, read-only, and what operating it by hand would take. -->
    <ul class="auto">{#each view.auto as line (line.text)}<li><span class="auto-line">{line.text}</span> <span class="manual">{line.manual}</span></li>{/each}</ul>
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
  .demand { display: flex; align-items: center; gap: 6px; }
  .demand .slider { flex: 1 1 auto; min-width: 0; }
  .setting { flex: none; min-width: 40px; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--element-active-color); }
  .auto-line { color: var(--element-active-color); }
  /* A person's setting under a standing actuation: said plainly, never in an alarm colour. */
  .throttled { align-self: flex-start; padding: 0 6px; border: 1px solid var(--border-outline-color); border-radius: 3px; font-size: 11px; line-height: 16px; font-weight: 600; color: var(--element-active-color); }
  .manual { color: var(--element-neutral-color); }
  .feedback { display: flex; flex-direction: column; gap: 2px; color: var(--element-active-color); }
  .feedback.notFollowed, .feedback.refused { font-weight: 600; }
  .auto, .withheld-list ul { list-style: none; margin: 0; padding: 0; color: var(--element-neutral-color); }
  .withheld-list summary { cursor: pointer; color: var(--element-neutral-color); }
  .name { font-weight: 600; }
</style>
