<script lang="ts">
  // The landing page at /workspaces (plan v2 §2–§3): top bar, hero with the
  // owner's tagline and a 6-slide carousel, the map credit and the footer.
  // It owns the modal deep links (?demos, ?guide) and loads both modals on
  // demand. It selects no Workspace; the remembered one is only a hint.
  import { onMount, type Component } from 'svelte'
  import type { Workspace } from '@leitbild/contracts'
  import { version } from '../../package.json'
  import Carousel from './Carousel.svelte'
  import Icon from './Icon.svelte'
  import Modal from './Modal.svelte'
  import Wordmark from './Wordmark.svelte'
  import WorkspaceSwitcher from './WorkspaceSwitcher.svelte'
  import { createDemoLauncher } from './demo-launch.ts'
  import { workspacePath } from './launch-destination.ts'
  import { createWorkspaceApi, rememberedWorkspace, workspaceLabel } from './launch-workspace.ts'
  import {
    CREDIT_LINK, CREDIT_TEXT, FACTS, FOOTER_NOTE, HERO_IMAGE_HEIGHT_960, HERO_IMAGE_SIZES, HERO_IMAGE_WIDTHS, HERO_SLIDES,
    LANDING_TITLE, LICENCE_HREF, PLAIN_LINE, TAGLINE, heroLinkRoute, heroSrcset, slidesToLoad, type HeroSlide,
  } from './landing-content.ts'
  import { createModalUrl, modalRouteUrl, NO_MODAL, type ModalCloseReason, type ModalRoute } from './modal-url.ts'
  import { browserWorkspaceMemory } from './workspace-memory.ts'

  const memory = browserWorkspaceMemory()
  const api = createWorkspaceApi()
  const launcher = createDemoLauncher()
  const modalUrl = createModalUrl(window)

  // Hero images, by file stem and width.
  const imageUrls = import.meta.glob('./assets/landing/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
  const imagesOf = (slide: HeroSlide): { src: string; srcset: string } => {
    const urls = new Map(HERO_IMAGE_WIDTHS.map(width => [width, imageUrls[`./assets/landing/${slide.image}-${width}.webp`] ?? '']))
    return { src: urls.get(960) ?? '', srcset: heroSrcset(urls) }
  }

  // The remembered Workspace is a hint: checked with the Host, never a redirect.
  let hinted = $state(memory.remembered() !== null)
  let remembered = $state<Workspace | null>(null)
  let rememberedNotice = $state<string | null>(null)
  let stopped = $state('')

  let route = $state<ModalRoute>(modalUrl.route())
  let openedBy = $state<'keyboard' | 'pointer' | 'link'>('link')
  let demosOpen = $state(false)
  let guideOpen = $state(false)
  let menuOpen = $state(false)
  let DemosModal = $state<Component<any> | null>(null)
  let GuideModal = $state<Component<any> | null>(null)
  let tryButton = $state<HTMLElement | null>(null)
  let guideButton = $state<HTMLElement | null>(null)

  let current = $state(0)
  let shown = $state(new Set<number>([0]))
  let idle = $state(false)
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true
  const loaded = $derived(slidesToLoad({ count: HERO_SLIDES.length, current, shown, idle, saveData }))

  $effect(() => { demosOpen = route.kind === 'demos' })
  $effect(() => { guideOpen = route.kind === 'guide' })
  $effect(() => {
    if (route.kind === 'demos' && !DemosModal) void import('./DemosModal.svelte').then(module => { DemosModal = module.default })
    if (route.kind === 'guide' && !GuideModal) void import('./GuideModal.svelte').then(module => { GuideModal = module.default })
  })

  const refreshRemembered = (): void => {
    rememberedWorkspace({ api, memory }).then(result => {
      remembered = result.workspace
      rememberedNotice = result.notice
    }, error => { console.error('Remembered Workspace check failed', error) })
  }
  // A launch that stopped or failed may have created (and remembered) a Workspace: offer to continue there.
  const onDemosClosed = (reason: ModalCloseReason): void => {
    onModalClose(reason)
    const id = memory.remembered()
    if (id !== null && id !== remembered?.id) {
      hinted = true
      refreshRemembered()
    }
  }

  /** Opening a modal pushes its parameter; how it was opened decides whether Demos rotates. */
  const openRoute = (next: ModalRoute, event?: MouseEvent): void => {
    openedBy = event === undefined ? 'link' : event.detail === 0 ? 'keyboard' : 'pointer'
    stopped = ''
    modalUrl.open(next)
    route = next
  }
  const routeHref = (next: ModalRoute): string => modalRouteUrl(next, location.href)
  const onRouteClick = (next: ModalRoute) => (event: MouseEvent): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    openRoute(next, event)
  }
  // × / Esc / backdrop remove the parameter; Back already did when the close is programmatic.
  const onModalClose = (reason: ModalCloseReason): void => {
    if (reason === 'programmatic') return
    modalUrl.close()
    route = NO_MODAL
  }
  const fromMenu = (next: ModalRoute) => (event: MouseEvent): void => {
    menuOpen = false
    openRoute(next, event)
  }

  onMount(() => {
    document.title = LANDING_TITLE
    const unsubscribe = modalUrl.subscribe(next => {
      openedBy = 'link'
      route = next
    })
    if (hinted) refreshRemembered()
    // The next slide's image loads after the page has loaded and gone idle (C12).
    const whenIdle = (): void => {
      const request = (window as Window & { requestIdleCallback?: (callback: () => void) => number }).requestIdleCallback
      if (request) request(() => { idle = true })
      else setTimeout(() => { idle = true }, 200)
    }
    if (document.readyState === 'complete') whenIdle()
    else addEventListener('load', whenIdle, { once: true })
    return () => {
      unsubscribe()
      modalUrl.destroy()
      removeEventListener('load', whenIdle)
    }
  })
