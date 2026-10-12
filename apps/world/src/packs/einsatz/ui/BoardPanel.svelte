<script lang="ts">
  import { untrack } from 'svelte'
  import { loadMapSymbols } from '../../../ui/map-runtime/map-symbols.ts'
  import type { SurfacePanelProps } from '../../../ui/surface-panel-interaction.ts'
  import { runOnMount } from '../../../ui/svelte-lifecycle.svelte.ts'
  import { boardWords } from '../board/text.ts'
  import type { ClickTarget } from '../board/types.ts'
  import type { EinsatzConfig } from '../config-schema.ts'
  import { invokeBoardCommand, queryBoardRecommendation, readBoardConfiguration } from './board-client.ts'
  import { boardIconIds, createBoardIcons } from './board-icons.ts'
  import { boardBottomClearancePx, boardEdgeGapPx, boardLayoutFor, boardMapCover, boardSections, boardTopClearancePx } from './board-layout.ts'
  import { logTime, stripHeading } from './board-presenter.ts'
  import { createBoardSession, type BoardSession } from './board-session.ts'
  import { createBoardTone, type BoardTone } from './board-tone.ts'
  import { boardMapOrders } from './map-orders.ts'
  import { screenViewerFor } from './screen-viewer.ts'
  import BoardContacts from './BoardContacts.svelte'
  import BoardUnits from './BoardUnits.svelte'
  import BoardWorkList from './BoardWorkList.svelte'

  /**
   * The Einsatz Board: a thin view over the Board controller, which one
   * session runs for this screen's perspective (a role switch remounts the
   * panel). It reads the configuration once, then lends the map its
   * controllers and the World its keys and map targets. Its inputs reach the
   * controller as events; its view is the controller's view, rendered again
   * after every event, and every word it shows is the view's, or before a
   * configuration is there, the Board's mechanism words. It lies over the
   * map's right edge, narrow enough to leave the map clear, and pads the map
   * camera by its observed width.
   */
  const props: SurfacePanelProps = $props()

  let session = $state.raw<BoardSession | null>(null)
  let revision = $state(0)
  let problem = $state<string | null>(null)
  let retry = $state.raw<(() => void) | null>(null)
  let surfaceWidth = $state(0)
  let root = $state<HTMLElement | null>(null)
  let tone: BoardTone | null = null

  const icons = createBoardIcons({ load: loadMapSymbols, changed: () => { revision += 1 } })
  const view = $derived.by(() => {
    void revision
    return session?.view() ?? null
  })
  // Until the configuration arrives the Board takes the work list's width.
  const layout = $derived(boardLayoutFor(surfaceWidth, view?.arrangement.lead ?? 'work-list'))
  const sections = $derived(view === null ? [] : boardSections(view.arrangement))
  const heading = $derived(view === null ? boardWords.board : stripHeading(view))
  const missingArtwork = $derived.by(() => {
    void revision
    return icons.missing()
  })
  const icon = (id: string): string | undefined => icons.svg(id)
  const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

  const click = (target: ClickTarget): void => {
    if (target.kind === 'enable-sound' && tone === null) {
      try {
        tone = createBoardTone()
      } catch (error) {
        problem = `${boardWords.soundFailed}: ${messageOf(error)}`
        return
      }
    }
    session?.dispatch({ kind: 'click', target })
  }

  const closeTone = async (closing: BoardTone): Promise<void> => {
    try {
      await closing.close()
    } catch (error) {
      console.error('Einsatz Board sound', error)
    }
  }

  runOnMount(() => {
    // Where the Board lies first: nothing starts unless it lies in the World surface.
    const element = root
    const surface = element?.parentElement
    if (!element || !surface) throw new Error('The Board was not mounted inside the World surface')
    let disposed = false
    let current: BoardSession | null = null
    const releases: Array<() => void> = []
    const viewer = screenViewerFor(props.roleSet)
    // A Run's declaration carries no sides when it declares none.
    const sides = props.roleSet?.declaration.sides ?? []
    const simulationRunId = props.simulationRunId

    const surfaceObserver = new ResizeObserver(() => { surfaceWidth = surface.clientWidth })
    surfaceObserver.observe(surface)
    const boardObserver = new ResizeObserver(() => { props.onMapCover(boardMapCover(element.getBoundingClientRect().width)) })
    boardObserver.observe(element)
    const ticker = window.setInterval(() => { current?.tick(props.objects, props.currentTime()) }, 200)

    const start = async (): Promise<void> => {
      problem = null
      retry = null
      let config: EinsatzConfig
      try {
        config = await readBoardConfiguration(simulationRunId)
      } catch (error) {
        if (disposed) return
        problem = `${boardWords.readFailed}: ${messageOf(error)}`
        retry = () => { void start() }
        return
      }
      if (disposed) return
      current = createBoardSession({
        config,
        viewer,
        sides,
        ports: {
          invoke: async (capabilityId, input) => await invokeBoardCommand(simulationRunId, capabilityId, input),
          recommend: async taskId => await queryBoardRecommendation(simulationRunId, taskId),
          select: objectId => props.onSelectObject(objectId),
          sound: kind => {
            if (tone === null) throw new Error('The Board asked for a tone before sound was enabled')
            tone.play(kind)
          },
          wallMs: () => Date.now(),
          changed: () => { revision += 1 },
          failed: error => {
            console.error('Einsatz Board', error)
            problem = `${boardWords.failed}: ${messageOf(error)}`
          },
        },
      })
      // The map controllers before the map targets: lending the surface the Board's handlers makes it select its controllers again (`ui/map-orders.ts`).
      releases.push(boardMapOrders.connect({ config, roles: props.roleSet?.declaration.roles ?? [] }))
      releases.push(props.connectInteraction({ onKey: current.onKey, onMapTarget: current.onMapTarget, previewMapTarget: current.previewMapTarget }))
      session = current
    }
    void start()

    return () => {
      disposed = true
      window.clearInterval(ticker)
      surfaceObserver.disconnect()
      boardObserver.disconnect()
      for (const release of releases.reverse()) release()
      current?.dispose()
      if (tone !== null) void closeTone(tone)
      tone = null
    }
  })

  // The screen's inputs reach the controller as events, each on every change of its prop.
  $effect(() => {
    const objects = props.objects
    const current = session
    if (current === null) return
    untrack(() => current.observe(objects, props.currentTime()))
  })
  $effect(() => {
    const objectId = props.selectedObjectId
    const current = session
    if (current === null) return
    untrack(() => current.dispatch({ kind: 'selection', objectId }))
  })
  $effect(() => {
    const active = props.keysActive
    const current = session
    if (current === null) return
    untrack(() => current.dispatch({ kind: 'focus', active }))
  })
  $effect(() => {
    const shown = view
    if (shown === null) return
    untrack(() => icons.request(boardIconIds(shown)))
  })
