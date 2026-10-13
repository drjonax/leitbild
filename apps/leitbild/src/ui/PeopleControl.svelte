<script lang="ts">
  // The Run bar's people control (UX SPEC §3–§5, §8): who else is in this Run,
  // my name, earlier chats, and one calm toast for a new message. A popover at
  // ≥ 640 px and a modal sheet below, as WorkspaceSwitcher. Clicks inside the
  // World and Agents iframes never reach this document, so the popover also
  // closes when the window loses focus.
  import { tick, untrack } from 'svelte'
  import Icon from './Icon.svelte'
  import PersonAvatar from './PersonAvatar.svelte'
  import { switcherKeyTarget } from './workspace-switcher.ts'
  import {
    badgeText, isDefaultName, NAME_TEXT, nameCounterText, nameProblem, normaliseName, pillText, previewText, rowLabel, STORAGE_BLOCKED_TEXT,
    triggerLabel, type TriggerMode,
  } from './people-format.ts'
  import type { PeopleSession, PeopleState, PersonView } from './people-session.ts'
  import type { PersonWire } from './people-wire.ts'

  /** The bar shows up to three faces, then "+N". */
  const STACK_MAX = 3
  /** The toast hides itself after this, unless hovered or focused. */
  const TOAST_VISIBLE_MS = 8_000
  /** "Saved." replaces the meta line this long. */
  const SAVED_FLASH_MS = 2_000
  /** "Link copied." stays this long. */
  const COPY_STATUS_MS = 4_000
  const POPOVER_WIDTH_PX = 320
  const VIEWPORT_GUTTER_PX = 12
  const POPOVER_GAP_PX = 8

  let { session, people, runUrl, runId, onOpenChat }: {
    session: PeopleSession
    people: PeopleState
    /** The shareable link to this Run (Workspaces are public). */
    runUrl: string
    /** A different Run closes the popover. */
    runId: string
    /** Opens the chat with this person and puts focus in its composer. */
    onOpenChat: (person: PersonWire) => void
  } = $props()

  const uid = `people-${Math.random().toString(36).slice(2, 8)}`
  const narrowQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 639px)') : null
  let narrow = $state(narrowQuery?.matches ?? false)
  $effect(() => {
    if (!narrowQuery) return
    const update = (): void => { narrow = narrowQuery.matches }
    narrowQuery.addEventListener('change', update)
    return () => narrowQuery.removeEventListener('change', update)
  })

  let open = $state(false)
  let wrap = $state<HTMLElement | null>(null)
  let trigger = $state<HTMLButtonElement | null>(null)
  let pop = $state<HTMLElement | null>(null)
  let sheet = $state<HTMLDialogElement | null>(null)
  let body = $state<HTMLElement | null>(null)
  let place = $state('')

  const mode: TriggerMode = $derived(people.status === 'failed' ? 'unavailable'
    : people.notice !== 'none' ? 'reconnecting'
    : !people.presentKnown ? 'loading' : 'live')
  const others = $derived(people.present)
  const shown = $derived(others.slice(0, STACK_MAX))
  const extra = $derived(others.length - shown.length)
  const label = $derived(triggerLabel(mode, others.length, people.unreadTotal))
  const showPeople = $derived(people.presentKnown && mode !== 'unavailable')

  /** Lets the chat return focus here when it closes. */
  export function focusTrigger(): void { trigger?.focus() }

  // --- popover ------------------------------------------------------------------
  const navItems = (): HTMLElement[] => [...(body?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])]

  const placePopover = (): void => {
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(POPOVER_WIDTH_PX, innerWidth - 2 * VIEWPORT_GUTTER_PX)
    const left = Math.max(VIEWPORT_GUTTER_PX, Math.min(rect.left, innerWidth - width - VIEWPORT_GUTTER_PX))
    place = `top:${Math.round(rect.bottom + POPOVER_GAP_PX)}px;left:${Math.round(left)}px;width:${width}px`
  }

  const openPopover = async (): Promise<void> => {
    if (open) return
    open = true
    editing = false
    nameError = ''
    session.setPopoverOpen(true)
    if (narrow) sheet?.showModal()
    else {
      placePopover()
      pop?.showPopover()
    }
    await tick()
    // The first person, or Edit name when nobody is listed (as WorkspaceSwitcher.focusFirst).
    ;(body?.querySelector<HTMLElement>('.row') ?? editButton)?.focus()
  }

  const closePopover = (returnFocus: boolean): void => {
    if (!open) return
    open = false
    session.setPopoverOpen(false)
    if (sheet?.open) sheet.close()
    if (pop?.matches(':popover-open')) pop.hidePopover()
    copyStatus = ''
    if (returnFocus) trigger?.focus()
  }

  const toggle = (): void => {
    if (open) closePopover(false)
    else void openPopover()
  }

  // Outside pointer, the window losing focus (a click into an iframe) and a resize close it.
  $effect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && wrap?.contains(event.target)) return
      closePopover(false)
    }
    const onBlur = (): void => closePopover(false)
    const onResize = (): void => { if (!narrow) placePopover() }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onResize)
    }
  })

  // A Run switch, or crossing the sheet breakpoint, closes it.
  $effect(() => {
    void runId
    void narrow
    untrack(() => closePopover(false))
  })

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      if (event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      closePopover(true)
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.target instanceof HTMLInputElement) return
    const items = navItems()
    const target = switcherKeyTarget(event.key, items.indexOf(document.activeElement as HTMLElement), items.length)
    if (target === null) return
    event.preventDefault()
    items[target]?.focus()
  }

  // Tab out closes it. Safari does not focus a clicked button, so a null relatedTarget is not "left".
  const onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget
    if (next instanceof Node && !wrap?.contains(next)) closePopover(false)
  }

  // A row that disappears under focus hands it to the next row, then the previous one, then Edit name.
  let lastNavIndex = -1
  const onFocusIn = (event: FocusEvent): void => { lastNavIndex = navItems().indexOf(event.target as HTMLElement) }
  $effect(() => {
    void people.present
    void people.earlier
    if (!open) return
    void tick().then(() => {
      if (!open || lastNavIndex < 0) return
      const active = document.activeElement
      if (active !== null && active !== document.body) return
      const items = navItems()
      ;(items[Math.min(lastNavIndex, items.length - 1)] ?? editButton)?.focus()
    })
  })

  const choose = (person: PersonView): void => {
    closePopover(false)
    onOpenChat({ id: person.id, name: person.name })
  }

  // --- copy link ------------------------------------------------------------------
  let copyStatus = $state('')
  let copyTimer: ReturnType<typeof setTimeout> | null = null
  const copyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(runUrl)
      copyStatus = 'Link copied.'
    } catch (cause) {
      console.warn('Copying the Run link failed', cause)
      copyStatus = 'Couldn’t copy the link. Copy it from the address bar.'
    }
    if (copyTimer !== null) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copyStatus = ''; copyTimer = null }, COPY_STATUS_MS)
  }

  // --- name -----------------------------------------------------------------------
  let editing = $state(false)
  let draft = $state('')
  let nameError = $state('')
  let saving = $state(false)
  let savedFlash = $state(false)
  let savedTimer: ReturnType<typeof setTimeout> | null = null
  let nameInput = $state<HTMLInputElement | null>(null)
  let editButton = $state<HTMLButtonElement | null>(null)
  const counter = $derived(editing ? nameCounterText(draft) : null)

  const metaText = $derived.by(() => {
    if (savedFlash) return 'Saved.'
    const me = people.me
    if (me === null) return ''
    if (people.preferredNameTaken !== null) return `“${people.preferredNameTaken}” is taken in this Workspace, so you’re ${me.name} here.`
    return isDefaultName(me.name) ? 'Choose a name so others know who you are.' : 'This is how others see you.'
  })

  const flashSaved = (): void => {
    savedFlash = true
    if (savedTimer !== null) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => { savedFlash = false; savedTimer = null }, SAVED_FLASH_MS)
  }

  const startEdit = async (): Promise<void> => {
    if (people.me === null) return
    editing = true
    draft = people.me.name
    nameError = ''
    savedFlash = false
    await tick()
    nameInput?.focus()
    nameInput?.select()
  }

  const endEdit = async (refocus: boolean): Promise<void> => {
    editing = false
    nameError = ''
    if (!refocus) return
    await tick()
    editButton?.focus()
  }

  const blurFailureText = (name: string, error: string): string =>
    error === NAME_TEXT.taken(name) ? `Your name wasn’t saved: “${name}” is already taken.` : `Your name wasn’t saved. ${error}`

  const save = async (how: 'enter' | 'blur'): Promise<void> => {
    if (!editing || saving) return
    const name = normaliseName(draft)
    if (people.me !== null && name === people.me.name) return endEdit(how === 'enter')
    const problem = nameProblem(name)
    if (problem !== null) {
      // On blur an invalid name reverts quietly; Enter explains.
      if (how === 'blur') return endEdit(false)
      nameError = problem
      await tick()
      nameInput?.focus()
      nameInput?.select()
      return
    }
    saving = true
    const outcome = await session.rename(draft)
    saving = false
    if (outcome.ok) {
      editing = false
      nameError = ''
      flashSaved()
      if (how === 'enter' && open) {
        await tick()
        editButton?.focus()
      }
      return
    }
    if (open && editing) {
      nameError = outcome.error
      await tick()
      nameInput?.focus()
      nameInput?.select()
      return
    }
    // The popover closed while a blur save was on its way: a typed name is never lost without a word.
    editing = false
    session.showNotice(blurFailureText(name, outcome.error))
  }

  const onNameKeydown = (event: KeyboardEvent): void => {
    if (event.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      void save('enter')
    } else if (event.key === 'Escape') {
      // Esc ends the edit only, not the popover.
      event.preventDefault()
      event.stopPropagation()
      void endEdit(true)
    }
  }

  const onNameBlur = (): void => {
    setTimeout(() => {
      if (editing && !saving && document.activeElement !== nameInput) void save('blur')
    }, 0)
  }

  // --- toast ----------------------------------------------------------------------
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  /** Hovered or focused: a removed toast fires no mouseleave or focusout, so a new or dismissed toast clears it. */
  let toastPaused = false
  const toastId = $derived(people.toast?.id ?? null)
  const stopToastTimer = (): void => {
    if (toastTimer !== null) clearTimeout(toastTimer)
    toastTimer = null
  }
  const armToast = (): void => {
    stopToastTimer()
    if (!toastPaused) toastTimer = setTimeout(() => { toastTimer = null; session.dismissToast() }, TOAST_VISIBLE_MS)
  }
  $effect(() => {
    const id = toastId
    toastPaused = false
    if (id === null) return
    untrack(armToast)
    return stopToastTimer
  })
  const pauseToast = (): void => { toastPaused = true; stopToastTimer() }
  const resumeToast = (): void => { toastPaused = false; armToast() }
  const openFromToast = (): void => {
    const toast = people.toast
    if (toast?.kind !== 'message') return
    session.dismissToast()
    onOpenChat(toast.from)
  }

  $effect(() => () => {
    for (const timer of [copyTimer, savedTimer]) if (timer !== null) clearTimeout(timer)
    stopToastTimer()
    // Leaving the Run view removes the control with its popover: toasts may show again.
    session.setPopoverOpen(false)
  })
