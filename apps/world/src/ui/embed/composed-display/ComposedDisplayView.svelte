<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import { simulationRunIdSchema } from '../../../core/model/index.ts'
  import { composedDisplayLayout, composedTrendStripHeights, detailDisplayStateSchema, processDisplayStatePlantId, processDisplayStateSchema } from '../../../packs/process-plant/displays/composition.ts'
  import type { MimicDrawnItem } from '../../../packs/process-plant/displays/mimic/mimic-model.ts'
  import { simulationClock } from '../../../packs/process-plant/displays/display-text.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { composedDisplayClient } from './composed-display-client.ts'
  import { createComposedDisplaySession, type ComposedDisplaySnapshot } from './composed-display-session.ts'
  import AlarmsPanel from './AlarmsPanel.svelte'
  import AnnunciatorTiles from './AnnunciatorTiles.svelte'
  import ComparisonPanel from './ComparisonPanel.svelte'
  import PenLegend from './PenLegend.svelte'
  import ReadoutsPanel from './ReadoutsPanel.svelte'
  import MimicPanel from './mimic/MimicPanel.svelte'
  import TrendPanel from './TrendPanel.svelte'
  import { agoText, alarmAge } from './panel-presenters.ts'
  import { trendWindowMs } from './trend-geometry.ts'

  let { envelope }: { envelope: EmbeddedViewEnvelope } = $props()

  // An agent's advice, or a display World generates (a unit overview, or equipment opened from it); only advice has a question, a need and an issue time.
  const parsed = $derived(processDisplayStateSchema.parse(JSON.parse(envelope.state)))
  const advice = $derived('composition' in parsed ? parsed : null)
  const plantId = $derived(processDisplayStatePlantId(parsed))
  const title = $derived(advice?.composition.title ?? (snapshot?.view?.kind === 'detail' ? snapshot.view.display.title : envelope.title))

  // A sample older than this marks the view stale (polling is 1 Hz).
  const STALE_AFTER_MS = 5_000
  // How long a window must keep its size before an overview is drawn again for it.
  const RELAYOUT_AFTER_MS = 300

  let snapshot = $state<ComposedDisplaySnapshot | null>(null)
  let wallNow = $state(Date.now())
  // Created once on mount; the envelope of an embedded view never changes.
  let session: ReturnType<typeof createComposedDisplaySession> | undefined

  runOnMount(() => {
    const active = createComposedDisplaySession({
      runId: simulationRunIdSchema.parse(envelope.subject.id),
      plantId,
      state: envelope.state,
      client: composedDisplayClient,
      onChange: next => { snapshot = next; keepFilter(next) },
      suspendWhenIdle: advice !== null,
      size: () => (advice === null ? { width: window.innerWidth, height: window.innerHeight } : null),
    })
    session = active
    void active.start()
    const interacted = (): void => { active.interacted(); lastInputWallMs = Date.now() }
    const visibility = (): void => active.setVisible(document.visibilityState === 'visible')
    const clock = setInterval(() => {
      wallNow = Date.now()
      void active.sized()
      if (systemFilter !== null && wallNow - lastInputWallMs > FILTER_IDLE_MS) systemFilter = null
    }, 1_000)
    // A unit overview is drawn for its window: once resizing settles, it is drawn again for the new size
    // (or first drawn, where the window had no size when it opened).
    let resizing: ReturnType<typeof setTimeout> | undefined
    const resized = (): void => {
      if (advice !== null) return
      clearTimeout(resizing)
      resizing = setTimeout(() => { void active.relayout() }, RELAYOUT_AFTER_MS)
    }
    window.addEventListener('resize', resized)
    document.addEventListener('pointerdown', interacted)
    document.addEventListener('pointermove', interacted)
    document.addEventListener('keydown', interacted)
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') back() }
    document.addEventListener('keydown', escape)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      active.close()
      clearInterval(clock)
      document.removeEventListener('pointerdown', interacted)
      document.removeEventListener('pointermove', interacted)
      document.removeEventListener('keydown', interacted)
      document.removeEventListener('keydown', escape)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('resize', resized)
      clearTimeout(resizing)
    }
  })

  const view = $derived(snapshot?.view)

  // A generated display opens what a drawn item stands for in place; Back
  // returns along the displays opened before it. A display that cannot be
  // drawn leaves the current one and says why.
  let trail = $state<ReadonlyArray<{ readonly state: string; readonly title: string }>>([])
  // Null while the view shows the state it was embedded with.
  let shownState: string | null = null
  let opening = $state(false)
  let openError = $state<string | null>(null)

  const show = async (next: string, nextTrail: typeof trail, name: string): Promise<void> => {
    if (session === undefined || opening) return
    opening = true
    openError = null
    try {
      await session.open(next)
      shownState = next
      systemFilter = null
      trail = nextTrail
    } catch (error) {
      openError = `${name} cannot be opened: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      opening = false
    }
  }

  const openItem = (item: MimicDrawnItem): void => {
    if (view === undefined) return
    const next = JSON.stringify(detailDisplayStateSchema.parse({ detail: { plantId, components: item.components } }))
    const current = shownState ?? envelope.state
    if (next === current) return
    void show(next, [...trail, { state: current, title: view.display.title }], item.binding.label)
  }

  const back = (): void => {
    const previous = trail.at(-1)
    if (previous !== undefined) void show(previous.state, trail.slice(0, -1), previous.title)
  }
  const opens = $derived(advice === null ? openItem : undefined)

  // A unit overview's annunciator tiles narrow its alarm list to one system.
  // The narrowing never hides news: it ends by itself on a new trip or
  // first-out alarm in another system, after a minute without input, and on
  // opening anything; the tiles, the frames in the drawing and the trip notice
  // are never narrowed.
  const FILTER_IDLE_MS = 60_000
  let systemFilter = $state<string | null>(null)
  let lastInputWallMs = Date.now()
  let seenElsewhere = new Set<string>()
  const alarmsPanel = $derived(view?.display.panels.find(panel => panel.kind === 'alarms'))
  const systems = $derived(alarmsPanel?.kind === 'alarms' ? alarmsPanel.systems ?? [] : [])
  const tileWidth = $derived(alarmsPanel?.kind === 'alarms' ? alarmsPanel.tileWidth : undefined)
  const narrowedTo = $derived(systems.find(system => system.id === systemFilter) ?? null)
  // The drawing dims only where the system frames something in it; otherwise nothing of it is drawn here.
  const highlight = $derived.by(() => {
    if (narrowedTo === null) return null
    const rules = new Set(narrowedTo.ruleIds)
    const drawn = view?.display.panels.some(panel => panel.kind === 'mimic' && panel.mimic.items.some(item => item.binding.frames.some(frame => rules.has(frame.ruleId))))
    return drawn === true ? rules : null
  })
  const decisiveElsewhere = (next: ComposedDisplaySnapshot, ruleIds: ReadonlyArray<string>): ReadonlyArray<string> => {
    const rules = new Set(ruleIds)
    return (next.latest?.alarms ?? []).filter(alarm => alarm.active && (alarm.kind === 'trip' || alarm.firstOut) && !rules.has(alarm.ruleId)).map(alarm => alarm.id)
  }
  const selectSystem = (id: string | null): void => {
    const system = systems.find(candidate => candidate.id === id)
    seenElsewhere = new Set(system === undefined || snapshot === null ? [] : decisiveElsewhere(snapshot, system.ruleIds))
    lastInputWallMs = Date.now()
    systemFilter = system?.id ?? null
  }
  const keepFilter = (next: ComposedDisplaySnapshot): void => {
    if (narrowedTo === null) return
    if (decisiveElsewhere(next, narrowedTo.ruleIds).some(id => !seenElsewhere.has(id))) systemFilter = null
  }
  const adviceView = $derived(view?.kind === 'advice' ? view : undefined)
  const issuedAt = $derived(advice === null ? null : Date.parse(advice.issuedAt))
  const adviceStale = $derived(advice !== null && (snapshot?.resetSinceAdvice === true || adviceView?.modelChanged === true || adviceView?.drawingChanged === true))
  const now = $derived(Date.parse(snapshot?.latest?.simulationTime ?? view?.simulationTime ?? advice?.issuedAt ?? ''))
  const stale = $derived(snapshot?.phase.kind === 'live'
    && (snapshot.sampleError !== null || (snapshot.lastSampleWallMs !== undefined && wallNow - snapshot.lastSampleWallMs > STALE_AFTER_MS)))

  const stateChip = $derived.by((): { text: string; tone: 'live' | 'quiet' | 'warn' } => {
    const phase = snapshot?.phase.kind ?? 'checking'
    if (phase === 'live' && stale) return { text: 'Stale', tone: 'warn' }
    if (phase === 'live') return snapshot?.playback === 'paused' ? { text: 'Paused', tone: 'quiet' } : { text: 'Live', tone: 'live' }
    if (phase === 'suspended') return { text: 'Updates paused', tone: 'quiet' }
    if (phase === 'inactive') return { text: 'Run not active', tone: 'quiet' }
    if (phase === 'missing') return { text: 'Run removed', tone: 'warn' }
    if (phase === 'failed') return { text: 'Unavailable', tone: 'warn' }
    return { text: 'Connecting', tone: 'quiet' }
  })

  // Recorded history cannot reach before the Run started; trends say so.
  const runStartedAt = $derived(snapshot?.latest === undefined ? null : Date.parse(snapshot.latest.simulationTime) - snapshot.latest.plantElapsedMs)
  const activeRuleIds = $derived(new Set((snapshot?.latest?.alarms ?? []).filter(alarm => alarm.active).map(alarm => alarm.ruleId)))
  // A protection trip changes the plant state; it leads the notice line.
  const activeTrip = $derived((snapshot?.latest?.alarms ?? []).filter(alarm => alarm.active && alarm.kind === 'trip')
    .sort((left, right) => (left.firstActiveElapsedMs ?? 0) - (right.firstActiveElapsedMs ?? 0))[0])

  // A unit overview fills its window. Where the window is wide enough its
  // drawing takes the window's height, beside a column of lead values over
  // the alarms; otherwise the three stack and scroll. The compiler sizes the
  // drawing for the same layout (compose.ts, overviewDrawingRoom).
  const layout = composedDisplayLayout
  const overview = $derived(advice === null)
  let cardWidth = $state(document.documentElement.clientWidth)
  const overviewMimic = $derived(view?.display.panels.find(panel => panel.kind === 'mimic'))
  const beside = $derived(overview && overviewMimic?.kind === 'mimic'
    && cardWidth - 2 * layout.overviewPadding >= overviewMimic.mimic.width + layout.overviewColumnGap + layout.overviewColumn)
  const statusShown = $derived(snapshot === null || ['checking', 'starting', 'missing', 'inactive', 'failed'].includes(snapshot.phase.kind))
  // Beside the drawing, the footer closes the column.
  const columnShown = $derived(beside && !statusShown && view !== undefined)
</script>

{#snippet notice()}
  <!-- One reserved notice line; the most consequential notice wins. Advice can go stale; an overview cannot. -->
  <p class="banner" class:quiet={!adviceStale && activeTrip === undefined && openError === null} class:trip={activeTrip !== undefined && !adviceStale && openError === null} title={openError ?? undefined}>
    {#if advice !== null && snapshot?.resetSinceAdvice}
      The Run was reset after this advice. The advice may no longer apply.
    {:else if adviceView?.modelChanged}
      The Plant model changed after this advice was composed.
    {:else if adviceView?.drawingChanged}
      The equipment drawing changed after this advice was composed.
    {:else if openError !== null}
      {openError}
    {:else if activeTrip !== undefined && snapshot?.latest !== undefined}
      TRIP · {activeTrip.title} · {alarmAge(snapshot.latest.plantElapsedMs, activeTrip.firstActiveElapsedMs)} ago
    {:else if snapshot?.phase.kind === 'suspended'}
      Updates paused after 15 minutes without interaction. <button type="button" onclick={() => session?.resume()}>Resume</button>
    {:else if snapshot?.phase.kind === 'live' && snapshot.sampleError !== null}
      Showing the last received values. {snapshot.sampleError}
    {:else if snapshot?.phase.kind === 'live' && issuedAt !== null}
      Advice issued at sim {simulationClock(issuedAt)} · {agoText(now - issuedAt)}
    {/if}
  </p>
{/snippet}

{#snippet footerLine()}
  <footer>{advice === null ? 'Generated from the Plant model' : 'AI-composed view'} · thresholds from the Plant's I&amp;C rules · not an operating display</footer>
{/snippet}

<article class="card" class:overview class:opening aria-busy={opening} aria-label={advice === null ? title : `AI-composed view: ${title}`} bind:clientWidth={cardWidth}>
  <header>
    {#if trail.length > 0}
      <button type="button" class="back" onclick={back} disabled={opening} title={`Back to ${trail.at(-1)!.title} (Esc)`}>‹ {trail.at(-1)!.title}</button>
    {/if}
    <h1 {title}>{title}</h1>
    {#if overview}
      <!-- An overview's title names its unit; its Run and its notice line share this row, so the panels keep the window's height. -->
      {#if snapshot?.runTitle !== undefined}<span class="run" title={`Run: ${snapshot.runTitle}`}>Run: {snapshot.runTitle}</span>{/if}
      {@render notice()}
    {/if}
    {#if snapshot?.latest?.mode !== undefined}
      <!-- The operating mode the Plant's I&C declares, read each sample; plain text, as a normal state is. -->
      <span class="mode" title="Operating mode: the first of the Plant's declared modes that holds">{snapshot.latest.mode === null ? 'No declared mode holds' : snapshot.latest.mode.label}</span>
    {/if}
    <span class={`chip ${stateChip.tone}`}>{stateChip.text}</span>
    {#if Number.isFinite(now)}<span class="clock">sim {simulationClock(now)}</span>{/if}
  </header>
  {#if advice !== null}
    <!-- Provenance: which unit and which Run the view is about. -->
    <p class="unit" title={`${view?.plantLabel ?? plantId}${snapshot?.runTitle === undefined ? '' : ` · Run: ${snapshot.runTitle}`}`}>{view?.plantLabel ?? plantId}{#if snapshot?.runTitle !== undefined}{' · '}Run: {snapshot.runTitle}{/if}</p>
    <p class="caption" title={`${advice.composition.question} — ${advice.composition.need}`}>
      <strong>Why this view:</strong> {advice.composition.question} <span class="need">{advice.composition.need}</span>
    </p>
    {@render notice()}
  {/if}

  {#if snapshot === null || snapshot.phase.kind === 'checking' || snapshot.phase.kind === 'starting'}
    <p class="status">Connecting to the Run…</p>
  {:else if snapshot.phase.kind === 'missing'}
    <p class="status">This Run no longer exists.{advice === null ? '' : ' The advice above referred to it.'}</p>
  {:else if snapshot.phase.kind === 'inactive'}
    <div class="status">
      <p>The Run is not active, so nothing is updating.</p>
      <button type="button" onclick={() => { void session?.loadRun() }}>Load run</button>
      <p class="hint">Loading starts the Run's simulation runtime.</p>
    </div>
  {:else if snapshot.phase.kind === 'failed'}
    <p class="status">This view cannot be shown: {snapshot.phase.message}</p>
  {:else if view && columnShown}
    <div class="panels beside" style={`gap:${layout.overviewColumnGap}px`}>
      <div class="drawing">
        {#each view.display.panels as panel, index (index)}
          {#if panel.kind === 'mimic'}<MimicPanel mimic={panel.mimic} latest={snapshot.latest} {stale} open={opens} {highlight} />{/if}
        {/each}
      </div>
      <div class="column" style={`width:${layout.overviewColumn}px;gap:${layout.panelGap}px`}>
        {#each view.display.panels as panel, index (index)}
          {#if panel.kind === 'readouts'}
            <ReadoutsPanel {panel} latest={snapshot.latest} {activeRuleIds} column history={snapshot} />
          {:else if panel.kind === 'alarms'}
            {#if systems.length > 0 && tileWidth !== undefined}<AnnunciatorTiles {systems} {tileWidth} latest={snapshot.latest} selected={systemFilter} select={selectSystem} />{/if}
            <AlarmsPanel {panel} latest={snapshot.latest} fill only={narrowedTo === null ? null : { ...narrowedTo, drawn: highlight !== null }} showAll={() => selectSystem(null)} />
          {/if}
        {/each}
        {@render footerLine()}
      </div>
    </div>
  {:else if view}
    <div class="panels" style={`gap:${composedDisplayLayout.panelGap}px`}>
      {#each view.display.panels as panel, index (index)}
        {#if panel.kind === 'trend'}
          {@const charts = composedTrendStripHeights(panel.strips.length, panel.plot)}
          {@const windowMs = trendWindowMs(panel.horizonMs, now, runStartedAt)}
          <div>
            {#each panel.strips as strip, stripIndex (strip.pens[0]!.measurement)}
              <TrendPanel
                {strip}
                horizon={panel.horizon}
                horizonMs={panel.horizonMs}
                {windowMs}
                series={snapshot.series}
                range={snapshot.ranges[index]?.[stripIndex] ?? null}
                {now}
                {issuedAt}
                {runStartedAt}
                height={charts[stripIndex]!}
                timeAxis={stripIndex === panel.strips.length - 1}
                adviceLabel={stripIndex === 0}
                mode={snapshot.latest?.mode}
                {activeRuleIds}
              />
              <PenLegend pens={strip.pens} horizonMs={panel.horizonMs} latest={snapshot.latest} series={snapshot.series} historyMissing={snapshot.historyMissing} {activeRuleIds} />
            {/each}
            {#if panel.live.length > 0}
              <PenLegend pens={panel.live} horizonMs={panel.horizonMs} live latest={snapshot.latest} series={snapshot.series} historyMissing={snapshot.historyMissing} {activeRuleIds} />
            {/if}
          </div>
        {:else if panel.kind === 'comparison'}
          <ComparisonPanel {panel} latest={snapshot.latest} series={snapshot.series} range={snapshot.ranges[index]?.[0] ?? null} {activeRuleIds} />
        {:else if panel.kind === 'readouts'}
          <ReadoutsPanel {panel} latest={snapshot.latest} {activeRuleIds} />
        {:else if panel.kind === 'mimic'}
          <MimicPanel mimic={panel.mimic} latest={snapshot.latest} {stale} open={opens} {highlight} />
        {:else}
          {#if systems.length > 0 && tileWidth !== undefined}<AnnunciatorTiles {systems} {tileWidth} latest={snapshot.latest} selected={systemFilter} select={selectSystem} />{/if}
          <AlarmsPanel {panel} latest={snapshot.latest} only={narrowedTo === null ? null : { ...narrowedTo, drawn: highlight !== null }} showAll={() => selectSystem(null)} />
        {/if}
      {/each}
    </div>
  {/if}

  {#if !columnShown}{@render footerLine()}{/if}
</article>

<style>
  .card { display: flex; flex-direction: column; gap: 4px; height: 100vh; padding: 8px 10px 6px; overflow: hidden; }
  header { display: flex; align-items: center; gap: 8px; min-width: 0; }
  h1 { margin: 0; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 auto; }
  .unit, .clock { font-size: 11.5px; color: var(--element-neutral-color); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .unit { margin: -2px 0 0; overflow: hidden; text-overflow: ellipsis; }
  .mode { flex: none; font-size: 12px; font-weight: 600; padding: 1px 7px; border-radius: 3px; border: 1px solid var(--border-outline-color); color: var(--element-active-color); white-space: nowrap; }
  .chip { font-size: 11px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--border-outline-color); white-space: nowrap; }
  .chip.live { color: var(--element-active-color); }
  .chip.quiet { color: var(--element-neutral-color); }
  .chip.warn { color: var(--alert-caution-color); border-color: var(--alert-caution-color); }
  .caption { margin: 0; font-size: 12px; color: var(--element-active-color); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .need { color: var(--element-neutral-color); }
  .banner { margin: 0; height: 22px; padding: 0 8px; display: flex; align-items: center; gap: 8px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: var(--container-section-color); border-left: 3px solid var(--alert-caution-color); }
  .banner.quiet { background: none; border-left-color: transparent; color: var(--element-neutral-color); padding-left: 0; }
  .banner.trip { border-left-color: var(--alert-alarm-color); font-weight: 600; }
  .status { margin: 8px 0; color: var(--element-neutral-color); }
  .status p { margin: 4px 0; }
  .hint { font-size: 11.5px; }
  button { font: inherit; font-size: 12px; padding: 1px 10px; border: 1px solid var(--border-outline-color); border-radius: 4px; background: var(--container-section-color); color: var(--element-active-color); cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 1px; }
  .back { flex: none; padding: 0 8px; height: 22px; white-space: nowrap; }
  .back:disabled, .opening :global(.target) { cursor: progress; }
  .panels { display: flex; flex-direction: column; }
  /* A unit overview fills its window: one header row (composedDisplayLayout.overviewFrame), then its panels. Nothing is shrunk; stacked, they scroll when the window is smaller. */
  .overview header { flex: none; height: 22px; }
  .overview h1 { flex: 0 1 auto; }
  .overview .banner { flex: 1 1 0; min-width: 0; }
  .run { flex: 0 1 auto; min-width: 0; font-size: 11.5px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .overview .panels { flex: 1 1 auto; min-height: 0; overflow: auto; }
  .overview .panels > :global(*) { flex-shrink: 0; }
  .panels.beside { flex-direction: row; }
  .drawing { flex: 1 1 auto; min-width: 0; }
  .column { flex: none; display: flex; flex-direction: column; min-height: 0; }
  .column > :global(*) { flex-shrink: 0; }
  footer { margin-top: auto; font-size: 10.5px; color: var(--element-neutral-color); }
  .overview footer { flex: none; line-height: 14px; }
</style>
