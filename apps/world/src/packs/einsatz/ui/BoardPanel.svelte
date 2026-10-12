<script lang="ts">
  import { untrack } from 'svelte'
  import { loadMapSymbols } from '../../../ui/map-runtime/map-symbols.ts'
  import type { SurfacePanelProps } from '../../../ui/surface-panel-interaction.ts'
  import { runOnMount } from '../../../ui/svelte-lifecycle.svelte.ts'
  import { boardWords } from '../board/text.ts'
  import type { ClickTarget } from '../board/types.ts'
  import type { EinsatzConfig } from '../config-schema.ts'
  import { invokeBoardCommand, queryBoardRecommendation, readBoardConfiguration } from './board-client.ts'
  import type { ObjectId } from '../../../core/model/index.ts'
  import { shownBesideBoard } from './board-camera.ts'
  import { boardIconIds, createBoardIcons } from './board-icons.ts'
  import { boardBottomClearancePx, boardChromePx, boardEdgeGapPx, boardLayoutFor, boardMapCover, boardSections, boardTopClearancePx, listRowsTemplate, rowBoxStyle } from './board-layout.ts'
  import { logTime, stripHeading } from './board-presenter.ts'
  import { createBoardSession, type BoardSession } from './board-session.ts'
  import { createBoardTone, type BoardTone } from './board-tone.ts'
  import { boardMapOrders } from './map-orders.ts'
  import { screenViewerFor } from './screen-viewer.ts'
  import BoardActionBar from './BoardActionBar.svelte'
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
   * camera by its observed width. A call or asset the operator picks from its
   * lists that the map shows only under the Board, or not at all, is brought
   * into view beside it; a selection the Board makes itself, such as the
   * next call after a commit, moves no camera.
   *
   * Touch first: the action bar on top says what the next tap sends; the
   * status line below it carries the result, Undo and sound; Calls and Assets
   * share the rest in fixed parts, each scrolling on its own. Every control
   * is at least 44 px and nothing hides behind hover or hints at a key. A
   * tap on open ground shows the controller's "Move here" prompt on the map.
   * It never takes the keyboard itself: a pointer passing over it must not
   * pull keys out of the Agents chat or a Host field into the Board's hidden
   * accelerators, where Enter would commit. A tap or click focuses the World.
   */
  const props: SurfacePanelProps = $props()

  let session = $state.raw<BoardSession | null>(null)
  let revision = $state(0)
  let problem = $state<string | null>(null)
  let retry = $state.raw<(() => void) | null>(null)
  let surfaceWidth = $state(0)
  let surfaceHeight = 0
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

  /**
   * Pans the map to an object the operator picked from the Board's lists when
   * the map shows it only under the Board or the bars, or not at all. Before
   * the map reports its first view, or for an object without a position,
   * there is nothing to place it by.
   */
  const revealOnMap = (objectId: ObjectId | null): void => {
    const view = props.mapView
    const point = objectId === null ? undefined : props.objects.find(object => object.id === objectId)?.spatial.position?.point
    if (view === null || point === undefined || root === null || surfaceWidth <= 0 || surfaceHeight <= 0) return
    const cover = boardMapCover(root.getBoundingClientRect().width)
    if (shownBesideBoard(view, { width: surfaceWidth, height: surfaceHeight }, cover, point.coordinates)) return
    props.onFocusMap({ kind: 'point', center: [point.coordinates[0], point.coordinates[1]] })
  }

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

    const surfaceObserver = new ResizeObserver(() => {
      surfaceWidth = surface.clientWidth
      surfaceHeight = surface.clientHeight
    })
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
        declaredRoles: props.roleSet?.declaration.roles ?? [],
        sides,
        ports: {
          invoke: async (capabilityId, input) => await invokeBoardCommand(simulationRunId, capabilityId, input),
          recommend: async taskId => await queryBoardRecommendation(simulationRunId, taskId),
          select: (objectId, reveal) => {
            props.onSelectObject(objectId)
            if (reveal) revealOnMap(objectId)
          },
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
      props.onMapPrompt(null)
      surfaceObserver.disconnect()
      boardObserver.disconnect()
      for (const release of releases.reverse()) release()
      current?.dispose()
      if (tone !== null) void closeTone(tone)
      tone = null
    }
  })

  // The screen's inputs reach the controller as events, each on every change of its prop; what it sees before its objects.
  $effect(() => {
    const roleIds = props.seenRoleIds
    const current = session
    if (current === null) return
    untrack(() => current.dispatch({ kind: 'seen', roleIds }))
  })
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
  // The map shows the controller's "Move here" prompt; it is sent again only when it changes.
  let shownPromptKey: string | null = null
  $effect(() => {
    const prompt = view?.mapPrompt ?? null
    const key = prompt === null ? null : JSON.stringify([prompt.unitId, prompt.point.coordinates, prompt.label])
    if (key === shownPromptKey) return
    shownPromptKey = key
    untrack(() => props.onMapPrompt(prompt === null ? null : { point: prompt.point, label: prompt.label, onConfirm: () => click({ kind: 'move-here' }) }))
  })
</script>

