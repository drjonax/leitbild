<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import { simulationRunIdSchema } from '../../../core/model/index.ts'
  import { severityStyle, severityTable, type Palette } from '../../displays/severity.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { hostDisplayFrame } from '../view-host.ts'
  import { worstChip } from './alerts.ts'
  import { clockText } from './format.ts'
  import { VIGNETTE_ROW_PX } from './grid.ts'
  import { readingLook, toneOf, valueLook } from './readout.ts'
  import { createVignetteSession, vignetteRoutes, type VignetteSnapshot } from './vignette-client.ts'
  import AlertsSection from './AlertsSection.svelte'
  import EntityTable from './EntityTable.svelte'
  import GroupedValues from './GroupedValues.svelte'
  import MapFocus from './MapFocus.svelte'
  import NetworkTopology from './NetworkTopology.svelte'
  import Readout from './Readout.svelte'
  import StateWord from './StateWord.svelte'
  import TrendStrip from './TrendStrip.svelte'
  import './openbridge.ts'

  // A vignette's frame (architecture B): its title, the "Assistant" mark where
  // the Assistant composed it and the worst it shows; its sections, each
  // within the rows the composer allotted; and a footer saying whether it is
  // LIVE, PAUSED (the Run's clock stopped) or FROZEN (nothing updates: the
  // Run is gone or not loaded, or its samples fail), with the Run's time.
  let { envelope }: { envelope: EmbeddedViewEnvelope } = $props()

  let snapshot = $state.raw<VignetteSnapshot>({ phase: 'connecting', series: new Map(), sampleError: null })
  const readPalette = (): Palette => (document.documentElement.dataset.obcTheme as Palette | undefined) ?? 'day'
  let palette = $state<Palette>(readPalette())

  runOnMount(() => {
    const session = createVignetteSession({
      runId: simulationRunIdSchema.parse(envelope.subject.id),
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
    // The embedding page's theme choice changes the palette live (main.ts).
    const theme = new MutationObserver(() => { palette = readPalette() })
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-obc-theme'] })
    return () => { theme.disconnect(); unhost(); session.close() }
  })

  const view = $derived(snapshot.view)
  const latest = $derived(snapshot.latest)
  const observations = $derived(latest?.observations ?? [])
  const now = $derived(latest === undefined ? Number.NaN : Date.parse(latest.at.at))
  const worst = $derived(latest === undefined ? null : worstChip(latest.observations, latest.alerts))
  const footer = $derived.by((): { readonly word: 'LIVE' | 'PAUSED' | 'FROZEN'; readonly why?: string } => {
    if (snapshot.phase === 'live' && snapshot.sampleError === null) return { word: latest?.at.paused === true ? 'PAUSED' : 'LIVE' }
    const why = snapshot.sampleError ?? (snapshot.phase === 'inactive' ? 'the Run is not loaded' : snapshot.phase === 'missing' ? 'the Run no longer exists' : undefined)
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

  {#if view === undefined}
    <p class="status">
      {#if snapshot.phase === 'missing'}This Run no longer exists.
      {:else if snapshot.phase === 'inactive'}The Run is not loaded; this display starts when it is.
      {:else if snapshot.phase === 'failed'}This display cannot be shown: {snapshot.failure}
      {:else}Connecting to the Run…{/if}
    </p>
  {:else}
    {#each view.sections as section, index (index)}
      <div class="section" style:height={`${section.rows * VIGNETTE_ROW_PX}px`}>
        {#if section.kind === 'values'}
          {#each section.values as value (value.ref)}
            {@const look = valueLook(value, observations, value.ref)}
            {#if look.kind === 'state'}<StateWord {look} label={value.label} />{:else}<Readout {look} label={value.label} />{/if}
          {/each}
        {:else if section.kind === 'grouped'}
          <GroupedValues {section} {observations} />
        {:else if section.kind === 'trend'}
          {#each section.strips as pens, strip (strip)}
            <TrendStrip {pens} series={snapshot.series} {observations} {now} horizonMs={section.horizonMs} rows={Math.max(3, pens.length)} axis={strip === section.strips.length - 1} />
          {/each}
        {:else if section.kind === 'alerts'}
          <AlertsSection rows={latest?.alerts ?? []} objectIds={section.objectIds} room={section.rows} {palette} />
        {:else if section.kind === 'entity'}
          <EntityTable {section} rows={latest?.entities?.[index]?.rows ?? []} more={latest?.entities?.[index]?.more ?? 0} />
        {:else if section.kind === 'slots'}
          {#each section.slots as slot (slot.key)}
            {@const read = latest?.slots?.[section.objectId]?.[slot.key]}
            <!-- Core slots and telemetry carry no observation priority: they read neutral. -->
            {@const look = readingLook(slot.label, typeof read?.value === 'number' ? 'number' : 'enum', undefined, { value: read?.value, unit: slot.unit, thresholds: [], ...(read?.since === undefined ? {} : { since: read.since }) })}
            {#if look.kind === 'state'}<StateWord {look} label={slot.label} />{:else}<Readout {look} label={slot.label} />{/if}
          {/each}
        {:else if section.kind === 'map'}
          <MapFocus frame={latest?.maps?.[index]} />
        {:else}
          <!-- Network and, until their symbols land, flow topologies: the layout's boxes and lines. -->
          <NetworkTopology {section} {observations} {palette} />
        {/if}
      </div>
    {/each}
  {/if}

  <footer title={footer.why}>
    <span class={`clock ${footer.word.toLowerCase()}`}>{footer.word}</span>
    {#if latest !== undefined}<span>sim {clockText(latest.at.at)}</span>{/if}
    {#if footer.why !== undefined}<span class="why">{footer.why}</span>{/if}
  </footer>
</article>

<style>
  .vignette { --muted: var(--element-neutral-color); --text: var(--element-active-color); padding: 0 8px; font-size: 13px; }
  header, footer { display: flex; align-items: center; gap: 8px; height: var(--row); min-width: 0; white-space: nowrap; }
  h1 { flex: 1 1 auto; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; font-size: 14px; font-weight: 600; }
  .ai { flex: none; display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--element-neutral-color); }
  .ai obi-ai { width: 16px; height: 16px; }
  .chip { flex: none; padding: 0 6px; border: 1px solid; border-radius: 3px; font-size: 12px; font-weight: 700; letter-spacing: 0.03em; }
  .chip.neutral { color: var(--element-active-color); border-color: var(--border-outline-color); }
  .chip.caution { background: var(--display-caution-fill); color: var(--display-on-caution); border-color: var(--alert-caution-color); }
  .chip.warning { background: var(--display-warning-fill); color: var(--display-on-warning); border-color: var(--alert-warning-color); }
  .chip.alarm { background: var(--display-alarm-fill); color: var(--display-on-alarm); border-color: var(--alert-alarm-color); }
  .chip.critical { background: var(--display-critical-fill); color: var(--display-on-critical); border-color: var(--alert-critical-color); }
  .section { overflow: hidden; }
  .status { margin: 0; padding: 4px 0; color: var(--element-neutral-color); }
  footer { font-size: 12px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; }
  .clock { font-weight: 700; letter-spacing: 0.04em; color: var(--element-active-color); }
  .clock.frozen { color: var(--element-neutral-color); }
  .why { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
</style>
