<script lang="ts">
  // "Try a demo" (plan v2 §5.3): the Modules' featured demos as a carousel,
  // and Start demo's staged launch, which replaces only the slide's text
  // column. The flow, its texts and its error paths live in demo-launch.ts.
  import { tick } from 'svelte'
  import type { ModuleFeaturedDefinition, Workspace } from '@leitbild/contracts'
  import Carousel from './Carousel.svelte'
  import Icon from './Icon.svelte'
  import Modal from './Modal.svelte'
  import {
    advanceLaunchSteps, initialLaunchSteps, isDemoLaunchError, launchFailureView, launchStatusText, SLOW_TEXT, stoppedText,
    VERY_SLOW_TEXT, watchSlowLaunch, type DemoLauncher, type DemoLaunchError, type DemoLaunchRequest, type LaunchStepView,
  } from './demo-launch.ts'
  import { catalogueView, deepLinkedDemo, demoTagIcon, readFeaturedCatalogue } from './featured-catalogue.ts'
  import { errorDiagnostic, plainErrorText } from './error-text.ts'
  import { workspacePath } from './launch-destination.ts'
  import { workspaceLabel, type WorkspaceApi } from './launch-workspace.ts'
  import { CREDIT_LINK, CREDIT_TEXT } from './landing-content.ts'
  import { demoKey, demosHref, type ModalCloseReason } from './modal-url.ts'
  import { supportsWebgl2 } from './webgl-support.ts'
  import type { WorkspaceMemory } from './workspace-memory.ts'

  let {
    open = $bindable(false),
    demo = null,
    startStopped = false,
    launcher,
    remembered = null,
    api,
    memory,
    onclose,
    ondemochange,
    onstopped,
    fallbackFocus,
  }: {
    open: boolean
    /** `?demos=<key>`: open at that demo (an unknown key opens the first, with a notice). */
    demo?: string | null
    /** Opened by keyboard or deep link: the carousel starts stopped. */
    startStopped?: boolean
    launcher: DemoLauncher
    /** The remembered Workspace, already checked to exist. */
    remembered?: Workspace | null
    api: WorkspaceApi
    memory: WorkspaceMemory
    onclose?: (reason: ModalCloseReason) => void
    ondemochange?: (key: string) => void
    /** × stopped a launch: the line for the page, or null when nothing was left behind. */
    onstopped?: (text: string | null) => void
    fallbackFocus?: () => HTMLElement | null
  } = $props()

  type Load = { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly text: string }
    | { readonly kind: 'ready'; readonly demos: ReadonlyArray<ModuleFeaturedDefinition>; readonly empty: string | null }
  interface Launch {
    index: number
    title: string
    request: DemoLaunchRequest
    /** The Workspace the launch has reached, for "Open ‹name›" at 30 s. */
    workspace: Workspace | null
    steps: ReadonlyArray<LaunchStepView>
    status: string
    slow: 0 | 1 | 2
    keepWaiting: boolean
    moved: string | null
    failure: DemoLaunchError | null
    note: string | null
  }

  const narrowQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 639px)') : null
  let narrow = $state(narrowQuery?.matches ?? false)
  $effect(() => {
    if (!narrowQuery) return
    const update = (): void => { narrow = narrowQuery.matches }
    narrowQuery.addEventListener('change', update)
    return () => narrowQuery.removeEventListener('change', update)
  })

  let load = $state<Load>({ kind: 'loading' })
  let initial = $state<{ index: number; notice: string | null }>({ index: 0, notice: null })
  let active = $state(0)
  let forceNew = $state(false)
  let launch = $state<Launch | null>(null)
  let copyStatus = $state('')
  let carousel = $state<{ stop(): void } | null>(null)
  let launchHeading = $state<HTMLElement | null>(null)
  let failureBox = $state<HTMLElement | null>(null)
  const webgl = supportsWebgl2()

  const demos = $derived(load.kind === 'ready' ? load.demos : [])
  const destination = $derived(forceNew ? null : remembered)

  const fetchCatalogue = async (): Promise<void> => {
    load = { kind: 'loading' }
    try {
      const catalogue = await readFeaturedCatalogue((input, init) => fetch(input, init))
      const view = catalogueView(catalogue)
      initial = deepLinkedDemo(view.demos, demo)
      active = initial.index
      load = { kind: 'ready', ...view }
    } catch (error) {
      console.error('Featured catalogue failed', errorDiagnostic(error))
      load = { kind: 'failed', text: plainErrorText(error) }
    }
  }

  let wasOpen = false
  $effect(() => {
    if (open && !wasOpen) {
      forceNew = false
      launch = null
      copyStatus = ''
      void fetchCatalogue()
    }
    wasOpen = open
  })

  const onModalClose = (reason: ModalCloseReason): void => {
    // × while busy aborts the client flow; the pending start reports what was left behind.
    if (launcher.busy()) launcher.cancel()
    launch = null
    onclose?.(reason)
  }

  const scheduler = {
    setTimeout: (callback: () => void, ms: number): unknown => window.setTimeout(callback, ms),
    clearTimeout: (handle: unknown): void => window.clearTimeout(handle as number),
  }

  const start = async (
    featured: ModuleFeaturedDefinition, index: number, request: DemoLaunchRequest, target: Workspace | null,
  ): Promise<void> => {
    if (launcher.busy()) return
    carousel?.stop()
    launch = {
      index, title: featured.title, request, workspace: target,
      steps: initialLaunchSteps(target, featured.title),
      status: launchStatusText({ kind: 'checking' }, featured.title),
      slow: 0, keepWaiting: false, moved: null, failure: null, note: null,
    }
    await tick()
    launchHeading?.focus()
    const stopSlow = watchSlowLaunch(scheduler, level => {
      if (!launch) return
      launch.slow = level
      launch.status = level === 1 ? SLOW_TEXT : VERY_SLOW_TEXT
    })
    try {
      const result = await launcher.start(request, {
        api, memory, now: () => new Date(), fetch: (input, init) => fetch(input, init), webgl: () => webgl,
        onstep: step => {
          if (!launch) return
          launch.steps = advanceLaunchSteps(launch.steps, step)
          launch.status = launchStatusText(step, featured.title)
          if (step.kind === 'moving') launch.moved = launch.status
          if (step.kind === 'using-workspace' || step.kind === 'created-workspace' || step.kind === 'starting') launch.workspace = step.workspace
        },
      })
      location.assign(result.destination)
    } catch (error) {
      if (!isDemoLaunchError(error)) throw error
      console.error('Demo launch failed', error.kind, errorDiagnostic(error.cause ?? error))
      if (error.kind === 'aborted') {
        onstopped?.(stoppedText(error))
        return
      }
      if (!launch) return
      launch.failure = error
      launch.status = ''
      await tick()
      ;(failureBox?.querySelector<HTMLElement>('button, a') ?? failureBox)?.focus()
    } finally {
      stopSlow()
    }
  }

  const startActive = (featured: ModuleFeaturedDefinition, index: number): void => {
    void start(featured, index, { demo: demoKey(featured.definition), forceNewWorkspace: forceNew }, destination)
  }

  const tryAgain = (featured: ModuleFeaturedDefinition): void => {
    if (!launch) return
    // A Workspace this launch already reached (and remembered) is reused, never a second new one.
    const reached = launch.failure?.workspace ?? launch.workspace
    if (reached) void start(featured, launch.index, { demo: launch.request.demo, workspaceId: reached.id }, reached)
    else void start(featured, launch.index, launch.request, launch.request.forceNewWorkspace ? null : destination)
  }

  const retryModule = async (featured: ModuleFeaturedDefinition): Promise<void> => {
    const workspace = launch?.failure?.workspace
    if (!launch || !workspace) return
    launch.note = 'Preparing World again…'
    try {
      await api.retryModule(workspace.id, 'world')
    } catch (error) {
      console.error('World retry failed', errorDiagnostic(error))
      launch.note = plainErrorText(error)
      return
    }
    void start(featured, launch.index, { demo: demoKey(featured.definition), workspaceId: workspace.id }, workspace)
  }

  const back = async (): Promise<void> => {
    launch = null
    await tick()
    document.querySelector<HTMLElement>('.lb-modal[open] .start')?.focus()
  }

  const copyLink = async (featured: ModuleFeaturedDefinition): Promise<void> => {
    try {
      await navigator.clipboard.writeText(new URL(demosHref(demoKey(featured.definition)), location.href).href)
      copyStatus = 'Link copied.'
    } catch {
      copyStatus = 'Could not copy the link. Copy it from the address bar instead.'
    }
  }

  const sourcesOf = (featured: ModuleFeaturedDefinition) => {
    const preview = featured.previews[0]!
    const sources = [...preview.sources].sort((a, b) => a.width - b.width)
    return { preview, smallest: sources[0]!.path, srcset: sources.map(source => `${source.path} ${source.width}w`).join(', ') }
  }
  const stepState = (state: LaunchStepView['state']): string => state === 'done' ? 'done' : state === 'doing' ? 'in progress' : 'not started yet'