</script>

{#snippet heroSlide(slide: HeroSlide, index: number)}
  {@const image = imagesOf(slide)}
  {@const target = heroLinkRoute(slide.link)}
  <div class="slide-media">
    {#if loaded.has(index)}
      <img src={image.src} srcset={image.srcset} sizes={HERO_IMAGE_SIZES} alt={slide.alt} width="960" height={HERO_IMAGE_HEIGHT_960}
        decoding="async" loading={index === 0 ? 'eager' : 'lazy'} fetchpriority={index === 0 ? 'high' : undefined} />
    {/if}
  </div>
  <div class="caption">
    <span class="lb-eyebrow">{slide.eyebrow}</span>
    <h2>{slide.title}</h2>
    <p>{slide.blurb}</p>
    <a class="lb-text-link" href={routeHref(target)} aria-haspopup="dialog" onclick={onRouteClick(target)}
    >{slide.link.label}{#if slide.link.kind === 'guide'}<span class="visually-hidden">: {slide.title}</span>{/if}<Icon name="arrow" size={15} /></a>
  </div>
{/snippet}

{#snippet credit()}{CREDIT_TEXT} · <a href={CREDIT_LINK.href}>{CREDIT_LINK.label}</a>{/snippet}

<a class="lb-skip-link" href="#main">Skip to content</a>

<header class="bar">
  <Wordmark tone="dark" mark href="/workspaces" label="Leitbild.ai home" />
  <span class="sep" aria-hidden="true"></span>
  <WorkspaceSwitcher current={remembered} {api} {memory} />
  <nav class="nav" aria-label="Main">
    <div class="wide">
      <a class="nav-link" href={routeHref({ kind: 'guide', page: 'start', card: null })} aria-haspopup="dialog"
        onclick={onRouteClick({ kind: 'guide', page: 'start', card: null })}><Icon name="compass" />Getting started</a>
      <a class="nav-link" href={routeHref({ kind: 'demos', demo: null })} aria-haspopup="dialog"
        onclick={onRouteClick({ kind: 'demos', demo: null })}><Icon name="demos" />Demos</a>
      <a class="nav-link" href="/wiki"><Icon name="book" /><span class="wiki-label">Wiki</span></a>
    </div>
    <button class="nav-link menu" type="button" aria-haspopup="dialog" onclick={() => { menuOpen = true }}><Icon name="dots" />Menu</button>
    <a class="nav-link ask" href={routeHref({ kind: 'guide', page: 'ask', card: null })} aria-haspopup="dialog"
      title="Ask the Leitbild Assistant" onclick={onRouteClick({ kind: 'guide', page: 'ask', card: null })}><Icon name="ai" />Ask</a>
  </nav>
</header>

<main id="main" class="landing" tabindex="-1">
  <section class="hero" aria-labelledby="hero-title">
    <div class="hero-grid">
      <div class="copy">
        <div class="titles">
          <h1 id="hero-title"><Wordmark size="hero" /></h1>
          <p class="tagline">{#each TAGLINE as part}{#if 'strong' in part}<strong>{part.text}</strong>{:else}{part.text}{/if}{/each}</p>
        </div>
        <p class="plain">{PLAIN_LINE}</p>
        <div class="ctas">
          <a bind:this={tryButton} class="lb-btn lb-btn-primary lb-btn-lg" href={routeHref({ kind: 'demos', demo: null })} aria-haspopup="dialog"
            onclick={onRouteClick({ kind: 'demos', demo: null })}><Icon name="play" />Try a demo</a>
          <a bind:this={guideButton} class="lb-btn lb-btn-lg" href={routeHref({ kind: 'guide', page: 'start', card: null })} aria-haspopup="dialog"
            onclick={onRouteClick({ kind: 'guide', page: 'start', card: null })}><Icon name="compass" />Getting started</a>
        </div>
        {#if hinted}
          <!-- Reserved while the hint is checked, so nothing below it moves (C12 CLS). -->
          <div class="return">
            {#if remembered}
              <a class="return-link" href={workspacePath(remembered.id)}>Continue in <b>{workspaceLabel(remembered)}</b><Icon name="arrow" size={16} /></a>
            {:else if rememberedNotice}
              <p class="return-note" role="status">{rememberedNotice}</p>
            {/if}
          </div>
        {/if}
        <p class="stopped" role="status">{stopped}</p>
        <ul class="facts">
          {#each FACTS as fact (fact)}<li><Icon name="ok" size={15} />{fact}</li>{/each}
        </ul>
      </div>
      <div class="show">
        <Carousel items={HERO_SLIDES} label="Leitbild highlights" itemTitle={slide => slide.title} slide={heroSlide} {credit}
          variant="hero" observeVisibility onindexchange={index => { current = index; if (!shown.has(index)) shown = new Set([...shown, index]) }} />
      </div>
    </div>
  </section>
</main>

<footer class="foot">
  <span><Wordmark size="inline" /> · v{version}</span>
  <a href={LICENCE_HREF}>MIT licence</a>
  <a href={CREDIT_LINK.href}>Data credits</a>
  <a href="/wiki">Wiki</a>
  <span class="foot-note">{FOOTER_NOTE}</span>
</footer>

<Modal bind:open={menuOpen} title="Menu" width="420px" class="menu-sheet">
  <ul class="menu-list">
    <li><a href={routeHref({ kind: 'guide', page: 'start', card: null })} onclick={fromMenu({ kind: 'guide', page: 'start', card: null })}><Icon name="compass" />Getting started</a></li>
    <li><a href={routeHref({ kind: 'demos', demo: null })} onclick={fromMenu({ kind: 'demos', demo: null })}><Icon name="demos" />Demos</a></li>
    <li><a href="/wiki"><Icon name="book" />Wiki</a></li>
    <li><a href={routeHref({ kind: 'guide', page: 'ask', card: null })} onclick={fromMenu({ kind: 'guide', page: 'ask', card: null })}><Icon name="ai" />Ask the Leitbild Assistant</a></li>
  </ul>
</Modal>

{#if DemosModal}
  <DemosModal bind:open={demosOpen} demo={route.kind === 'demos' ? route.demo : null} startStopped={openedBy !== 'pointer'}
    {launcher} {remembered} {api} {memory} onclose={onDemosClosed} fallbackFocus={() => tryButton}
    ondemochange={(key: string) => { if (route.kind === 'demos') modalUrl.replace({ kind: 'demos', demo: key }) }}
    onstopped={(text: string | null) => { stopped = text ?? '' }} />
{/if}
{#if GuideModal}
  <GuideModal bind:open={guideOpen} page={route.kind === 'guide' ? route.page : 'start'} card={route.kind === 'guide' ? route.card : null}
    onpagechange={(page: string) => { if (route.kind === 'guide') modalUrl.replace({ kind: 'guide', page, card: null }) }}
    ontrydemo={(demo: string | null, how: { keyboard: boolean }) => {
      const next: ModalRoute = { kind: 'demos', demo }
      openedBy = how.keyboard ? 'keyboard' : 'pointer'
      modalUrl.replace(next)
      route = next
    }}
    onclose={onModalClose} fallbackFocus={() => guideButton} />
{/if}

<style>
  /* Top bar (56 px; VISUAL-SPEC §3.2). */
  .bar { position: sticky; top: 0; z-index: 40; display: flex; align-items: center; gap: var(--lb-s3); height: var(--lb-topbar-h);
    padding: 0 var(--lb-gutter); border-bottom: 1px solid #0d150f; background: var(--lb-brand-900); color: var(--lb-on-dark); }
  .sep { width: 1px; height: 24px; background: var(--lb-on-dark-line); }
  .nav { display: flex; align-items: center; gap: 2px; margin-left: auto; }
  .wide { display: flex; align-items: center; gap: 2px; }
  .nav-link { display: inline-flex; align-items: center; gap: .45rem; min-height: 40px; padding: 0 .75rem; border: 0; border-radius: var(--lb-r-sm);
    background: transparent; color: var(--lb-on-dark); font-size: .875rem; font-weight: 550; text-decoration: none; white-space: nowrap; cursor: pointer; }
  .nav-link:hover { background: rgba(255, 255, 255, .08); border-color: transparent; }
  .nav-link:focus-visible { outline: 2px solid var(--lb-focus-on-dark); outline-offset: 2px; }
  .nav-link :global(svg) { color: var(--lb-on-dark-2); }
  .nav-link.ask { min-height: 36px; margin-left: 6px; padding: 0 .8rem; border: 1px solid #3f6249; background: #2b4a35; color: #fff; }
  .nav-link.ask :global(svg) { color: #fff; }
  .nav-link.ask:hover { background: #355b41; }
  .menu { display: none; }
  .bar :global(.wordmark:focus-visible) { outline-color: var(--lb-focus-on-dark); }

  /* Hero (plan v2 §3: text column top-aligned, fits 900 px at 1440×900). */
  main.landing { width: auto; margin: 0; padding: 0; }
  main.landing:focus { outline: none; }
  .hero { position: relative; isolation: isolate; padding: clamp(20px, 3.5vh, 36px) var(--lb-gutter) 24px; }
  .hero::before { content: ""; position: absolute; inset: 0 0 auto; z-index: -1; height: 560px;
    background: radial-gradient(circle at 1px 1px, rgba(22, 35, 26, .07) 1px, transparent 0) 0 0 / 22px 22px, linear-gradient(180deg, var(--lb-canvas-deep), var(--lb-canvas));
    -webkit-mask-image: linear-gradient(180deg, #000 60%, transparent); mask-image: linear-gradient(180deg, #000 60%, transparent); }
  .hero-grid { display: grid; grid-template-columns: minmax(300px, 400px) minmax(0, 1fr); gap: clamp(28px, 4vw, 56px); align-items: start;
    max-width: var(--lb-max); margin: 0 auto; }
  .copy { display: grid; gap: var(--lb-s5); align-content: start; padding-top: 56px; }
  .titles { display: grid; gap: 10px; }
  h1 { margin: 0; color: var(--lb-brand-900); font-size: var(--lb-fs-display); line-height: 1; }
  .tagline { margin: 0; color: var(--lb-ink-2); font-size: clamp(1.125rem, 1rem + .45vw, 1.3rem); line-height: 1.35; font-weight: 500; letter-spacing: -.012em; text-wrap: balance; }
  .tagline strong { color: var(--lb-ink); font-weight: 650; }
  .plain { margin: 0; color: var(--lb-ink-2); font-size: 1rem; line-height: 1.6; text-wrap: pretty; }
  .ctas { display: flex; flex-wrap: wrap; gap: var(--lb-s3); }
  .return { min-height: 44px; }
  .return-link { display: inline-flex; align-items: center; gap: .45rem; min-height: 44px; padding: 0 14px; border: 1px solid var(--lb-line);
    border-radius: var(--lb-r-lg); background: rgba(255, 255, 255, .75); color: var(--lb-ink); font-size: .9rem; text-decoration: none; }
  .return-link:hover { border-color: var(--lb-line-strong); background: #fff; }
  .return-link:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .return-link b { font-weight: 650; }
  .return-link :global(svg) { color: var(--lb-ink-3); }
  .return-note { margin: 0; padding-top: 10px; color: var(--lb-ink-2); font-size: var(--lb-fs-small); }
  .stopped { margin: 0; color: var(--lb-ink-2); font-size: var(--lb-fs-small); }
  .stopped:empty { display: none; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0; padding: 0; list-style: none; color: var(--lb-ink-3); font-size: var(--lb-fs-small); }
  .facts li { display: inline-flex; align-items: center; gap: 6px; }
  .facts :global(svg) { color: var(--lb-ok); }
  .show { min-width: 0; }

  /* Hero slides: image on --lb-surface-2, a solid caption band. */
  .slide-media { position: relative; aspect-ratio: 16 / 10; overflow: hidden; border-bottom: 1px solid var(--lb-line); background: var(--lb-surface-2); }
  .slide-media img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: center top; }
  .caption { display: grid; gap: 4px; align-content: start; min-height: 124px; padding: 16px max(20px, var(--car-controls-reserve)) 18px 20px; }
  .caption .lb-eyebrow { color: var(--lb-accent); }
  .caption h2 { margin: 0; font-size: 1.125rem; line-height: 1.3; font-weight: 700; letter-spacing: -.01em; }
  .caption p { margin: 0; max-width: 62ch; color: var(--lb-ink-2); font-size: .9375rem; line-height: 1.5; }
  .caption .lb-text-link { justify-self: start; margin-top: 4px; }

  /* Footer: outside <main>, one quiet line. */
  .foot { display: flex; flex-wrap: wrap; gap: 8px 20px; max-width: var(--lb-max); margin: 0 auto; padding: 12px var(--lb-gutter) 28px;
    color: var(--lb-ink-3); font-size: var(--lb-fs-micro); }
  .foot a { color: inherit; }
  .foot a:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .foot-note { margin-left: auto; }

  /* Menu sheet (phones). */
  .menu-list { display: grid; gap: 2px; margin: 0; padding: 8px; list-style: none; }
  .menu-list a { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 0 12px; border-radius: var(--lb-r-md);
    color: var(--lb-ink); font-size: 1rem; font-weight: 600; text-decoration: none; }
  .menu-list a:hover { background: var(--lb-surface-2); }
  .menu-list a:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: -2px; }
  .menu-list :global(svg) { color: var(--lb-ink-3); }

  @media (max-width: 1180px) {
    .hero-grid { grid-template-columns: minmax(300px, 356px) minmax(0, 1fr); gap: 28px; }
    .copy { padding-top: 24px; }
    .ctas { gap: 8px; }
    .ctas .lb-btn-lg { padding: 0 1rem; font-size: .9375rem; }
  }
  @media (max-width: 1023px) {
    .wiki-label { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  }
  @media (max-width: 900px) {
    .hero-grid { grid-template-columns: minmax(0, 1fr); }
    .copy { gap: 18px; padding-top: 0; }
  }
  @media (max-width: 700px) {
    .bar { --lb-topbar-h: 52px; gap: 8px; }
    .sep { display: none; }
    .caption { min-height: 0; padding: 14px 16px 6px; }
    .caption h2 { font-size: 1.0625rem; }
    .caption p { font-size: .875rem; }
    .foot-note { margin-left: 0; }
  }
  @media (max-width: 639px) {
    .wide, .nav-link.ask { display: none; }
    .menu { display: inline-flex; }
    .ctas .lb-btn { flex: 1 1 auto; }
  }
  @media (pointer: coarse) {
    .nav-link { min-height: 44px; }
    .foot a, .caption .lb-text-link { display: inline-flex; align-items: center; min-height: 44px; }
  }
</style>