<section
  class="board"
  bind:this={root}
  style={rowBoxStyle}
  style:width={`${layout.widthPx}px`}
  style:top={`${boardTopClearancePx}px`}
  style:right={`${boardEdgeGapPx}px`}
  style:bottom={`${boardBottomClearancePx}px`}
  style:padding={`${boardChromePx.padding}px`}
  style:gap={`${boardChromePx.gap}px`}
  aria-label={heading}
>
  {#if view !== null}
    {#if view.alerts.length > 0}
      <ul class="alerts" aria-label={view.headings.alerts} style:max-height={`${boardChromePx.alerts}px`}>
        {#each view.alerts as alert, index (index)}
          <li><strong>{alert.label}</strong> {alert.message}</li>
        {/each}
      </ul>
    {/if}
    <div class="action" style:max-height={`${boardChromePx.actionBar}px`}>
      <BoardActionBar commit={view.commit} selected={view.selected} {click} />
    </div>
    <div class="status" style:min-height={`${boardChromePx.statusLine}px`}>
      <p class="feedback" role="status" aria-live="polite" data-tone={view.feedback?.tone ?? 'none'}>{view.feedback?.text ?? ''}</p>
      {#if view.undo !== null}<button type="button" class="undo" onclick={() => click({ kind: 'undo' })}>{view.undo}</button>{/if}
      {#if view.sound.on}
        <span class="sound on">{view.sound.text}</span>
      {:else}
        <button type="button" class="sound" onclick={() => click({ kind: 'enable-sound' })}>{view.sound.text}</button>
      {/if}
    </div>
  {/if}
  {#if problem !== null}
    <p class="problem" role="alert">
      {problem}
      {#if retry !== null}<button type="button" onclick={retry}>{boardWords.retry}</button>{/if}
    </p>
  {/if}
  {#if view !== null}
    <div class="body" style:grid-template-rows={listRowsTemplate(sections)} style:gap={`${boardChromePx.gap}px`}>
      {#each sections as section (section)}
        {#if section === 'work'}
          <BoardWorkList heading={view.headings.workList} focused={view.focus === 'work'} rows={view.workList.rows} empty={view.workList.empty} {icon} {click} />
        {:else if section === 'units'}
          <BoardUnits heading={view.headings.unitBoard} focused={view.focus === 'units'} rows={view.unitBoard.rows} empty={view.unitBoard.empty} sitesHeading={view.unitBoard.sitesHeading} sites={view.unitBoard.sites} addLabel={boardWords.addTarget} removeLabel={boardWords.removeStep} {icon} {click} />
        {:else if view.contacts !== null}
          <BoardContacts contacts={view.contacts} {icon} />
        {/if}
      {/each}
    </div>
    {#if missingArtwork !== null}<p class="artwork">{missingArtwork}</p>{/if}
    <ol class="log" aria-label={view.headings.log} style:height={`${boardChromePx.log}px`}>
      {#each view.log as entry, index (index)}
        <li><span class="num">{logTime(entry)}</span> {entry.text}</li>
      {/each}
    </ol>
  {:else if problem === null}
    <p class="loading">{boardWords.loading}</p>
  {/if}
</section>

<style>
  /* Its offsets from the surface's edges, its padding and gaps and the heights of its parts come from board-layout.ts. */
  .board {
    position: absolute;
    z-index: 15;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--panel) 97%, transparent);
    box-shadow: 0 10px 30px rgba(16, 24, 40, .22);
    color: var(--text);
    font-size: 13px;
    line-height: var(--board-line);
    pointer-events: auto;
  }

  .alerts { flex: none; overflow: auto; margin: 0; padding: 0; list-style: none; display: grid; gap: 3px; }
  .alerts li { padding: 3px 7px; border-left: 3px solid var(--critical); border-radius: 4px; background: color-mix(in srgb, var(--critical) 9%, var(--panel)); font-size: 12px; }
  /* Past its cap the action bar scrolls inside, so the lists keep their room. */
  .action { flex: none; overflow: auto; overscroll-behavior: contain; }
  .status { flex: none; box-sizing: border-box; display: flex; align-items: center; gap: 6px; padding: 0 0 0 6px; border-radius: 6px; background: var(--panel-strong); }
  .feedback { flex: 1; min-width: 0; margin: 0; font-size: 12px; overflow-wrap: anywhere; }
  .feedback[data-tone='pending'] { color: var(--muted); }
  .feedback[data-tone='done'] { color: var(--success); }
  .feedback[data-tone='refused'] { color: var(--critical); }
  .status button { flex: none; min-height: 44px; min-width: 44px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: inherit; font: inherit; font-size: 12px; cursor: pointer; touch-action: manipulation; }
  .undo { border-color: var(--accent); color: var(--accent); font-weight: 650; }
  .sound { color: var(--muted); }
  span.sound { flex: none; padding: 0 8px; font-size: 12px; }
  .problem { flex: none; margin: 0; color: var(--critical); }
  .problem button { min-height: 44px; margin-left: 6px; padding: 2px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: inherit; cursor: pointer; }
  .body { flex: 1; min-height: 0; display: grid; }
  .artwork { flex: none; margin: 0; color: var(--warning); font-size: 11px; }
  .log { flex: none; box-sizing: border-box; overflow: auto; margin: 0; padding: 0; list-style: none; color: var(--muted); font-size: 11px; line-height: 15px; }
  .num { font-variant-numeric: tabular-nums; }
  .loading { margin: 0; color: var(--muted); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
