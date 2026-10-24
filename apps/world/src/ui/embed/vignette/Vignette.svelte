<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import { simulationRunIdSchema } from '../../../core/model/index.ts'
  import { severityStyle, severityTable, type Palette } from '../../displays/severity.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { hostDisplayFrame } from '../view-host.ts'
  import { worstChip } from './alerts.ts'
  import { clockText, provenanceMark, underTitle } from './format.ts'
  import { VIGNETTE_ROW_PX } from './grid.ts'
  import { toneOf, valueLook } from './readout.ts'
  import { createVignetteSession, sampleStale, vignetteRoutes, type VignetteSnapshot } from './vignette-client.ts'
  import Sections from './Sections.svelte'
  import StateWord from './StateWord.svelte'
  import './openbridge.ts'

  // A vignette's frame (architecture B): its title, the "Assistant" mark where
  // the Assistant composed it and the worst it shows; its sections, each
  // within the rows the composer allotted; and a footer saying whether it is
  // LIVE, PAUSED (the Run's clock stopped) or FROZEN (nothing updates: the
  // Run is gone or not loaded, or its samples fail), with the Run's time, and
  // what it is: generated from the model or AI-composed, never an operating
  // display (provenanceMark), in the window, inline in chat and in a
  // procedure tag's dialog alike.
  let { envelope }: { envelope: EmbeddedViewEnvelope } = $props()

  let snapshot = $state.raw<VignetteSnapshot>({ phase: 'connecting', series: new Map(), bands: new Map(), sampleError: null })
  const readPalette = (): Palette => (document.documentElement.dataset.obcTheme as Palette | undefined) ?? 'day'
  let palette = $state<Palette>(readPalette())
  let wallNow = $state(Date.now())

  const runId = $derived(simulationRunIdSchema.parse(envelope.subject.id))
  /** This display, as an element's pop-over names it when it opens the element's default in the display window. */
  const from = $derived({ key: envelope.state, title: envelope.title })
  runOnMount(() => {
    const session = createVignetteSession({
      runId,
      state: envelope.state,
      routes: vignetteRoutes,
      onChange: next => { snapshot = next },
    })
    const unhost = hostDisplayFrame({
      kind: 'advice',
      card: document.querySelector<HTMLElement>('article.vignette'),
      drawing: () => (snapshot.phase === 'connecting' ? undefined : snapshot.view ?? snapshot),
      setVisible: visible => session.setVisible(visible),
      presented: () => {},
    })
    session.start()
    // Staleness is judged on the wall clock, so it shows even while no sample arrives.
    const tick = setInterval(() => { wallNow = Date.now() }, 1_000)
    // The embedding page's theme choice changes the palette live (main.ts).
    const theme = new MutationObserver(() => { palette = readPalette() })
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-obc-theme'] })
    return () => { clearInterval(tick); theme.disconnect(); unhost(); session.close() }
  })

  const view = $derived(snapshot.view)
  const latest = $derived(snapshot.latest)
  const worst = $derived(latest === undefined ? null : worstChip(latest.observations, latest.alerts))
  const footer = $derived.by((): { readonly word: 'LIVE' | 'PAUSED' | 'FROZEN'; readonly why?: string } => {
    const stale = sampleStale(snapshot, wallNow)
    if (snapshot.phase === 'live' && !stale) return { word: latest?.at.paused === true ? 'PAUSED' : 'LIVE' }
    const why = snapshot.sampleError ?? (stale ? 'no answer from the Run for over 5 s' : snapshot.phase === 'inactive' ? 'the Run is not loaded' : snapshot.phase === 'missing' ? 'the Run no longer exists' : undefined)
    return why === undefined ? { word: 'FROZEN' } : { word: 'FROZEN', why }
  })
</script>

<article class="vignette" style:--row={`${VIGNETTE_ROW_PX}px`} aria-label={view?.title ?? envelope.title}>
  <header>
    <h1 title={view?.title ?? envelope.title}>{view?.title ?? envelope.title}</h1>
    {#if view?.by === 'assistant'}<span class="ai" title="Composed by the Assistant from what the Run declares"><obi-ai></obi-ai>Assistant</span>{/if}
    {#if worst?.kind === 'priority'}
      <span class={`chip ${toneOf(worst.priority)}`}>{severityTable[worst.priority].word}</span>
    {:else if worst?.kind === 'undeclared'}
      <span class="chip neutral">{severityStyle(null, worst.severity)!.word}</span>
    {/if}
  </header>

  {#if view?.chips !== undefined}
    <!-- The object's own states (its safety functions, its mode), one row under the title. -->
    <div class="chips">
      {#each view.chips as chip (chip.ref)}<StateWord look={valueLook(chip, latest?.observations ?? [], chip.ref)} label={underTitle(chip.label, view.title)} chip />{/each}
    </div>
  {/if}

  {#if view === undefined}
    <p class="status">
      {#if snapshot.phase === 'missing'}This Run no longer exists.
      {:else if snapshot.phase === 'inactive'}The Run is not loaded; this display starts when it is.
      {:else if snapshot.phase === 'failed'}This display cannot be shown: {snapshot.failure}
      {:else}Connecting to the Run…{/if}
    </p>
  {:else}
    <Sections {view} {snapshot} {palette} frozen={footer.word === 'FROZEN'} {runId} {from} />
  {/if}

  <footer title={footer.why}>
    <span class={`clock ${footer.word.toLowerCase()}`}>{footer.word}</span>
    {#if latest !== undefined}<span>{latest.at.clock === 'simulation' ? 'sim' : 'wall'} {clockText(latest.at.at)}</span>{/if}
    {#if footer.why !== undefined}<span class="why">{footer.why}</span>{/if}
    <span class="mark">{provenanceMark(view)}</span>
  </footer>
</article>

<style>
  .vignette { --muted: var(--element-neutral-color); --text: var(--element-active-color); padding: 0 8px; font-size: 13px; }
  header, footer, .chips { display: flex; align-items: center; gap: 8px; height: var(--row); min-width: 0; white-space: nowrap; }
  h1 { flex: 1 1 auto; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; font-size: 14px; font-weight: 600; }
  .ai { flex: none; display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--element-neutral-color); }
  .ai obi-ai { width: 16px; height: 16px; }
  .chip { flex: none; padding: 0 6px; border: 1px solid; border-radius: 3px; font-size: 12px; font-weight: 700; letter-spacing: 0.03em; }
  .chip.neutral { color: var(--element-active-color); border-color: var(--border-outline-color); }
  .chip.caution { background: var(--display-caution-fill); color: var(--display-on-caution); border-color: var(--alert-caution-color); }
  .chip.warning { background: var(--display-warning-fill); color: var(--display-on-warning); border-color: var(--alert-warning-color); }
  .chip.alarm { background: var(--display-alarm-fill); color: var(--display-on-alarm); border-color: var(--alert-alarm-color); }
  .chip.critical { background: var(--display-critical-fill); color: var(--display-on-critical); border-color: var(--alert-critical-color); }
  .status { margin: 0; padding: 4px 0; color: var(--element-neutral-color); }
  footer { font-size: 12px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; }
  .clock { font-weight: 700; letter-spacing: 0.04em; color: var(--element-active-color); }
  .clock.frozen { color: var(--element-neutral-color); }
  .chips { gap: 12px; overflow: hidden; }
  /* Where the row is short, the reason a sample froze gives way before the mark does. */
  .why { flex: 0 100 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .mark { flex: 0 1 auto; min-width: 0; margin-left: auto; overflow: hidden; text-overflow: ellipsis; }
</style>