</script>

<section
  class="board"
  bind:this={root}
  style:width={`${layout.widthPx}px`}
  style:top={`${boardTopClearancePx}px`}
  style:right={`${boardEdgeGapPx}px`}
  style:bottom={`${boardBottomClearancePx}px`}
  aria-label={heading}
>
  {#if view !== null}
    <header class="strip">
      <strong>{heading}</strong>
      {#if view.sound.on}
        <span class="sound on">{view.sound.text}</span>
      {:else}
        <button type="button" class="sound" onclick={() => click({ kind: 'enable-sound' })}>{view.sound.text}</button>
      {/if}
    </header>
    {#if view.alerts.length > 0}
      <ul class="alerts" aria-label={view.headings.alerts}>
        {#each view.alerts as alert, index (index)}
          <li><strong>{alert.label}</strong> {alert.message}</li>
        {/each}
      </ul>
    {/if}
    <div class="commit" data-state={view.commit.state}>
      <button type="button" class="commit-button" disabled={!view.commit.enabled} onclick={() => click({ kind: 'commit' })}>{view.commit.text}</button>
      {#if view.commit.cancel !== null}
        <button type="button" class="cancel" onclick={() => click({ kind: 'cancel' })}>{view.commit.cancel}</button>
      {/if}
      {#if view.commit.hint !== null}<p class="hint">{view.commit.hint}</p>{/if}
    </div>
  {/if}
  {#if problem !== null}
    <p class="problem" role="alert">
      {problem}
      {#if retry !== null}<button type="button" onclick={retry}>{boardWords.retry}</button>{/if}
    </p>
  {/if}
  {#if view !== null}
    <div class="body">
      {#each sections as section (section)}
        {#if section === 'work'}
          <BoardWorkList
            heading={view.headings.workList}
            focused={view.focus === 'work'}
            rows={view.workList.rows}
            empty={view.workList.empty}
            selected={view.selected?.kind === 'task' ? view.selected : null}
            {icon}
            {click}
          />
        {:else if section === 'units'}
          <BoardUnits heading={view.headings.unitBoard} focused={view.focus === 'units'} rows={view.unitBoard.rows} empty={view.unitBoard.empty} {icon} {click} />
        {:else if view.contacts !== null}
          <BoardContacts contacts={view.contacts} {icon} />
        {/if}
      {/each}
    </div>
    <p class="feedback" role="status" aria-live="polite" data-tone={view.feedback?.tone ?? 'none'}>{view.feedback?.text ?? ''}</p>
    {#if missingArtwork !== null}<p class="artwork">{missingArtwork}</p>{/if}
    {#if view.log.length > 0}
      <ol class="log" aria-label={view.headings.log}>
        {#each view.log as entry, index (index)}
          <li><span class="num">{logTime(entry)}</span> {entry.text}</li>
        {/each}
      </ol>
    {/if}
  {:else if problem === null}
    <p class="loading">{boardWords.loading}</p>
  {/if}
</section>

<style>
  /* Its offsets from the surface's edges come from board-layout.ts. */
  .board {
    position: absolute;
    z-index: 15;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--panel) 97%, transparent);
    box-shadow: 0 10px 30px rgba(16, 24, 40, .22);
    color: var(--text);
    font-size: 13px;
    pointer-events: auto;
  }

  .strip { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .sound { padding: 3px 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--panel-strong); color: var(--muted); font-size: 12px; cursor: pointer; }
  .sound.on { cursor: default; }
  .alerts { max-height: 84px; overflow: auto; margin: 0; padding: 0; list-style: none; display: grid; gap: 3px; }
  .alerts li { padding: 3px 7px; border-left: 3px solid var(--critical); border-radius: 4px; background: color-mix(in srgb, var(--critical) 9%, var(--panel)); font-size: 12px; }
  .commit { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 6px; }
  .commit-button { min-height: 36px; padding: 6px 10px; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent); color: white; font-weight: 650; font-variant-numeric: tabular-nums; text-align: left; cursor: pointer; }
  .commit-button:disabled { border-color: var(--border); background: var(--panel-strong); color: var(--muted); cursor: default; }
  /* Dark text on the warning colour reads at 4.5:1 or better in both themes; white would not in the dark one. */
  .commit[data-state='confirm'] .commit-button:enabled { border-color: var(--warning); background: var(--warning); color: color-mix(in srgb, var(--warning) 15%, black); }
  .cancel { padding: 4px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: inherit; cursor: pointer; }
  .hint { grid-column: 1 / -1; margin: 0; color: var(--warning); font-size: 12px; }
  .problem { margin: 0; color: var(--critical); }
  .problem button { margin-left: 6px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: inherit; cursor: pointer; }
  .body { flex: 1; min-height: 0; overflow: auto; display: grid; align-content: start; gap: 12px; }
  .feedback { min-height: 18px; margin: 0; padding: 4px 6px; border-radius: 6px; background: var(--panel-strong); font-size: 12px; }
  .feedback[data-tone='pending'] { color: var(--muted); }
  .feedback[data-tone='done'] { color: var(--success); }
  .feedback[data-tone='refused'] { color: var(--critical); }
  .artwork { margin: 0; color: var(--warning); font-size: 11px; }
  .log { max-height: 96px; overflow: auto; margin: 0; padding: 0; list-style: none; color: var(--muted); font-size: 11px; }
  .num { font-variant-numeric: tabular-nums; }
  .loading { margin: 0; color: var(--muted); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