</script>

{#snippet credit()}{CREDIT_TEXT} · <a href={CREDIT_LINK.href}>{CREDIT_LINK.label}</a>{/snippet}

{#snippet thumb(featured: ModuleFeaturedDefinition)}
  <img src={sourcesOf(featured).smallest} alt="" loading="lazy" decoding="async" width="128" height="80" />
{/snippet}

{#snippet destinationLine()}
  {#if !webgl}
    <span class="where warn">Your browser cannot draw the map (WebGL 2 is off). Try a current desktop browser or an iPad.</span>
  {:else if destination}
    <span class="where">Starts in <b>{workspaceLabel(destination)}</b>, a public Workspace · <button class="inline-link" type="button"
      onclick={() => { forceNew = true }}>Use a new Workspace instead</button></span>
  {:else}
    <span class="where">Creates a new public Workspace for you.{#if remembered} · <button class="inline-link" type="button"
      onclick={() => { forceNew = false }}>Use {workspaceLabel(remembered)} instead</button>{/if}</span>
  {/if}
{/snippet}

{#snippet launchPanel(featured: ModuleFeaturedDefinition, state: Launch)}
  <div class="launch">
    <span class="lb-eyebrow">Starting demo</span>
    <h3 bind:this={launchHeading} tabindex="-1">{state.title}</h3>
    <ol class="steps">
      {#each state.steps as step (step.id)}
        {@const failed = state.failure !== null && step.state === 'doing'}
        <li class={failed ? 'failed' : step.state} aria-current={step.state === 'doing' && !failed ? 'step' : undefined}>
          <span class="ring" aria-hidden="true">{#if step.state === 'done'}<Icon name="check" size={14} />{:else if failed}<Icon name="close" size={14} />{/if}</span>
          <span class="step-text">{step.label}<span class="visually-hidden"> ({failed ? 'stopped' : stepState(step.state)})</span><small>{step.detail}</small></span>
        </li>
      {/each}
    </ol>
    {#if state.moved}<p class="line">{state.moved}</p>{/if}
    {#if !state.failure && state.slow >= 1}<p class="line">{SLOW_TEXT}</p>{/if}
    {#if !state.failure && state.slow === 2 && !state.keepWaiting}
      <div class="slow">
        <p class="line strong">{VERY_SLOW_TEXT}</p>
        <div class="actions">
          <button class="lb-btn lb-btn-sm" type="button" onclick={() => { if (launch) launch.keepWaiting = true }}>Keep waiting</button>
          {#if state.workspace}<a class="lb-btn lb-btn-sm" href={workspacePath(state.workspace.id)}>Open {workspaceLabel(state.workspace)}</a>{/if}
        </div>
      </div>
    {/if}
    {#if state.failure}
      {@const view = launchFailureView(state.failure)}
      {@const where = state.failure.workspace}
      <div class="failure" bind:this={failureBox} tabindex="-1">
        <p class="alert" role="alert"><Icon name="info" size={18} />{view.text}</p>
        {#if state.note}<p class="line" role="status">{state.note}</p>{/if}
        <div class="actions">
          {#if view.actions.includes('try-again')}<button class="lb-btn lb-btn-primary" type="button" onclick={() => tryAgain(featured)}>Try again</button>{/if}
          {#if view.actions.includes('retry-module')}<button class="lb-btn lb-btn-primary" type="button" onclick={() => void retryModule(featured)}>Retry</button>{/if}
          {#if view.actions.includes('open') && where}<a class="lb-btn" href={workspacePath(where.id)}>Open {workspaceLabel(where)}</a>{/if}
          <button class="lb-btn lb-btn-quiet" type="button" onclick={() => void back()}><Icon name="left" size={16} />Back to the demo</button>
        </div>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet slide(featured: ModuleFeaturedDefinition, index: number)}
  {@const media = sourcesOf(featured)}
  <div class="demo">
    <div class="media-col">
      <div class="media">
        <img src={media.smallest} srcset={media.srcset} sizes="(max-width: 900px) 96vw, 620px" alt={media.preview.alt}
          width={media.preview.width} height={media.preview.height} decoding="async"
          loading={index === initial.index ? 'eager' : 'lazy'} />
      </div>
    </div>
    <div class="info">
      {#if launch && launch.index === index}
        {@render launchPanel(featured, launch)}
      {:else}
        <span class="lb-eyebrow accent">{featured.tags[0]}</span>
        <h3>{featured.title}</h3>
        <p class="summary">{featured.summary}</p>
        <span class="lb-eyebrow about-label">About this demo</span>
        <p class="about">{featured.about}</p>
        {#if featured.tags.length > 1}
          <ul class="tags" aria-label="Facts">
            {#each featured.tags.slice(1) as tag (tag)}<li class="lb-chip"><Icon name={demoTagIcon(tag)} size={14} />{tag}</li>{/each}
          </ul>
        {/if}
        <div class="start-row">
          <button class="lb-btn lb-btn-primary lb-btn-lg start" type="button" disabled={!webgl || launch !== null}
            onclick={() => startActive(featured, index)}><Icon name="play" />Start demo</button>
          {@render destinationLine()}
        </div>
        <p class="phone-note">Demos are built for a desktop or iPad screen. Start anyway, or copy the link for later.
          <button class="inline-link" type="button" onclick={() => void copyLink(featured)}>Copy link</button></p>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet phoneFooter()}
  {@const featured = demos[active]}
  {#if featured && !launch}
    <div class="phone-start">
      <button class="lb-btn lb-btn-primary lb-btn-lg" type="button" disabled={!webgl} onclick={() => startActive(featured, active)}
      ><Icon name="play" />Start demo</button>
      {@render destinationLine()}
    </div>
  {/if}
{/snippet}

<Modal bind:open title="Try a demo" eyebrow="Demos" width="1160px" height="content" class="demos-modal"
  onclose={onModalClose} {fallbackFocus} footer={narrow && load.kind === 'ready' && demos.length > 0 ? phoneFooter : undefined}
>
  <div class="demos-body" class:launching={launch !== null}>
    <p class="visually-hidden" role="status">{launch?.status ?? ''}</p>
    <p class="visually-hidden" role="status">{copyStatus}</p>
    {#if load.kind === 'loading'}
      <p class="state">Loading demos…</p>
    {:else if load.kind === 'failed'}
      <div class="state"><p role="alert">{load.text}</p><button class="lb-btn" type="button" onclick={() => void fetchCatalogue()}>Try again</button></div>
    {:else if load.empty}
      <p class="state">{load.empty}</p>
    {:else}
      {#if initial.notice}<p class="notice" role="status">{initial.notice}</p>{/if}
      {#key demos.length}
        <Carousel bind:this={carousel} items={demos} label="Demos" itemTitle={featured => featured.title} {slide} {thumb} {credit}
          nav="thumbs" variant="panel" noun="demo" {startStopped} initialIndex={initial.index}
          onindexchange={(index, featured) => { active = index; ondemochange?.(demoKey(featured.definition)) }} />
      {/key}
    {/if}
  </div>
</Modal>

<style>
  .demos-body { position: relative; }
  .state { display: grid; gap: 12px; justify-items: start; margin: 0; padding: 32px 28px; color: var(--lb-ink-2); }
  .state p { margin: 0; }
  .notice { margin: 0; padding: 10px 28px; border-bottom: 1px solid var(--lb-line); background: var(--lb-surface-2); color: var(--lb-ink-2); font-size: var(--lb-fs-small); }
  .demos-body :global(.lb-carousel .credit) { margin: 0; padding: 0 20px 14px; }

  .demo { display: grid; grid-template-columns: minmax(0, 56%) minmax(0, 1fr); min-width: 0; }
  .media-col { display: grid; align-content: center; padding: 20px; border-right: 1px solid var(--lb-line); background: var(--lb-surface-2); }
  .media { aspect-ratio: 16 / 10; overflow: hidden; border: 1px solid var(--lb-line); border-radius: var(--lb-r-md); background: var(--lb-surface-2); box-shadow: var(--lb-shadow-sm); }
  .media img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: center top; }
  .info { display: grid; gap: 12px; align-content: start; min-width: 0; padding: 24px 28px; }
  .info h3 { margin: 0; font-size: 1.5rem; line-height: 1.2; font-weight: 750; letter-spacing: -.02em; }
  .accent { color: var(--lb-accent); }
  .summary { margin: 0; color: var(--lb-ink); font-size: 1.0625rem; line-height: 1.45; font-weight: 500; }
  .about-label { margin-top: 4px; }
  .about { margin: 0; color: var(--lb-ink-2); font-size: .9375rem; line-height: 1.6; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .start-row { display: grid; gap: 8px; justify-items: start; margin-top: 6px; }
  .where { color: var(--lb-ink-3); font-size: var(--lb-fs-small); line-height: 1.45; }
  .where b { color: var(--lb-ink-2); }
  .where.warn { color: var(--lb-danger); }
  .inline-link { display: inline; min-height: 0; padding: 0; border: 0; border-radius: 3px; background: none; color: var(--lb-accent); font: inherit; font-weight: 600;
    text-decoration: underline; text-underline-offset: .18em; cursor: pointer; }
  .inline-link:hover { border: 0; color: var(--lb-brand-700); }
  .inline-link:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .phone-note { display: none; margin: 0; color: var(--lb-ink-3); font-size: var(--lb-fs-small); }

  /* Launch: replaces the text column only; the image and the modal size stay. */
  .launch { display: grid; gap: 6px; align-content: start; }
  .launch h3:focus { outline: none; }
  .launch h3:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; border-radius: 4px; }
  .steps { display: grid; gap: 12px; margin: 14px 0 6px; padding: 0; list-style: none; }
  .steps li { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: start; gap: 10px; color: var(--lb-ink-3); }
  .ring { display: grid; place-items: center; width: 24px; height: 24px; margin-top: 1px; border: 1.5px solid var(--lb-line-strong); border-radius: 99px; color: #fff; }
  .steps li.doing { color: var(--lb-ink); }
  .steps li.doing .step-text { font-weight: 600; }
  .steps li.doing .ring { border-color: var(--lb-accent); border-right-color: transparent; animation: spin .8s linear infinite; }
  .steps li.done { color: var(--lb-ink); }
  .steps li.done .ring { border-color: var(--lb-ok); background: var(--lb-ok); }
  .steps li.failed { color: var(--lb-ink); }
  .steps li.failed .ring { border-color: var(--lb-danger); background: var(--lb-danger); }
  .step-text { font-size: 1rem; line-height: 1.35; }
  .step-text small { display: block; margin-top: 2px; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); font-weight: 400; }
  .line { margin: 0; color: var(--lb-ink-2); font-size: var(--lb-fs-small); }
  .line.strong { color: var(--lb-ink); font-weight: 600; }
  .slow { display: grid; gap: 8px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  .failure { display: grid; gap: 10px; margin-top: 6px; padding: 14px; border: 1px solid #e3c4c4; border-radius: var(--lb-r-md); background: #fdf6f5; }
  .failure:focus { outline: none; }
  .alert { display: flex; gap: 8px; align-items: flex-start; margin: 0; color: var(--lb-danger); font-weight: 600; line-height: 1.45; }
  .alert :global(svg) { margin-top: 2px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .phone-start { display: grid; gap: 6px; width: 100%; }
  .phone-start .lb-btn { width: 100%; }

  @media (max-width: 1080px) {
    .demo { grid-template-columns: minmax(0, 54%) minmax(0, 1fr); }
    .info { padding: 20px; }
    .info h3 { font-size: 1.3rem; }
    .about { font-size: .875rem; }
  }
  @media (max-width: 900px) {
    .demo { grid-template-columns: minmax(0, 1fr); }
    .media-col { padding: 12px; border-right: 0; border-bottom: 1px solid var(--lb-line); }
  }
  @media (max-width: 639px) {
    .info { padding: 16px; }
    .start-row { display: none; }
    .phone-note { display: block; }
  }
  @media (prefers-reduced-motion: reduce) {
    .steps li.doing .ring { animation: none; border-right-color: var(--lb-accent); }
  }
  @media (forced-colors: active) {
    .ring { border-color: CanvasText; }
    .steps li.done .ring { background: Highlight; border-color: Highlight; }
    .steps li.doing .ring, .steps li.failed .ring { border-color: Highlight; }
  }
</style>
