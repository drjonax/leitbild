<script lang="ts">
  // "Try a demo" (plan v2 §5.3): the Modules' featured demos as a carousel,
  // and Start demo's staged launch, which replaces only the slide's text
  // column. A quiet header button switches the same modal to More scenarios,
  // the scenarios the Modules list beside their demos, which start through
  // the same launch flow. The flow, its texts and its error paths live in
  // demo-launch.ts; the view switch and the anchored top in demos-view.ts.
  import { tick } from 'svelte'
  import type { ModuleFeaturedDefinition, ModuleListedDefinition, Workspace } from '@leitbild/contracts'
  import Carousel from './Carousel.svelte'
  import Icon from './Icon.svelte'
  import Modal from './Modal.svelte'
  import {
    advanceLaunchSteps, initialLaunchSteps, isDemoLaunchError, launchFailureView, launchStatusText, SLOW_TEXT, stoppedText,
    VERY_SLOW_TEXT, watchSlowLaunch, type DemoLauncher, type DemoLaunchError, type DemoLaunchRequest, type Launchable, type LaunchNoun,
    type LaunchStepView,
  } from './demo-launch.ts'
  import { DEMOS_TITLE, demosModalTop, MORE_SCENARIOS_TITLE, showDemos, showScenarios, type DemosView } from './demos-view.ts'
  import {
    catalogueView, deepLinkedDemo, demoTagIcon, listedView, NO_SCENARIOS_TEXT, readFeaturedCatalogue,
  } from './featured-catalogue.ts'
  import { errorDiagnostic, plainErrorText } from './error-text.ts'
  import { workspacePath } from './launch-destination.ts'
  import { workspaceLabel, type WorkspaceApi } from './launch-workspace.ts'
  import { CREDIT_LINK, CREDIT_TEXT } from './landing-content.ts'
  import { demoKey, demosHref, type ModalCloseReason, type ModalRoute } from './modal-url.ts'
  import { supportsWebgl2 } from './webgl-support.ts'
  import type { WorkspaceMemory } from './workspace-memory.ts'

  let {
    open = $bindable(false),
    demo = null,
    view: openView = 'demos',
    startStopped = false,
    launcher,
    remembered = null,
    api,
    memory,
    onclose,
    ondemochange,
    onviewchange,
    onstopped,
    fallbackFocus,
  }: {
    open: boolean
    /** `?demos=<key>`: open at that demo (an unknown key opens the first, with a notice). */
    demo?: string | null
    /** `?scenarios` opens the More scenarios list. */
    view?: DemosView
    /** Opened by keyboard or deep link: the carousel starts stopped. */
    startStopped?: boolean
    launcher: DemoLauncher
    /** The remembered Workspace, already checked to exist. */
    remembered?: Workspace | null
    api: WorkspaceApi
    memory: WorkspaceMemory
    onclose?: (reason: ModalCloseReason) => void
    ondemochange?: (key: string) => void
    /** The header switch changed the view: the route to replace in the URL. */
    onviewchange?: (route: ModalRoute) => void
    /** × stopped a launch: the line for the page, or null when nothing was left behind. */
    onstopped?: (text: string | null) => void
    fallbackFocus?: () => HTMLElement | null
  } = $props()

  type Load = { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly text: string }
    | {
      readonly kind: 'ready'; readonly demos: ReadonlyArray<ModuleFeaturedDefinition>; readonly empty: string | null
      readonly scenarios: ReadonlyArray<ModuleListedDefinition>; readonly scenariosEmpty: string | null
    }
  interface Launch {
    /** A demo from the carousel, or a scenario from the More scenarios list. */
    noun: LaunchNoun
    /** The slide, or the list row. */
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
  let carousel = $state<{ stop(): void; current(): number } | null>(null)
  let launchHeading = $state<HTMLElement | null>(null)
  let failureBox = $state<HTMLElement | null>(null)
  let view = $state<DemosView>('demos')
  let modal = $state<{ focusTitle(): void; element(): HTMLDialogElement | null } | null>(null)
  let body = $state<HTMLElement | null>(null)
  let demosPane = $state<HTMLElement | null>(null)
  let scenariosPane = $state<HTMLElement | null>(null)
  /** Once the list has shown, the modal's top edge stays where the demos view is centred. */
  let anchorTop = $state<number | null>(null)
  /** The list's height when a scenario started, so its progress does not shrink the modal. */
  let launchMinHeight = $state<number | null>(null)
  const webgl = supportsWebgl2()
  const uid = `demos-${Math.random().toString(36).slice(2, 8)}`

  const demos = $derived(load.kind === 'ready' ? load.demos : [])
  const scenarios = $derived(load.kind === 'ready' ? load.scenarios : [])
  const destination = $derived(forceNew ? null : remembered)

  // The demos view's height measures the same whether it shows or is parked behind the list.
  const anchor = (): void => {
    const dialog = modal?.element()
    const row = body?.parentElement
    if (!dialog || !row || !demosPane || load.kind !== 'ready') return
    anchorTop = demosModalTop({ viewportHeight: innerHeight, chrome: dialog.offsetHeight - row.offsetHeight, demosBody: demosPane.scrollHeight })
  }
  $effect(() => {
    if (anchorTop === null) return
    addEventListener('resize', anchor)
    return () => removeEventListener('resize', anchor)
  })

  const switchView = async (next: DemosView): Promise<void> => {
    const busy = launcher.busy() || launch !== null
    const route = next === 'scenarios' ? showScenarios({ busy, carousel }) : showDemos({ busy, carousel, demos })
    if (route === null || next === view) return
    anchor()
    view = next
    onviewchange?.(route)
    await tick()
    modal?.focusTitle()
  }

  const fetchCatalogue = async (): Promise<void> => {
    load = { kind: 'loading' }
    try {
      const catalogue = await readFeaturedCatalogue((input, init) => fetch(input, init))
      const shown = catalogueView(catalogue)
      const listed = listedView(catalogue)
      initial = deepLinkedDemo(shown.demos, demo)
      active = initial.index
      load = { kind: 'ready', ...shown, scenarios: listed.scenarios, scenariosEmpty: listed.empty }
      // A list opened by deep link anchors once the parked demos view has laid out.
      if (view === 'scenarios') {
        await tick()
        anchor()
      }
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
      view = openView
      anchorTop = null
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
    featured: Launchable, at: { readonly noun: LaunchNoun; readonly index: number }, request: DemoLaunchRequest, target: Workspace | null,
  ): Promise<void> => {
    if (launcher.busy()) return
    carousel?.stop()
    const { noun, index } = at
    if (noun === 'scenario' && launch === null) launchMinHeight = scenariosPane?.offsetHeight ?? null
    launch = {
      noun, index, title: featured.title, request, workspace: target,
      steps: initialLaunchSteps(target, featured.title),
      status: launchStatusText({ kind: 'checking' }, featured.title, noun),
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
          launch.steps = advanceLaunchSteps(launch.steps, step, noun)
          launch.status = launchStatusText(step, featured.title, noun)
          if (step.kind === 'moving') launch.moved = launch.status
          if (step.kind === 'using-workspace' || step.kind === 'created-workspace' || step.kind === 'starting') launch.workspace = step.workspace
        },
      })
      location.assign(result.destination)
    } catch (error) {
      if (!isDemoLaunchError(error)) throw error
      console.error(noun === 'demo' ? 'Demo launch failed' : 'Scenario launch failed', error.kind, errorDiagnostic(error.cause ?? error))
      if (error.kind === 'aborted') {
        onstopped?.(stoppedText(error, noun))
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
    void start(featured, { noun: 'demo', index }, { demo: demoKey(featured.definition), forceNewWorkspace: forceNew }, destination)
  }
  const startScenario = (listed: ModuleListedDefinition, index: number): void => {
    void start(listed, { noun: 'scenario', index }, { demo: demoKey(listed.definition), forceNewWorkspace: forceNew }, destination)
  }

  const tryAgain = (featured: Launchable): void => {
    if (!launch) return
    // A Workspace this launch already reached (and remembered) is reused, never a second new one.
    const reached = launch.failure?.workspace ?? launch.workspace
    if (reached) void start(featured, launch, { demo: launch.request.demo, workspaceId: reached.id }, reached)
    else void start(featured, launch, launch.request, launch.request.forceNewWorkspace ? null : destination)
  }

  const retryModule = async (featured: Launchable): Promise<void> => {
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
    void start(featured, launch, { demo: demoKey(featured.definition), workspaceId: workspace.id }, workspace)
  }

  const back = async (): Promise<void> => {
    const from = launch
    launch = null
    launchMinHeight = null
    await tick()
    const target = from?.noun === 'scenario' ? `[data-scenario-start="${from.index}"]` : '.start'
    document.querySelector<HTMLElement>(`.lb-modal[open] ${target}`)?.focus()
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

{#snippet launchPanel(featured: Launchable, state: Launch)}
  <div class="launch">
    <span class="lb-eyebrow">Starting {state.noun}</span>
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
      {@const failed = launchFailureView(state.failure, state.noun)}
      {@const where = state.failure.workspace}
      <div class="failure" bind:this={failureBox} tabindex="-1">
        <p class="alert" role="alert"><Icon name="info" size={18} />{failed.text}</p>
        {#if state.note}<p class="line" role="status">{state.note}</p>{/if}
        <div class="actions">
          {#if failed.actions.includes('try-again')}<button class="lb-btn lb-btn-primary" type="button" onclick={() => tryAgain(featured)}>Try again</button>{/if}
          {#if failed.actions.includes('retry-module')}<button class="lb-btn lb-btn-primary" type="button" onclick={() => void retryModule(featured)}>Retry</button>{/if}
          {#if failed.actions.includes('open') && where}<a class="lb-btn" href={workspacePath(where.id)}>Open {workspaceLabel(where)}</a>{/if}
          <button class="lb-btn lb-btn-quiet" type="button" onclick={() => void back()}><Icon name="left" size={16} />{state.noun === 'demo' ? 'Back to the demo' : 'Back to the list'}</button>
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
          loading={index === initial.index && view === 'demos' ? 'eager' : 'lazy'} />
      </div>
    </div>
    <div class="info">
      {#if launch && launch.noun === 'demo' && launch.index === index}
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

{#snippet headerSwitch()}
  {#if view === 'scenarios'}
    <button class="switch" type="button" aria-label="Back to demos" aria-controls={`${uid}-body`}
      aria-disabled={launch ? 'true' : undefined} onclick={() => void switchView('demos')}><Icon name="left" size={18} />Demos</button>
  {:else if load.kind === 'ready' && scenarios.length > 0}
    <button class="switch" type="button" aria-controls={`${uid}-body`} aria-disabled={launch ? 'true' : undefined}
      onclick={() => void switchView('scenarios')}><Icon name="list" size={18} /><span class="long">More scenarios</span><span class="short" aria-hidden="true">Scenarios</span></button>
  {/if}
{/snippet}

{#snippet scenarioList()}
  {#if load.kind === 'loading'}
    <p class="state">Loading scenarios…</p>
  {:else if load.kind === 'failed'}
    <div class="state"><p role="alert">{load.text}</p><button class="lb-btn" type="button" onclick={() => void fetchCatalogue()}>Try again</button></div>
  {:else if load.scenariosEmpty === NO_SCENARIOS_TEXT}
    <div class="state"><p>{load.scenariosEmpty}</p><button class="lb-btn" type="button" onclick={() => void switchView('demos')}>Back to demos</button></div>
  {:else if load.scenariosEmpty}
    <div class="state"><p role="alert">{load.scenariosEmpty}</p><button class="lb-btn" type="button" onclick={() => void fetchCatalogue()}>Try again</button></div>
  {:else if launch && launch.noun === 'scenario'}
    {@const listed = scenarios[launch.index]}
    <div class="scenario-launch" style:min-height={launchMinHeight === null ? null : `${launchMinHeight}px`}>
      {#if listed}{@render launchPanel(listed, launch)}{/if}
    </div>
  {:else}
    <div class="intro">
      <p>Scenarios without a guided tour.</p>
      <p>{@render destinationLine()}</p>
    </div>
    <ul class="rows" aria-label={MORE_SCENARIOS_TITLE}>
      {#each scenarios as listed, index (demoKey(listed.definition))}
        <li class="row">
          <div class="row-main">
            <div class="row-head">
              <h3>{listed.title}</h3>
              <ul class="row-tags" aria-label="Facts">
                {#each listed.tags as tag (tag)}<li class="lb-chip">{tag}</li>{/each}
              </ul>
            </div>
            <p class="row-summary">{listed.summary}</p>
          </div>
          <button class="lb-btn row-start" type="button" data-scenario-start={index} disabled={!webgl || launch !== null}
            onclick={() => startScenario(listed, index)}><Icon name="play" size={14} />Start<span class="visually-hidden">{` ${listed.title}`}</span></button>
        </li>
      {/each}
    </ul>
    <p class="list-note">Every scenario, including ones you build, is on a Workspace's page{#if remembered}: <a href={workspacePath(remembered.id)}>Open {workspaceLabel(remembered)}</a>{/if}.</p>
  {/if}
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

<div class="anchor" style:--demos-top={anchorTop === null ? null : `${anchorTop}px`}>
<Modal bind:this={modal} bind:open title={view === 'scenarios' ? MORE_SCENARIOS_TITLE : DEMOS_TITLE} eyebrow="Demos" width="1160px" height="content"
  class="demos-modal{anchorTop === null ? '' : ' anchored'}" headerExtra={headerSwitch}
  onclose={onModalClose} {fallbackFocus} footer={narrow && view === 'demos' && load.kind === 'ready' && demos.length > 0 ? phoneFooter : undefined}
>
  <div class="demos-body" id={`${uid}-body`} class:launching={launch !== null} bind:this={body}>
    <p class="visually-hidden" role="status">{launch?.status ?? ''}</p>
    <p class="visually-hidden" role="status">{copyStatus}</p>
    <!-- Parked (not removed) behind the list: the carousel keeps its slide and stays stopped. -->
    <div class="demos-pane" class:parked={view !== 'demos'} inert={view !== 'demos'} aria-hidden={view !== 'demos' ? 'true' : undefined} bind:this={demosPane}>
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
    {#if view === 'scenarios'}
      <div class="scenarios-pane" bind:this={scenariosPane}>{@render scenarioList()}</div>
    {/if}
  </div>
</Modal>
</div>

<style>
  .anchor { display: contents; }
  /* Once the list has shown, the top edge stays put and each view keeps its own height (full-screen sheets below 640 px). */
  @media (min-width: 640px) {
    .anchor :global(.lb-modal.demos-modal.anchored) { margin-top: var(--demos-top); margin-bottom: auto; max-height: calc(100dvh - var(--demos-top) - 16px); }
  }
  .demos-body { position: relative; }
  .demos-pane.parked { position: absolute; inset: 0 0 auto; height: 0; overflow: hidden; visibility: hidden; }

  /* The header switch: quiet text, never a second primary. */
  .switch { display: inline-flex; flex: none; align-items: center; gap: 6px; min-height: 40px; padding: 0 12px; border: 1px solid transparent; border-radius: var(--lb-r-md);
    background: transparent; color: var(--lb-ink-2); font: inherit; font-size: .875rem; font-weight: 600; white-space: nowrap; cursor: pointer; }
  @media (hover: hover) { .switch:hover { background: rgba(23, 32, 25, .06); color: var(--lb-ink); } }
  .switch:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .switch[aria-disabled="true"] { opacity: .6; cursor: not-allowed; }

  /* More scenarios: compact rows, no images. */
  .scenarios-pane { display: grid; gap: 14px; padding: 20px 28px 22px; }
  .intro { display: grid; gap: 2px; }
  .intro p { margin: 0; color: var(--lb-ink-2); font-size: .9375rem; line-height: 1.5; }
  .rows { margin: 0; padding: 0; list-style: none; border: 1px solid var(--lb-line); border-radius: var(--lb-r-lg); background: var(--lb-surface); }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px 16px; min-height: 76px; padding: 14px 16px 14px 20px; }
  .row + .row { border-top: 1px solid var(--lb-line); }
  .row-main { display: grid; gap: 4px; min-width: 0; }
  .row-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
  .row h3 { margin: 0; color: var(--lb-ink); font-size: 1rem; line-height: 1.35; font-weight: 650; }
  .row-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .row-tags .lb-chip { min-height: 22px; }
  .row-summary { max-width: 78ch; margin: 0; color: var(--lb-ink-2); font-size: .875rem; line-height: 1.5; }
  .list-note { margin: 0; color: var(--lb-ink-3); font-size: var(--lb-fs-small); }
  .list-note a { color: var(--lb-accent); font-weight: 600; }
  .list-note a:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .scenario-launch { display: grid; align-content: start; }

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
    .scenarios-pane { padding: 16px; }
    .row { grid-template-columns: minmax(0, 1fr); padding: 14px 16px; }
    .row-start { justify-self: start; min-height: 44px; }
  }
  /* iPhone SE / mini: "Scenarios", still named "More scenarios". */
  .short { display: none; }
  @media (max-width: 379px) {
    .long { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .short { display: inline; }
    .switch { padding: 0 8px; }
  }
  @media (pointer: coarse) {
    .switch { min-height: 44px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .steps li.doing .ring { animation: none; border-right-color: var(--lb-accent); }
  }
  @media (forced-colors: active) {
    .switch:focus-visible { border-color: Highlight; }
    .ring { border-color: CanvasText; }
    .steps li.done .ring { background: Highlight; border-color: Highlight; }
    .steps li.doing .ring, .steps li.failed .ring { border-color: Highlight; }
  }
</style>