</script>

{#snippet row(person: PersonView)}
  <button class="row" type="button" data-nav aria-current={people.chat?.with.id === person.id ? 'true' : undefined}
    aria-label={rowLabel(person.name, person.here, person.unread)} title={person.name} onclick={() => choose(person)}
  >
    <PersonAvatar {person} size={28} dot={person.here ? 'here' : 'away'} />
    <span class="row-text"><span class="row-name" dir="auto">{person.name}</span>{#if !person.here}<span class="row-meta" aria-hidden="true">Not here</span>{/if}</span>
    {#if person.unread > 0}<span class="pill" aria-hidden="true">{pillText(person.unread)}</span>{:else}<span></span>{/if}
  </button>
{/snippet}

{#snippet content()}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="body" bind:this={body} onkeydown={onKeydown} onfocusout={onFocusOut} onfocusin={onFocusIn}>
    <section class="you" aria-labelledby={`${uid}-you`}>
      <p class="group-label" id={`${uid}-you`}>You</p>
      {#if people.me === null}
        <p class="muted">Joining…</p>
      {:else if editing}
        <div class="you-row editing">
          <PersonAvatar person={people.me} size={28} />
          <label class="visually-hidden" for={`${uid}-name`}>Your name</label>
          <input bind:this={nameInput} id={`${uid}-name`} class="lb-input name-input" data-nav autocomplete="off" spellcheck="false" enterkeyhint="done" dir="auto"
            bind:value={draft} readonly={saving} aria-busy={saving ? 'true' : undefined} aria-invalid={nameError ? 'true' : undefined}
            aria-describedby={`${uid}-name-error ${uid}-name-help`}
            oninput={() => { nameError = '' }} onkeydown={onNameKeydown} onblur={onNameBlur} />
        </div>
        <div class="name-edit">
          <p class="field-error" id={`${uid}-name-error`} role="alert">{nameError}</p>
          <span class="edit-help" id={`${uid}-name-help`}>
            {#if saving}<span>Saving…</span>{:else}<span class="edit-keys">Enter to save · Esc to cancel</span>{/if}
            {#if counter}<span class:over={counter.over}>{counter.text}</span>{/if}
          </span>
        </div>
      {:else}
        <div class="you-row">
          <PersonAvatar person={people.me} size={28} />
          <span class="you-name" dir="auto" title={people.me.name}>{people.me.name}</span>
          <button bind:this={editButton} class="icon-btn" type="button" data-nav aria-label="Edit your name" title="Edit your name" onclick={() => void startEdit()}><Icon name="edit" size={18} /></button>
        </div>
        <p class="you-meta" class:ok={savedFlash}>{metaText}</p>
      {/if}
      {#if people.storage === 'page'}<p class="you-meta storage-note">{STORAGE_BLOCKED_TEXT}</p>{/if}
    </section>
    {#if people.status === 'failed'}
      <div class="banner"><span>{people.failure}</span><button class="lb-btn lb-btn-sm" type="button" data-nav onclick={() => session.tryNow()}>Try again</button></div>
    {:else if people.notice !== 'none'}
      <div class="banner">
        <svg class="assistant-spinner" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>
        {#if people.notice === 'reconnecting'}<span>Reconnecting… This list updates when the connection is back.</span>
        {:else}<span>Can’t reach Leitbild. Still trying…</span><button class="lb-btn lb-btn-sm" type="button" data-nav onclick={() => session.tryNow()}>Try now</button>{/if}
      </div>
    {/if}
    <div class="scroll" class:dimmed={people.notice !== 'none'}>
      {#if !people.presentKnown}
        <p class="muted">{people.status === 'failed' ? 'No list while people are unavailable.' : 'Loading people…'}</p>
      {:else}
        <div role="group" aria-labelledby={`${uid}-here`}>
          <p class="group-label" id={`${uid}-here`}>In this simulation{people.present.length > 0 ? ` · ${people.present.length}` : ''}</p>
          {#each people.present as person (person.id)}{@render row(person)}{:else}
            <p class="empty"><strong>No one else is here yet.</strong>People appear when they open this simulation.</p>
            <button class="lb-btn lb-btn-sm copy" type="button" data-nav onclick={() => void copyLink()}><Icon name="link" size={16} />Copy link</button>
            <p class="copy-status" role="status">{copyStatus}</p>
          {/each}
        </div>
        {#if people.earlier.length > 0}
          <div role="group" aria-labelledby={`${uid}-earlier`}>
            <p class="group-label" id={`${uid}-earlier`}>Earlier chats</p>
            {#each people.earlier as person (person.id)}{@render row(person)}{/each}
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/snippet}

<div class="presence" bind:this={wrap}>
  <button bind:this={trigger} class="presence-trigger" class:reconnecting={mode === 'reconnecting'} type="button"
    aria-haspopup="dialog" aria-expanded={open} aria-controls={`${uid}-pop`} aria-label={label} title={label} onclick={toggle}
  >
    {#if mode === 'reconnecting'}<svg class="assistant-spinner spin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>
    {:else}<Icon name="users" size={16} class="users-icon" />{/if}
    {#if showPeople}
      {#if others.length === 0}<span class="alone" aria-hidden="true">Just you</span>
      {:else}
        <span class="stack" aria-hidden="true">{#each shown as person (person.id)}<PersonAvatar {person} size={20} />{/each}</span>
        {#if extra > 0}<span class="more" aria-hidden="true">+{extra}</span>{/if}
        <span class="count" aria-hidden="true">{others.length}</span>
      {/if}
    {/if}
    {#if people.unreadTotal > 0}<span class="badge" aria-hidden="true">{badgeText(people.unreadTotal)}</span>{/if}
  </button>

  {#if narrow}
    <dialog bind:this={sheet} id={`${uid}-pop`} class="sheet" aria-labelledby={`${uid}-sheet-title`}
      onclose={() => closePopover(false)} onclick={event => { if (event.target === sheet) closePopover(true) }}
    >
      <div class="grabber" aria-hidden="true"></div>
      <header class="sheet-head">
        <h2 id={`${uid}-sheet-title`}>People</h2>
        <button class="lb-icon-btn" type="button" aria-label="Close" onclick={() => closePopover(true)}><Icon name="close" size={20} /></button>
      </header>
      {#if open}{@render content()}{/if}
    </dialog>
  {:else}
    <div bind:this={pop} id={`${uid}-pop`} class="pop" popover="manual" role="dialog" aria-label="People in this simulation" style={place}>
      {#if open}{@render content()}{/if}
    </div>
  {/if}

  {#if people.toast !== null}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="toast" onmouseenter={pauseToast} onmouseleave={resumeToast} onfocusin={pauseToast} onfocusout={resumeToast}>
      {#if people.toast.kind === 'message'}
        <button class="toast-open" type="button" aria-label={`Open chat with ${people.toast.from.name}`} onclick={openFromToast}>
          <PersonAvatar person={people.toast.from} size={28} />
          <span class="toast-text">
            <b><span dir="auto">{people.toast.from.name}</span>{#if people.toast.count > 1} <small>· {people.toast.count} new</small>{/if}</b>
            <span class="toast-preview" dir="auto">{previewText(people.toast.text)}</span>
          </span>
        </button>
      {:else}
        <p class="toast-notice">{people.toast.text}</p>
      {/if}
      <button class="icon-btn" type="button" aria-label="Dismiss" onclick={() => session.dismissToast()}><Icon name="close" size={18} /></button>
    </div>
  {/if}

  <!-- One polite voice for toasts, "Saved.", "Reconnecting…" and "Connected again." (SPEC §9). -->
  <p class="visually-hidden" role="status">{#key people.announcement?.id}<span>{people.announcement?.text ?? ''}</span>{/key}</p>
</div>

<style>
  .presence { position: relative; flex: none; display: flex; }
  .presence-trigger { position: relative; display: inline-flex; align-items: center; gap: 6px; min-height: 28px; height: 28px; padding: 0 8px 0 7px;
    border: 1px solid #536157; border-radius: var(--lb-r-xs); color: #dfe8dc; background: #243128; font-size: .72rem; cursor: pointer; }
  .presence-trigger:hover, .presence-trigger[aria-expanded="true"] { border-color: #87958a; background: #314037; }
  .presence-trigger:focus-visible { outline: 2px solid var(--lb-focus-on-dark); outline-offset: 2px; }
  .presence-trigger :global(.users-icon), .presence-trigger .spin { width: 16px; height: 16px; flex: none; color: var(--lb-on-dark-2); }
  .presence-trigger.reconnecting .stack, .presence-trigger.reconnecting .count, .presence-trigger.reconnecting .more { opacity: .5; }
  .stack { display: inline-flex; }
  .stack :global(.avatar) { box-shadow: 0 0 0 2px #243128; }
  .presence-trigger:hover .stack :global(.avatar), .presence-trigger[aria-expanded="true"] .stack :global(.avatar) { box-shadow: 0 0 0 2px #314037; }
  .stack :global(.avatar + .avatar) { margin-left: -6px; }
  .more { color: var(--lb-on-dark-2); font-weight: 650; }
  .alone { color: #aebbb0; white-space: nowrap; }
  .count { display: none; font-weight: 700; }
  .badge { position: absolute; top: -6px; right: -7px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: var(--lb-r-pill);
    color: #16231a; background: #8fd3c7; box-shadow: 0 0 0 2px #16231a; font-size: .625rem; font-weight: 700; line-height: 16px; text-align: center; }

  .pop { position: fixed; inset: auto; margin: 0; padding: 0; max-width: calc(100vw - 24px); border: 1px solid var(--lb-line);
    border-radius: var(--lb-r-lg); color: var(--lb-ink); background: var(--lb-surface); box-shadow: var(--lb-shadow-pop); overflow: hidden; }
  .body { display: flex; flex-direction: column; max-height: min(480px, calc(100dvh - 80px)); font-size: .875rem; }
  .group-label { margin: 0; padding: 8px 8px 4px; color: var(--lb-ink-3); font-size: var(--lb-fs-eyebrow); font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
  .you { padding: 6px 6px 10px; }
  .you-row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 10px; min-height: 40px; padding: 2px 4px 2px 8px; }
  .you-row.editing { grid-template-columns: 28px minmax(0, 1fr); padding-right: 8px; }
  .you-name { overflow: hidden; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; unicode-bidi: plaintext; }
  .you-meta { margin: 0; padding: 0 8px 0 46px; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); line-height: 1.4; }
  .you-meta.ok { color: var(--lb-ok); font-weight: 600; }
  .storage-note { margin-top: 4px; }
  .name-input { min-height: 36px; padding: .4rem .6rem; font-size: .875rem; unicode-bidi: plaintext; }
  .name-input[aria-invalid="true"] { border-color: var(--lb-danger); }
  .name-input[readonly] { color: var(--lb-ink-3); background: var(--lb-surface-2); }
  .name-edit { display: grid; gap: 4px; padding: 2px 8px 0 46px; }
  .field-error { margin: 0; color: var(--lb-danger); font-size: var(--lb-fs-micro); line-height: 1.4; }
  .field-error:empty { display: none; }
  .edit-help { display: flex; justify-content: space-between; gap: 8px; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); }
  .edit-help .over { color: var(--lb-danger); font-weight: 650; }
  .icon-btn { display: inline-grid; place-items: center; width: 32px; height: 32px; min-height: 32px; padding: 0; border: 1px solid transparent; border-radius: var(--lb-r-sm);
    color: var(--lb-ink-2); background: transparent; cursor: pointer; }
  .icon-btn:hover { border-color: transparent; color: var(--lb-ink); background: rgba(23, 32, 25, .06); }
  .icon-btn:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .banner { margin: 0; padding: 8px 14px; display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--lb-line); color: var(--lb-ink-2);
    background: var(--lb-surface-2); font-size: var(--lb-fs-micro); line-height: 1.4; }
  .banner span { flex: 1; }
  .banner svg { width: 14px; height: 14px; flex: none; color: var(--lb-ink-3); }
  .banner .lb-btn { flex: none; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 6px 8px; border-top: 1px solid var(--lb-line); }
  .scroll.dimmed .row { opacity: .6; }
  .row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 10px; width: 100%; min-height: 44px; padding: 6px 8px;
    border: 0; border-radius: var(--lb-r-sm); color: var(--lb-ink); background: transparent; font-size: .875rem; text-align: left; cursor: pointer; }
  .row:hover { border-color: transparent; background: var(--lb-surface-2); }
  .row:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: -2px; background: var(--lb-surface-2); }
  .row[aria-current="true"] { background: var(--lb-brand-50); }
  .row-text { min-width: 0; display: flex; align-items: baseline; gap: 6px; }
  .row-name { min-width: 0; overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; unicode-bidi: plaintext; }
  .row-meta { flex: none; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); }
  .pill { min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--lb-r-pill); color: #fff; background: var(--lb-accent); font-size: .6875rem; font-weight: 700; line-height: 18px; text-align: center; }
  .muted { margin: 0; padding: 10px 8px; color: var(--lb-ink-3); font-size: var(--lb-fs-small); }
  .empty { margin: 0; padding: 6px 8px 10px; color: var(--lb-ink-3); font-size: var(--lb-fs-small); line-height: 1.45; }
  .empty strong { display: block; color: var(--lb-ink-2); font-weight: 650; }
  .copy { margin: 0 8px 6px; }
  .copy-status { margin: -2px 8px 6px; color: var(--lb-ok); font-size: var(--lb-fs-micro); font-weight: 600; }
  .copy-status:empty { display: none; }

  .toast { position: absolute; z-index: 90; top: calc(100% + 8px); left: 0; width: min(320px, calc(100vw - 24px)); padding: 10px 6px 10px 12px;
    display: flex; align-items: flex-start; gap: 4px; border: 1px solid var(--lb-line); border-left: 3px solid var(--lb-accent); border-radius: var(--lb-r-lg);
    color: var(--lb-ink); background: var(--lb-surface); box-shadow: var(--lb-shadow-pop); }
  .toast-open { flex: 1; min-width: 0; min-height: 0; display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 10px; padding: 2px; border: 0;
    border-radius: var(--lb-r-sm); color: inherit; background: none; text-align: left; cursor: pointer; }
  .toast-open:hover { border-color: transparent; }
  .toast-open:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .toast-text { min-width: 0; }
  .toast-text b { display: block; overflow: hidden; font-size: .8125rem; text-overflow: ellipsis; white-space: nowrap; }
  .toast-text b span { unicode-bidi: plaintext; }
  .toast-text small { color: var(--lb-ink-3); font-weight: 600; }
  .toast-preview { display: block; overflow: hidden; color: var(--lb-ink-2); font-size: .8125rem; text-overflow: ellipsis; white-space: nowrap; unicode-bidi: plaintext; }
  .toast-notice { flex: 1; margin: 0; padding: 4px 2px; color: var(--lb-ink); font-size: .8125rem; line-height: 1.45; }

  /* Phone: a modal bottom sheet with a scrim, title and close. */
  .sheet { inset: auto 0 0 0; width: 100vw; max-width: none; max-height: 88dvh; margin: 0; padding: 0; border: 0; border-radius: 16px 16px 0 0;
    color: var(--lb-ink); background: var(--lb-surface); box-shadow: var(--lb-shadow-lg); }
  .sheet[open] { display: flex; flex-direction: column; }
  .sheet::backdrop { background: rgba(10, 16, 12, .45); }
  .sheet .body { max-height: none; min-height: 0; flex: 1; }
  .grabber { width: 36px; height: 4px; margin: 8px auto 0; border-radius: 2px; background: var(--lb-line-strong); }
  .sheet-head { display: flex; align-items: center; justify-content: space-between; min-height: 48px; padding: 0 6px 0 16px; }
  .sheet-head h2 { margin: 0; font-size: 1.0625rem; font-weight: 700; }

  @media (max-width: 899px) {
    .stack, .more { display: none; }
    .count { display: inline; }
  }
  @media (max-width: 759px) {
    .alone { display: none; }
    .toast { position: fixed; top: 50px; left: 12px; right: 12px; width: auto; }
  }
  @media (max-width: 639px) {
    .row, .icon-btn { min-height: 44px; }
    .icon-btn { width: 44px; height: 44px; }
  }
  @media (pointer: coarse) {
    .row { min-height: 44px; }
    .edit-keys { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .presence :global(.assistant-spinner) { animation: none; } }
  @media (forced-colors: active) { .badge, .pill { border: 1px solid CanvasText; } }
</style>
