<script lang="ts">
  // The Getting started guide (plan v2 §4): 6 pages, paged not rotating. A
  // contents rail ≥ 1024 px, a Contents disclosure below. Each page scrolls in
  // a labelled region; paging resets it and focuses the chapter heading. Images
  // open in an in-modal lightbox. Page 6 hands a question to the Assistant.
  // Text lives in guide-content.ts, the Ask rules in guide-ask.ts.
  import type { Workspace } from '@leitbild/contracts'
  import { tick, untrack } from 'svelte'
  import Icon from './Icon.svelte'
  import Modal from './Modal.svelte'
  import Wordmark from './Wordmark.svelte'
  import { openAssistantConversation } from './assistant-handoff.ts'
  import { errorDiagnostic, plainError } from './error-text.ts'
  import {
    ANSWER_TIME_TEXT, askDestination, askProgress, destinationName, guideConversationUrl, guideHandoffRequest,
    INITIAL_ASK_PROGRESS, questionError, questionText, type AskDestination, type AskProgress, type GuideQuestion,
  } from './guide-ask.ts'
  import {
    chapterEyebrow, GUIDE_MAP_CREDIT, GUIDE_PAGE_IDS, GUIDE_PAGES, guideCard, guideWikiHref, QUESTION_MAX_LENGTH,
    type GuideCard, type GuidePageId, type GuideShotId,
  } from './guide-content.ts'
  import { GUIDE_DIAGRAMS, GUIDE_SHOTS, guideShotSrcset } from './guide-images.ts'
  import { workspacePath } from './launch-destination.ts'
  import { createWorkspaceApi, isWorkspaceNotReady, rememberedWorkspace, workspaceLabel } from './launch-workspace.ts'
  import { demosHref, type ModalCloseReason } from './modal-url.ts'
  import { pageIndex, pagerKeyIntent, pagerView } from './pager.ts'
  import { browserWorkspaceMemory } from './workspace-memory.ts'

  interface Props {
    /** $bindable: true opens the guide, false closes it. */
    open: boolean
    /** Page id from `?guide=<page>`; unknown → the first page. */
    page?: string | null
    /** Card id from `&card=<card>`: the page scrolls to it and focuses its heading. */
    card?: string | null
    /** The user paged: replace `?guide=` (modal-url `replace`). */
    onpagechange?: (page: GuidePageId) => void
    /**
     * "Try …": the caller swaps to the Demos modal (`world:<id>`, or null for its first slide);
     * `keyboard` is true for Enter/Space, so Demos can start stopped. Without it, the link navigates to `/workspaces?demos=…`.
     */
    ontrydemo?: (demo: string | null, how: { readonly keyboard: boolean }) => void
    /** Footer "Close" reports 'close-button', like ×. */
    onclose?: (reason: ModalCloseReason) => void
    fallbackFocus?: () => HTMLElement | null
  }

  let { open = $bindable(), page = 'start', card = null, onpagechange, ontrydemo, onclose, fallbackFocus }: Props = $props()

  const ids = GUIDE_PAGE_IDS
  const api = createWorkspaceApi()
  const memory = browserWorkspaceMemory()

  let modal = $state<{ element(): HTMLDialogElement | null } | null>(null)
  let region = $state<HTMLElement | null>(null)
  let chapterHeading = $state<HTMLElement | null>(null)
  let index = $state(0)
  const view = $derived(pagerView(ids, index))
  const current = $derived(GUIDE_PAGES[index]!)
  const previousTitle = $derived(view.isFirst ? null : GUIDE_PAGES[index - 1]!.title)
  const nextTitle = $derived(view.isLast ? null : GUIDE_PAGES[index + 1]!.title)

  // In-memory for this opening only: the last chapter viewed, for "Asked from".
  let lastChapterTitle: string | null = null
  let contentsOpen = $state(false)
  let contentsButton = $state<HTMLButtonElement | null>(null)
  let closingWithButton = false

  // ---- Paging and deep links ----
  let wasOpen = false
  let seenPage: string | null | undefined
  let seenCard: string | null | undefined

  const cardHeadingId = (cardId: string): string => `guide-card-${cardId}`

  const focusCard = (cardId: string): boolean => {
    const heading = document.getElementById(cardHeadingId(cardId))
    if (!heading) return false
    heading.closest('article')?.scrollIntoView({ block: 'start' })
    heading.focus({ preventScroll: true })
    return true
  }

  const show = async (target: number, cardId: string | null, focus: 'none' | 'heading' | 'card'): Promise<void> => {
    index = target
    contentsOpen = false
    const shown = GUIDE_PAGES[target]!
    if (shown.kind === 'chapter') lastChapterTitle = shown.title
    else void loadRemembered()
    await tick()
    region?.scrollTo({ top: 0 })
    // After the Modal has focused its title on open.
    if (focus === 'card' && cardId !== null && guideCard(shown, cardId)) requestAnimationFrame(() => { focusCard(cardId) })
    else if (focus === 'heading') chapterHeading?.focus({ preventScroll: true })
  }

  const go = (target: number): void => {
    const next = pageIndex(ids, target)
    if (next === index) return
    seenPage = ids[next]
    seenCard = null
    void show(next, null, 'heading')
    onpagechange?.(ids[next]!)
  }

  $effect(() => {
    const isOpen = open
    const targetPage = page
    const targetCard = card
    untrack(() => {
      if (isOpen && !wasOpen) {
        resetSession()
        seenPage = targetPage
        seenCard = targetCard
        void show(pageIndex(ids, targetPage), targetCard, targetCard ? 'card' : 'none')
      }
      else if (isOpen && (targetPage !== seenPage || targetCard !== seenCard)) {
        seenPage = targetPage
        seenCard = targetCard
        const target = pageIndex(ids, targetPage)
        if (target !== index || targetCard) void show(target, targetCard, targetCard ? 'card' : 'heading')
      }
      wasOpen = isOpen
    })
  })

  const onKeydown = (event: KeyboardEvent): void => {
    if (!open || lightbox || contentsOpen) return
    const dialog = modal?.element()
    if (!dialog || !(event.target instanceof Node) || !dialog.contains(event.target)) return
    const intent = pagerKeyIntent(event)
    if (!intent) return
    event.preventDefault()
    go(index + (intent === 'next' ? 1 : -1))
  }

  // ---- Contents disclosure (below 1024 px; never a <select>, a11y M8) ----
  const toggleContents = (): void => { contentsOpen = !contentsOpen }
  const contentsKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !contentsOpen) return
    event.preventDefault()
    event.stopPropagation()
    contentsOpen = false
    contentsButton?.focus()
  }
  const contentsFocusout = (event: FocusEvent): void => {
    const container = event.currentTarget as HTMLElement
    if (!(event.relatedTarget instanceof Node) || !container.contains(event.relatedTarget)) contentsOpen = false
  }

  // ---- Lightbox ----
  let lightbox = $state<{ shot: GuideShotId; alt: string } | null>(null)
  let lightboxDialog = $state<HTMLDialogElement | null>(null)
  let lightboxOpener: HTMLElement | null = null
  const openLightbox = async (shot: GuideShotId, alt: string, opener: HTMLElement): Promise<void> => {
    lightboxOpener = opener
    lightbox = { shot, alt }
    await tick()
    lightboxDialog?.showModal()
  }
  const closeLightbox = (): void => { lightboxDialog?.close() }
  const onLightboxClose = (): void => {
    lightbox = null
    lightboxOpener?.focus()
    lightboxOpener = null
  }
  const onLightboxClick = (event: MouseEvent): void => { if (event.target === lightboxDialog) closeLightbox() }

  // ---- "Try …" ----
  const tryDemo = (event: MouseEvent, demo: string | null): void => {
    if (!ontrydemo || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    ontrydemo(demo, { keyboard: event.detail === 0 })
  }

  // ---- Ask page ----
  let questionValue = $state('')
  let questionMessage = $state<string | null>(null)
  let remembered = $state<Workspace | null | undefined>(undefined)
  let rememberedFailed = $state(false)
  let rememberedNotice = $state<string | null>(null)
  let forceNew = $state(false)
  const destination = $derived<AskDestination>(rememberedFailed ? { kind: 'unknown' } : askDestination(remembered, forceNew))

  type AskError = { readonly text: string; readonly retry: boolean; readonly workspace: Workspace | null; readonly notReady: boolean }
  let asking = $state<{ question: GuideQuestion; progress: AskProgress; error: AskError | null } | null>(null)
  let askController: AbortController | null = null
  let askWorkspace: Workspace | null = null
  let progressHeading = $state<HTMLElement | null>(null)
  let firstErrorAction = $state<HTMLElement | null>(null)
  let questionInput = $state<HTMLInputElement | null>(null)
  let status = $state('')

  let rememberedLoading = false
  const loadRemembered = async (): Promise<void> => {
    if (remembered !== undefined || rememberedLoading) return
    rememberedLoading = true
    try {
      const result = await rememberedWorkspace({ api, memory })
      remembered = result.workspace
      rememberedNotice = result.notice
    }
    catch (cause) {
      console.error(errorDiagnostic(cause))
      rememberedFailed = true
    }
    finally { rememberedLoading = false }
  }

  const ask = async (question: GuideQuestion, retryModule: Workspace | null = null): Promise<void> => {
    askController?.abort()
    const controller = new AbortController()
    askController = controller
    askWorkspace = null
    asking = { question, progress: INITIAL_ASK_PROGRESS, error: null }
    status = ''
    await tick()
    progressHeading?.focus()
    try {
      if (retryModule) await api.retryModule(retryModule.id, 'agents', controller.signal)
      const chosen = retryModule ?? (forceNew ? null : remembered ?? null)
      const handoff = await openAssistantConversation(
        guideHandoffRequest(question, { workspaceId: chosen?.id ?? null, forceNewWorkspace: forceNew && !retryModule }),
        {
          api, memory, now: () => new Date(), fetch: (input, init) => fetch(input, init), signal: controller.signal,
          onstep: step => {
            if (controller.signal.aborted || !asking) return
            if ('workspace' in step) askWorkspace = step.workspace
            asking.progress = askProgress(asking.progress, step)
            status = asking.progress.status
          },
        },
      )
      if (controller.signal.aborted) return
      status = 'Opening the conversation…'
      location.assign(guideConversationUrl(handoff.destination))
    }
    catch (cause) {
      if (controller.signal.aborted || !asking) return
      console.error(errorDiagnostic(cause))
      if (isWorkspaceNotReady(cause)) {
        asking.error = { text: cause.message, retry: true, workspace: cause.workspace, notReady: true }
      }
      else {
        const plain = plainError(cause)
        // The conversation may exist already: open the Workspace instead of asking twice.
        asking.error = { text: plain.text, retry: plain.action !== 'check', workspace: askWorkspace, notReady: false }
      }
      await tick()
      firstErrorAction?.focus()
    }
  }

  const askChip = (index: number): void => {
    const askPage = GUIDE_PAGES.at(-1)!
    if (askPage.kind !== 'ask') return
    void ask({ kind: 'suggestion', prompt: askPage.prompts[index]! })
  }

  const submitQuestion = (event: SubmitEvent): void => {
    event.preventDefault()
    questionMessage = questionError(questionValue)
    if (questionMessage) {
      questionInput?.focus()
      return
    }
    void ask({ kind: 'question', text: questionValue.trim(), lastPageTitle: lastChapterTitle })
  }

  const retryAsk = (): void => {
    if (!asking?.error) return
    void ask(asking.question, asking.error.notReady ? asking.error.workspace : null)
  }

  const backToQuestions = async (): Promise<void> => {
    askController?.abort()
    askController = null
    asking = null
    status = ''
    await tick()
    chapterHeading?.focus()
  }

  function resetSession(): void {
    lastChapterTitle = null
    contentsOpen = false
    questionValue = ''
    questionMessage = null
    remembered = undefined
    rememberedFailed = false
    rememberedNotice = null
    forceNew = false
    asking = null
    status = ''
  }

  // ---- Close ----
  const closeGuide = (): void => {
    closingWithButton = true
    open = false
  }
  const handleClose = (reason: ModalCloseReason): void => {
    const reported = closingWithButton && reason === 'programmatic' ? 'close-button' : reason
    closingWithButton = false
    // Closing aborts a question in flight: nothing navigates later.
    askController?.abort()
    askController = null
    asking = null
    lightbox = null
    onclose?.(reported)
  }

  const stepState = (state: 'pending' | 'active' | 'done' | 'failed'): string =>
    state === 'done' ? 'done' : state === 'active' ? 'in progress' : state === 'failed' ? 'failed' : 'not started'
</script>

<svelte:document onkeydown={onKeydown} />

{#snippet titleContent()}Getting started with <Wordmark size="inline" />{/snippet}

{#snippet shotMedia(item: GuideCard, shot: GuideShotId, alt: string)}
  <button class="shot" type="button" aria-label={`Enlarge image: ${alt}`} onclick={event => openLightbox(shot, alt, event.currentTarget)}>
    <img src={GUIDE_SHOTS[shot].small} srcset={guideShotSrcset(shot)} sizes="(max-width: 639px) calc(100vw - 66px), (max-width: 1023px) calc(100vw - 132px), 780px"
      alt="" width="720" height="450" loading="lazy" decoding="async" />
    <span class="enlarge" aria-hidden="true"><Icon name="search" size={16} /></span>
  </button>
{/snippet}

{#snippet cardView(item: GuideCard)}
  <article class="card" aria-labelledby={cardHeadingId(item.id)}>
    {#if item.media?.kind === 'shot'}
      {@render shotMedia(item, item.media.shot, item.media.alt)}
    {:else if item.media?.kind === 'diagram'}
      <figure class="diagram"><img src={GUIDE_DIAGRAMS[item.media.diagram]} alt={item.media.alt} width="480" height="300" /></figure>
    {/if}
    <div class="card-text">
      <h4 id={cardHeadingId(item.id)} tabindex="-1">{item.title}</h4>
      <p class="body">{item.body}</p>
      {#if item.media?.kind === 'audiences'}
        <ul class="audiences" aria-label="Who it is for">
          {#each item.media.audiences as audience (audience.title)}<li><strong>{audience.title}</strong><span>{audience.text}</span></li>{/each}
        </ul>
      {/if}
      {#if item.why}<p class="line"><strong>Why it matters:</strong> {item.why}</p>{/if}
      {#if item.limits}<p class="line"><strong>Limits:</strong> {item.limits}</p>{/if}
      {#if item.action || item.wiki.length > 0}
        <div class="actions">
          {#if item.action?.kind === 'demo'}
            {@const demo = item.action.demo}
            <a class="lb-btn lb-btn-sm try" href={demosHref(demo)} onclick={event => tryDemo(event, demo)}>{item.action.label}<Icon name="arrow" size={15} /></a>
            {#if item.action.helper}<span class="helper">{item.action.helper}</span>{/if}
          {:else if item.action?.kind === 'page'}
            {@const target = item.action.page}
            <button class="lb-btn lb-btn-sm try" type="button" onclick={() => go(pageIndex(ids, target))}>{item.action.label}<Icon name="arrow" size={15} /></button>
          {:else if item.action?.kind === 'wiki'}
            <a class="lb-btn lb-btn-sm try" href="/wiki">{item.action.label}<Icon name="arrow" size={15} /></a>
          {/if}
          {#each item.wiki as link, position (link.path)}
            <a class="lb-text-link" href={guideWikiHref(link.path)}>{#if position === 0}Read in the wiki<span class="visually-hidden">: {item.title}</span>{:else}{link.title}<span class="visually-hidden"> (wiki)</span>{/if}<Icon name="arrow" size={15} /></a>
          {/each}
        </div>
      {/if}
    </div>
  </article>
{/snippet}

{#snippet askView()}
  {#if current.kind === 'ask'}
    <div class="ask">
      {#if asking === null}
        <ul class="prompts" aria-label="Suggested questions">
          {#each current.prompts as prompt, position (prompt.label)}
            <li><button class="lb-prompt-chip" type="button" onclick={() => askChip(position)}><span>{prompt.label}</span><Icon name="arrow" size={18} /></button></li>
          {/each}
        </ul>
        <form class="ask-form" novalidate onsubmit={submitQuestion}>
          <label class="visually-hidden" for="guide-question">Your question</label>
          <div class="ask-row">
            <input id="guide-question" class="lb-input" type="text" maxlength={QUESTION_MAX_LENGTH} placeholder="Ask a question about Leitbild…" autocomplete="off"
              bind:this={questionInput} bind:value={questionValue} oninput={() => { questionMessage = null }}
              aria-invalid={questionMessage ? 'true' : undefined} aria-describedby={questionMessage ? 'guide-question-error guide-question-hint' : 'guide-question-hint'} />
            <button class="lb-btn lb-btn-primary lb-btn-lg" type="submit"><Icon name="send" size={18} />Ask</button>
          </div>
          {#if questionMessage}<p class="field-error" id="guide-question-error">{questionMessage}</p>{/if}
          <p class="hint" id="guide-question-hint">{QUESTION_MAX_LENGTH} characters max</p>
        </form>
        <div class="ask-lines">
          {#if rememberedNotice}<p class="notice-line">{rememberedNotice}</p>{/if}
          {#if destination.kind === 'remembered'}
            <p>A new conversation opens in <strong>{destinationName(destination.workspace)}</strong> · <button class="link-button" type="button" onclick={() => { forceNew = true }}>Use a new Workspace instead</button></p>
          {:else if destination.kind === 'new'}
            <p>A new Workspace is created for this conversation.{#if destination.instead} · <button class="link-button" type="button" onclick={() => { forceNew = false }}>Use {destinationName(destination.instead)} instead</button>{/if}</p>
          {:else if destination.kind === 'checking'}
            <p aria-hidden="true">&nbsp;</p>
          {/if}
          <p>{ANSWER_TIME_TEXT}</p>
        </div>
      {:else}
        <section class="progress" aria-labelledby="guide-ask-progress">
          <h4 id="guide-ask-progress" tabindex="-1" bind:this={progressHeading}>Asking the Leitbild Assistant</h4>
          <p class="asked">“{questionText(asking.question)}”</p>
          <ol class="steps">
            {#each asking.progress.steps as step (step.id)}
              {@const state = step.state === 'active' && asking.error ? 'failed' : step.state}
              <li class={state} aria-current={state === 'active' ? 'step' : undefined}>
                <span class="mark" aria-hidden="true">{#if state === 'done'}<Icon name="check" size={14} />{:else if state === 'failed'}<Icon name="close" size={12} />{/if}</span>
                <span>{step.label}</span><span class="visually-hidden"> ({stepState(state)})</span>
              </li>
            {/each}
          </ol>
          <p class="error-text" role="alert">{asking.error?.text ?? ''}</p>
          {#if asking.error}
            <div class="error-actions">
              {#if asking.error.retry}
                <button class="lb-btn lb-btn-primary" type="button" bind:this={firstErrorAction} onclick={retryAsk}>Try again</button>
                {#if asking.error.workspace}<a class="lb-btn" href={workspacePath(asking.error.workspace.id)}>Open {workspaceLabel(asking.error.workspace)}</a>{/if}
              {:else if asking.error.workspace}
                <a class="lb-btn lb-btn-primary" href={workspacePath(asking.error.workspace.id)} bind:this={firstErrorAction}>Open {workspaceLabel(asking.error.workspace)}</a>
              {/if}
              <button class="lb-btn lb-btn-quiet" type="button" onclick={backToQuestions}>Back to the questions</button>
            </div>
          {:else}
            <p class="note">{ANSWER_TIME_TEXT}</p>
          {/if}
        </section>
      {/if}
      <p class="visually-hidden" role="status">{status}</p>
    </div>
  {/if}
{/snippet}

{#snippet footer()}
  <button class="lb-btn nav prev" type="button" disabled={view.isFirst} onclick={() => go(index - 1)}
    aria-label={previousTitle ? `Previous: ${previousTitle}` : 'Previous'}>
    <Icon name="left" size={18} /><span class="nav-label">Previous{#if previousTitle}<span class="nav-title">: {previousTitle}</span>{/if}</span>
  </button>
  <div class="position">
    <span class="count">{view.position}</span>
    <div class="contents" onkeydown={contentsKeydown} onfocusout={contentsFocusout} role="presentation">
      <button class="lb-btn contents-button" type="button" bind:this={contentsButton} aria-expanded={contentsOpen} aria-controls="guide-contents-list" onclick={toggleContents}>
        <span class="visually-hidden">Contents: </span><span class="contents-label">{view.position} · {current.title}</span><Icon name="down" size={16} />
      </button>
      <ul class="contents-list" id="guide-contents-list" hidden={!contentsOpen}>
        {#each GUIDE_PAGES as item, position (item.id)}
          <li><button type="button" aria-current={position === index ? 'page' : undefined} onclick={() => { go(position); contentsOpen = false }}>{position + 1}. {item.title}</button></li>
        {/each}
      </ul>
    </div>
  </div>
  {#if view.isLast}
    <button class="lb-btn lb-btn-primary nav next" type="button" onclick={closeGuide}>Close</button>
  {:else}
    <button class="lb-btn lb-btn-primary nav next" type="button" onclick={() => go(index + 1)} aria-label={`Next: ${nextTitle}`}>
      <span class="nav-label">Next<span class="nav-title">: {nextTitle}</span></span><Icon name="right" size={18} />
    </button>
  {/if}
{/snippet}

<Modal bind:this={modal} bind:open title="Getting started with Leitbild.ai" {titleContent} eyebrow="Leitbild.ai · Getting started"
  width="1120px" height="860px" scrollBody={false} class="guide-modal" onclose={handleClose} {fallbackFocus} {footer}>
  <div class="guide">
    <nav class="rail" aria-label="Guide contents">
      <ol>
        {#each GUIDE_PAGES as item, position (item.id)}
          <li>
            <button class="rail-item" type="button" aria-current={position === index ? 'page' : undefined} onclick={() => go(position)}>
              <span class="number" aria-hidden="true">{#if item.kind === 'ask'}<Icon name="ai" size={14} />{:else}{position + 1}{/if}</span>
              <span class="rail-text"><b>{item.title}</b><small>{item.subtitle}</small></span>
            </button>
            {#if position === index && item.kind === 'chapter'}
              <ul class="rail-cards" aria-label={`On this page: ${item.title}`}>
                {#each item.cards as entry (entry.id)}<li><button type="button" onclick={() => focusCard(entry.id)}>{entry.title}</button></li>{/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ol>
    </nav>
    <div class="region" role="region" aria-labelledby="guide-chapter-title" bind:this={region}>
      <div class="chapter-head">
        <span class="lb-eyebrow">{chapterEyebrow(index)}</span>
        <h3 id="guide-chapter-title" tabindex="-1" bind:this={chapterHeading}>{current.kind === 'ask' ? current.heading : current.title}</h3>
        <p>{current.intro}</p>
      </div>
      {#if current.kind === 'chapter'}
        <div class="cards">
          {#each current.cards as item (item.id)}{@render cardView(item)}{/each}
        </div>
        {#if current.mapCredit}
          <p class="credit">{GUIDE_MAP_CREDIT.text} · <a href={guideWikiHref(GUIDE_MAP_CREDIT.link.path)}>Credits</a></p>
        {/if}
      {:else}
        {@render askView()}
      {/if}
    </div>
  </div>

  {#if lightbox}
    <dialog class="lightbox" bind:this={lightboxDialog} aria-label="Enlarged image" onclose={onLightboxClose} onclick={onLightboxClick}>
      <figure>
        <img src={GUIDE_SHOTS[lightbox.shot].large} alt={lightbox.alt} width="1200" height="750" />
        <figcaption>{lightbox.alt}</figcaption>
      </figure>
      <button class="lb-icon-btn lightbox-close" type="button" aria-label="Close image" onclick={closeLightbox}><Icon name="close" size={20} /></button>
    </dialog>
  {/if}
</Modal>

<style>
  /* Layout: rail + scrolling region (the Modal's body does not scroll itself). */
  .guide { display: grid; grid-template-columns: 248px minmax(0, 1fr); height: 100%; min-height: 0; }
  .rail { overflow-y: auto; padding: 16px 12px; border-right: 1px solid var(--lb-line); background: var(--lb-surface-2); }
  .rail ol { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
  .rail-item { display: grid; grid-template-columns: 26px minmax(0, 1fr); align-items: start; justify-content: stretch; gap: 10px; width: 100%; min-height: 0;
    padding: 9px 10px; border: 0; border-radius: var(--lb-r-md); background: transparent; color: var(--lb-ink-2); text-align: left; }
  .rail-item:hover { background: rgba(23, 32, 25, .05); color: var(--lb-ink); }
  .rail-item[aria-current='page'] { background: var(--lb-surface); color: var(--lb-ink); box-shadow: var(--lb-shadow-sm), inset 0 0 0 1px var(--lb-line); }
  .rail-item:focus-visible, .rail-cards button:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 1px; }
  .number { display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid var(--lb-line-strong); border-radius: 99px;
    background: var(--lb-surface); color: var(--lb-ink-3); font-size: .75rem; font-weight: 700; }
  .rail-item[aria-current='page'] .number { border-color: var(--lb-brand-700); background: var(--lb-brand-700); color: #fff; }
  .rail-text b { display: block; font-size: .875rem; font-weight: 650; line-height: 1.3; }
  .rail-text small { display: block; margin-top: 2px; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); line-height: 1.35; }
  .rail-cards { display: grid; gap: 1px; margin: 2px 0 8px 46px; padding: 0 0 0 10px; border-left: 1px solid var(--lb-line-strong); list-style: none; }
  .rail-cards button { display: block; width: 100%; min-height: 0; padding: 4px 6px; border: 0; border-radius: 6px; background: none;
    color: var(--lb-ink-2); font-size: var(--lb-fs-micro); line-height: 1.35; text-align: left; justify-content: flex-start; }
  .rail-cards button:hover { background: rgba(23, 32, 25, .05); color: var(--lb-ink); }

  .region { min-height: 0; padding: 28px 32px 40px; overflow-y: auto; overscroll-behavior: contain; }
  .chapter-head { display: grid; gap: 6px; max-width: 72ch; margin-bottom: 22px; }
  .chapter-head h3 { margin: 0; font-size: var(--lb-fs-h1); line-height: 1.15; font-weight: 750; letter-spacing: -.025em; text-wrap: balance; }
  .chapter-head h3:focus { outline: none; }
  .chapter-head h3:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 3px; border-radius: 4px; }
  .chapter-head p { margin: 0; color: var(--lb-ink-2); font-size: 1rem; line-height: 1.5; text-wrap: pretty; }

  /* Cards: image above the text at full card width. */
  .cards { display: grid; gap: 20px; }
  .card { display: grid; gap: 14px; padding: 16px; border: 1px solid var(--lb-line); border-radius: var(--lb-r-lg); background: var(--lb-surface); scroll-margin-top: 12px; }
  .shot { position: relative; display: grid; place-items: center; width: 100%; min-height: 0; padding: 0; overflow: hidden;
    border: 1px solid var(--lb-line); border-radius: var(--lb-r-md); background: var(--lb-surface-2); cursor: zoom-in; }
  .shot:hover { border-color: var(--lb-line-strong); }
  .shot:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .shot img { display: block; width: 100%; max-width: calc(36vh * 1.6); height: auto; aspect-ratio: 16 / 10; object-fit: cover; object-position: center top; }
  .enlarge { position: absolute; right: 8px; bottom: 8px; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px;
    background: rgba(255, 255, 255, .92); color: var(--lb-ink-2); box-shadow: var(--lb-shadow-sm); }
  .diagram { display: grid; place-items: center; margin: 0; padding: 20px 16px; border-radius: var(--lb-r-md); background: var(--lb-brand-50); }
  .diagram img { display: block; width: 100%; max-width: 480px; height: auto; }
  .card-text { display: grid; gap: 8px; align-content: start; max-width: 70ch; }
  .card-text h4 { margin: 0; font-size: var(--lb-fs-h3); line-height: 1.3; font-weight: 700; }
  .card-text h4:focus { outline: none; }
  .card-text h4:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 3px; border-radius: 4px; }
  .card-text p { margin: 0; }
  .body { color: var(--lb-ink); font-size: var(--lb-fs-body); line-height: 1.55; }
  .line { color: var(--lb-ink-2); font-size: .875rem; line-height: 1.5; }
  .line strong { color: var(--lb-ink); font-weight: 650; }
  .audiences { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 4px 0; padding: 0; list-style: none; }
  .audiences li { padding: 12px; border: 1px solid var(--lb-line); border-radius: var(--lb-r-md); background: var(--lb-surface-2); }
  .audiences strong { display: block; font-size: .875rem; }
  .audiences span { display: block; margin-top: 2px; color: var(--lb-ink-2); font-size: .8125rem; line-height: 1.45; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; margin-top: 4px; }
  .try { gap: .4rem; }
  .helper { color: var(--lb-ink-3); font-size: var(--lb-fs-small); }
  .credit { margin: 18px 0 0; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); line-height: 1.45; }
  .credit a { color: var(--lb-accent); font-weight: 600; }

  /* Ask page */
  .ask { display: grid; gap: 18px; max-width: 720px; }
  .prompts { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .lb-prompt-chip :global(svg) { flex: none; color: var(--lb-accent); }
  .ask-form { display: grid; gap: 6px; }
  .ask-row { display: flex; gap: 8px; }
  .ask-row .lb-input { flex: 1; min-width: 0; min-height: 48px; border-radius: 12px; font-size: 1rem; }
  .ask-row .lb-btn { flex: none; }
  .hint { margin: 0; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); }
  .field-error { margin: 0; color: var(--lb-danger); font-size: var(--lb-fs-small); font-weight: 600; }
  .ask-lines { display: grid; gap: 4px; color: var(--lb-ink-3); font-size: var(--lb-fs-small); line-height: 1.45; }
  .ask-lines p { margin: 0; }
  .ask-lines strong { color: var(--lb-ink); font-weight: 650; }
  .notice-line { color: var(--lb-warn); font-weight: 600; }
  .link-button { display: inline; min-height: 0; padding: 0; border: 0; border-radius: 3px; background: none; color: var(--lb-accent); font: inherit; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  .link-button:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .progress { display: grid; gap: 12px; padding: 18px; border: 1px solid var(--lb-line); border-radius: var(--lb-r-lg); background: var(--lb-surface); }
  .progress h4 { margin: 0; font-size: var(--lb-fs-h3); }
  .progress h4:focus { outline: none; }
  .progress h4:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 3px; border-radius: 4px; }
  .asked { margin: 0; color: var(--lb-ink-2); font-size: var(--lb-fs-body); overflow-wrap: anywhere; }
  .steps { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
  .steps li { display: flex; align-items: center; gap: 10px; color: var(--lb-ink-3); font-size: var(--lb-fs-body); }
  .steps li.active { color: var(--lb-ink); font-weight: 600; }
  .steps li.done { color: var(--lb-ink-2); }
  .mark { display: grid; place-items: center; flex: none; width: 22px; height: 22px; border: 2px solid var(--lb-line-strong); border-radius: 99px; color: #fff; }
  .steps li.active .mark { border-color: var(--lb-accent); border-right-color: transparent; animation: spin 800ms linear infinite; }
  .steps li.done .mark { border-color: var(--lb-ok); background: var(--lb-ok); }
  .steps li.failed { color: var(--lb-ink); font-weight: 600; }
  .steps li.failed .mark { border-color: var(--lb-danger); background: var(--lb-danger); }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error-text { margin: 0; color: var(--lb-danger); font-weight: 600; }
  .error-text:empty { display: none; }
  .error-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .note { margin: 0; color: var(--lb-ink-3); font-size: var(--lb-fs-small); }

  /* Footer: Previous · n / 6 (Contents below 1024 px) · Next */
  .nav { flex: 0 1 auto; min-width: 0; max-width: 340px; gap: .4rem; }
  .nav-label { overflow: hidden; text-overflow: ellipsis; }
  .next { margin-left: auto; }
  /* Basis 0: the footer's minimum width never includes the Contents label, which ellipsises instead. */
  .position { position: relative; display: flex; flex: 1 1 0; justify-content: center; width: 0; min-width: 0; }
  .count { color: var(--lb-ink-3); font-size: var(--lb-fs-small); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .contents { position: relative; display: none; min-width: 0; max-width: 100%; }
  .contents-button { max-width: 100%; min-width: 0; gap: .4rem; }
  .contents-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .contents-list { position: absolute; bottom: calc(100% + 8px); left: 50%; z-index: 5; min-width: 260px; margin: 0; padding: 4px; list-style: none;
    transform: translateX(-50%); border: 1px solid var(--lb-line); border-radius: var(--lb-r-md); background: var(--lb-surface); box-shadow: var(--lb-shadow-pop); }
  .contents-list[hidden] { display: none; }
  .contents-list button { display: block; width: 100%; min-height: 44px; padding: 0 12px; border: 0; border-radius: 6px; background: none;
    color: var(--lb-ink); font-size: .9rem; text-align: left; justify-content: flex-start; }
  .contents-list button:hover, .contents-list button[aria-current='page'] { background: var(--lb-surface-2); font-weight: 650; }
  .contents-list button:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: -2px; }

  /* Lightbox: an in-modal dialog, 90 vw; Esc or × returns to the card. */
  .lightbox { width: min(90vw, 1400px); max-width: none; max-height: 92dvh; padding: 0; border: 0; border-radius: var(--lb-r-lg); background: var(--lb-surface); box-shadow: var(--lb-shadow-lg); overflow: auto; }
  .lightbox::backdrop { background: rgba(10, 16, 12, .72); }
  .lightbox figure { margin: 0; }
  .lightbox img { display: block; width: 100%; height: auto; max-height: calc(92dvh - 56px); object-fit: contain; background: var(--lb-surface-2); }
  .lightbox figcaption { padding: 12px 64px 14px 16px; color: var(--lb-ink-2); font-size: var(--lb-fs-small); line-height: 1.45; }
  .lightbox-close { position: absolute; right: 6px; bottom: 4px; }

  @media (max-width: 1180px) { .guide { grid-template-columns: 220px minmax(0, 1fr); } }
  @media (max-width: 1023px) {
    .guide { grid-template-columns: minmax(0, 1fr); }
    .rail, .count, .nav-title { display: none; }
    .contents { display: block; }
  }
  @media (max-width: 639px) {
    .region { padding: 20px 16px 28px; }
    .card { padding: 12px; gap: 12px; }
    .audiences { grid-template-columns: minmax(0, 1fr); }
    .nav { width: 44px; min-width: 44px; padding: 0; }
    .nav-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .next.nav:not([aria-label]) { width: auto; padding: 0 1rem; }
    .next.nav:not([aria-label]) .nav-label { position: static; width: auto; height: auto; clip-path: none; }
    .position { padding: 0 4px; }
    .contents { flex: 1; }
    .contents-button { width: 100%; }
    .ask-row { flex-wrap: wrap; }
    .ask-row .lb-btn { flex: 1 0 100%; }
    .lightbox { width: 100vw; max-height: 100dvh; border-radius: 0; }
  }
  /* Short viewports (400 % zoom): one scrolling column, as the Modal does. */
  @media (max-height: 500px) {
    .guide { display: block; height: auto; }
    .rail { display: none; }
    .region { overflow: visible; }
  }
  @media (prefers-reduced-motion: reduce) {
    .steps li.active .mark { animation: none; border-right-color: var(--lb-accent); }
    .card { scroll-margin-top: 0; }
  }
  @media (forced-colors: active) {
    .rail-item[aria-current='page'] { outline: 2px solid CanvasText; }
    .mark { forced-color-adjust: none; }
  }
</style>
