<script lang="ts">
  import { ChevronsUp, ChevronDown, ChevronUp, Copy, FileCode2, RotateCcw, Search, X, ZoomIn, ZoomOut } from 'lucide-svelte'
  import { tick } from 'svelte'
  import type { SimulationRunId } from '../../../core/model/index.ts'
  import {
    readProcessPlantArtifact,
    type ProcessPlantArtifact,
    type ProcessPlantArtifactComponent,
    type ProcessPlantArtifactKind,
    type ProcessPlantArtifactSourceLink,
  } from '../../../ui/process-display/process-display-client.ts'

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly plantId: string
    readonly artifact: ProcessPlantArtifactKind
    readonly close: () => void
  }

  let { simulationRunId, plantId, artifact, close }: Props = $props()

  let loading = $state(true)
  let error = $state<string | null>(null)
  let data = $state<ProcessPlantArtifact | null>(null)
  let copyStatus = $state<string | null>(null)
  let renderedSvg = $state<string | null>(null)
  let renderError = $state<string | null>(null)
  let graphViewport = $state<HTMLDivElement | null>(null)
  let graphSize = $state<{ readonly width: number; readonly height: number } | null>(null)
  let graphScale = $state(1)
  let graphOffset = $state({ x: 0, y: 0 })
  let sourceViewport = $state<HTMLDivElement | null>(null)
  let sourceSearchQuery = $state('')
  let sourceSearchCursor = $state(-1)
  let componentSource = $state<ProcessPlantArtifactComponent | null>(null)
  let importedSource = $state<ProcessPlantArtifactSourceLink | null>(null)
  let importedSourceViewport = $state<HTMLElement | null>(null)
  let graphPan = $state<{
    readonly pointerId: number
    readonly pointerStart: { readonly x: number; readonly y: number }
    readonly origin: { readonly x: number; readonly y: number }
  } | null>(null)

  const lineCountFor = (content: string): number => {
    const trimmed = content.trimEnd()
    return trimmed.length === 0 ? 0 : trimmed.split(/\r\n|\r|\n/).length
  }

  const contentLineCount = $derived(data ? lineCountFor(data.content) : null)
  const sourceLines = $derived(data?.language === 'json' ? data.content.split(/\r\n|\r|\n/) : [])
  const sourceFileByPath = $derived.by(() => new Map((data?.sourceFiles ?? []).map(file => [file.path, file] as const)))
  const componentSourceFile = $derived(componentSource?.sourcePath === null || componentSource?.sourcePath === undefined
    ? null
    : sourceFileByPath.get(componentSource.sourcePath) ?? null)
  const normalizedSourceSearchQuery = $derived(sourceSearchQuery.trim().toLowerCase())
  const sourceSearchMatches = $derived(normalizedSourceSearchQuery.length === 0
    ? []
    : sourceLines.flatMap((line, lineIndex) => line.toLowerCase().includes(normalizedSourceSearchQuery) ? [lineIndex] : []))
  const sourceSearchSummary = $derived(normalizedSourceSearchQuery.length === 0
    ? ''
    : `${sourceSearchCursor < 0 ? 0 : sourceSearchCursor + 1}/${sourceSearchMatches.length}`)

  interface SourceTextSegment {
    readonly text: string
    readonly match: boolean
  }

  interface SourceNavigationSegment {
    readonly text: string
    readonly link: ProcessPlantArtifactSourceLink | null
  }

  const sourceLinesFor = (content: string): ReadonlyArray<string> => content.split(/\r\n|\r|\n/)

  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const isIdentifierCharacter = (value: string | undefined): boolean =>
    value !== undefined && /[A-Za-z0-9_$]/.test(value)

  const sourceNavigationSegments = (
    line: string,
    links: ReadonlyArray<ProcessPlantArtifactSourceLink>,
  ): ReadonlyArray<SourceNavigationSegment> => {
    if (links.length === 0 || line.length === 0) return [{ text: line, link: null }]
    const linkBySymbol = new Map(links.map(link => [link.symbol, link] as const))
    const pattern = new RegExp([...linkBySymbol.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'g')
    const segments: SourceNavigationSegment[] = []
    let cursor = 0
    for (const match of line.matchAll(pattern)) {
      const index = match.index
      const text = match[0]
      if (index === undefined || text.length === 0) continue
      const end = index + text.length
      if (isIdentifierCharacter(line[index - 1]) || isIdentifierCharacter(line[end])) continue
      const link = linkBySymbol.get(text)
      if (!link) continue
      if (index > cursor) segments.push({ text: line.slice(cursor, index), link: null })
      segments.push({ text, link })
      cursor = end
    }
    if (cursor < line.length) segments.push({ text: line.slice(cursor), link: null })
    return segments.length === 0 ? [{ text: line, link: null }] : segments
  }

  const sourceTextSegments = (line: string): ReadonlyArray<SourceTextSegment> => {
    const query = sourceSearchQuery.trim()
    if (query.length === 0) return [{ text: line, match: false }]
    const segments: SourceTextSegment[] = []
    const lowerLine = line.toLowerCase()
    const lowerQuery = query.toLowerCase()
    let cursor = 0
    while (cursor < line.length) {
      const index = lowerLine.indexOf(lowerQuery, cursor)
      if (index < 0) break
      if (index > cursor) segments.push({ text: line.slice(cursor, index), match: false })
      segments.push({ text: line.slice(index, index + query.length), match: true })
      cursor = index + query.length
    }
    if (cursor < line.length) segments.push({ text: line.slice(cursor), match: false })
    return segments.length === 0 ? [{ text: line, match: false }] : segments
  }

  const mermaidSvgSize = (svg: string): { readonly width: number; readonly height: number } | null => {
    const viewBox = /\sviewBox="([^"]+)"/.exec(svg)?.[1]?.trim()
    if (!viewBox) return null
    const [, , width, height] = viewBox.split(/\s+/).map(Number)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
    return { width, height }
  }

  const normalizeMermaidSvg = (
    svg: string,
  ): { readonly svg: string; readonly size: { readonly width: number; readonly height: number } | null } => {
    const size = mermaidSvgSize(svg)
    if (!size) return { svg, size: null }
    const cleaned = svg
      .replace(/\swidth="[^"]*"/, '')
      .replace(/\sheight="[^"]*"/, '')
      .replace(/\sstyle="[^"]*"/, '')
    return {
      svg: cleaned.replace('<svg ', `<svg width="${size.width}" height="${size.height}" `),
      size,
    }
  }

  const copyContent = async (): Promise<void> => {
    const content = data?.content
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      copyStatus = 'Copied'
    } catch (err) {
      copyStatus = err instanceof Error ? err.message : String(err)
    }
  }

  const scrollToSourceLine = (lineIndex: number): void => {
    const viewport = sourceViewport
    const line = viewport?.querySelector(`[data-source-line="${lineIndex}"]`)
    if (!(line instanceof HTMLElement)) return
    line.scrollIntoView({ block: 'center' })
  }

  const scrollSourceToTop = (): void => {
    const sourceContainer = sourceViewport
    const scrollContainer = sourceContainer?.closest('.process-artifact-body')
    if (scrollContainer instanceof HTMLElement) scrollContainer.scrollTo({ top: 0, left: 0 })
    sourceContainer?.scrollTo({ top: 0, left: 0 })
    sourceSearchCursor = -1
  }

  const moveSourceSearch = async (direction: 1 | -1): Promise<void> => {
    const matches = sourceSearchMatches
    if (matches.length === 0) return
    const current = sourceSearchCursor >= 0 && sourceSearchCursor < matches.length ? sourceSearchCursor : (direction > 0 ? -1 : 0)
    sourceSearchCursor = (current + direction + matches.length) % matches.length
    await tick()
    scrollToSourceLine(matches[sourceSearchCursor] ?? 0)
  }

  const updateSourceSearch = (query: string): void => {
    sourceSearchQuery = query
    sourceSearchCursor = -1
  }

  const searchForComponent = async (component: ProcessPlantArtifactComponent): Promise<void> => {
    updateSourceSearch(component.label)
    await tick()
    await moveSourceSearch(1)
  }

  const handleSearchKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void moveSourceSearch(event.shiftKey ? -1 : 1)
  }

  const closeComponentSourceFromBackdrop = (event: MouseEvent): void => {
    if (event.target !== event.currentTarget) return
    componentSource = null
    importedSource = null
  }

  const closeImportedSourceFromBackdrop = (event: MouseEvent): void => {
    if (event.target === event.currentTarget) importedSource = null
  }

  const scrollImportedSourceToDefinition = (): void => {
    const targetLineIndex = importedSource?.targetLineIndex
    if (targetLineIndex === null || targetLineIndex === undefined) return
    const line = importedSourceViewport?.querySelector(`[data-import-source-line="${targetLineIndex}"]`)
    if (line instanceof HTMLElement) line.scrollIntoView({ block: 'center' })
  }

  const openImportedSource = async (link: ProcessPlantArtifactSourceLink): Promise<void> => {
    importedSource = link
    await tick()
    scrollImportedSourceToDefinition()
  }

  const fitGraphView = (): void => {
    const viewport = graphViewport
    const size = graphSize
    if (!viewport || !size) {
      graphScale = 1
      graphOffset = { x: 0, y: 0 }
      graphPan = null
      return
    }
    const padding = 36
    const availableWidth = Math.max(1, viewport.clientWidth - padding * 2)
    const availableHeight = Math.max(1, viewport.clientHeight - padding * 2)
    const nextScale = Math.max(0.04, Math.min(1, Math.min(availableWidth / size.width, availableHeight / size.height)))
    graphScale = nextScale
    graphOffset = {
      x: Math.max(18, (viewport.clientWidth - size.width * nextScale) / 2),
      y: Math.max(18, (viewport.clientHeight - size.height * nextScale) / 2),
    }
    graphPan = null
  }

  const clearGraphView = (): void => {
    graphScale = 1
    graphOffset = { x: 0, y: 0 }
    graphPan = null
  }

  const resetGraphView = (): void => {
    if (graphViewport && graphSize) {
      fitGraphView()
      return
    }
    clearGraphView()
  }

  const zoomGraph = (factor: number): void => {
    const viewport = graphViewport
    const previousScale = graphScale
    const nextScale = Math.max(0.04, Math.min(3, previousScale * factor))
    if (!viewport || nextScale === previousScale) {
      graphScale = nextScale
      return
    }
    const center = {
      x: viewport.clientWidth / 2,
      y: viewport.clientHeight / 2,
    }
    graphScale = nextScale
    graphOffset = {
      x: center.x - ((center.x - graphOffset.x) / previousScale) * nextScale,
      y: center.y - ((center.y - graphOffset.y) / previousScale) * nextScale,
    }
  }

  const startGraphPan = (event: PointerEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const element = event.currentTarget as Element
    element.setPointerCapture(event.pointerId)
    graphPan = {
      pointerId: event.pointerId,
      pointerStart: { x: event.clientX, y: event.clientY },
      origin: graphOffset,
    }
  }

  const updateGraphPan = (event: PointerEvent): void => {
    const pan = graphPan
    if (!pan || pan.pointerId !== event.pointerId) return
    graphOffset = {
      x: pan.origin.x + event.clientX - pan.pointerStart.x,
      y: pan.origin.y + event.clientY - pan.pointerStart.y,
    }
  }

  const finishGraphPan = (event: PointerEvent): void => {
    if (graphPan?.pointerId !== event.pointerId) return
    updateGraphPan(event)
    graphPan = null
  }

  const wheelZoomGraph = (event: WheelEvent): void => {
    event.preventDefault()
    const viewport = graphViewport
    const previousScale = graphScale
    const nextScale = Math.max(0.04, Math.min(3, previousScale * (event.deltaY < 0 ? 1.1 : 1 / 1.1)))
    if (!viewport || nextScale === previousScale) {
      graphScale = nextScale
      return
    }
    const viewportRect = viewport.getBoundingClientRect()
    const focus = {
      x: event.clientX - viewportRect.left,
      y: event.clientY - viewportRect.top,
    }
    graphScale = nextScale
    graphOffset = {
      x: focus.x - ((focus.x - graphOffset.x) / previousScale) * nextScale,
      y: focus.y - ((focus.y - graphOffset.y) / previousScale) * nextScale,
    }
  }

  $effect(() => {
    const selectedSimulationRunId = simulationRunId
    const selectedPlantId = plantId
    const selectedArtifact = artifact
    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        loading = true
        error = null
        data = null
        copyStatus = null
        sourceSearchQuery = ''
        sourceSearchCursor = -1
        componentSource = null
        importedSource = null
        renderedSvg = null
        renderError = null
        graphSize = null
        clearGraphView()
        const next = await readProcessPlantArtifact(selectedSimulationRunId, selectedPlantId, selectedArtifact)
        if (!cancelled) data = next
      } catch (err) {
        if (!cancelled) error = err instanceof Error ? err.message : String(err)
      } finally {
        if (!cancelled) loading = false
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    const artifactData = data
    let cancelled = false
    renderedSvg = null
    renderError = null
    graphSize = null
    clearGraphView()

    if (!artifactData || artifactData.language !== 'mermaid') {
      return () => {
        cancelled = true
      }
    }

    const render = async (): Promise<void> => {
      try {
        const mermaid = await import('mermaid')
        mermaid.default.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: {
            fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
            primaryColor: '#f8fafc',
            primaryTextColor: '#101828',
            primaryBorderColor: '#667085',
            lineColor: '#667085',
            secondaryColor: '#eef4ff',
            tertiaryColor: '#ffffff',
          },
        })
        const renderId = `process-plant-graph-${artifactData.plantId.replace(/[^a-zA-Z0-9_-]/g, '-')}-${Date.now()}`
        const result = await mermaid.default.render(renderId, artifactData.content)
        const normalized = normalizeMermaidSvg(result.svg)
        if (!cancelled) {
          graphSize = normalized.size
          renderedSvg = normalized.svg
          await tick()
          fitGraphView()
        }
      } catch (err) {
        if (!cancelled) renderError = err instanceof Error ? err.message : String(err)
      }
    }

    void render()

    return () => {
      cancelled = true
    }
  })
</script>

<div class="process-artifact-backdrop" role="presentation">
  <section class="process-artifact-modal" aria-label="Process plant artifact">
    <header class="process-artifact-header">
      <div>
        <strong>{data?.title ?? (artifact === 'authored-spec' ? 'Plant specification source' : 'Full component graph')}</strong>
        {#if data}
          <span>{data.metadata.componentCount} components · {data.metadata.linkCount} links · {data.metadata.variableCount} variables{#if contentLineCount !== null} · {contentLineCount} LOC{/if}</span>
        {/if}
      </div>
      <div class="process-artifact-actions">
        {#if data?.language === 'json'}
          <label class="process-artifact-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              placeholder="Search source"
              value={sourceSearchQuery}
              oninput={(event) => updateSourceSearch(event.currentTarget.value)}
              onkeydown={handleSearchKeydown}
            />
            {#if sourceSearchSummary}
              <span>{sourceSearchSummary}</span>
            {/if}
          </label>
          <button type="button" aria-label="Previous source match" onclick={() => void moveSourceSearch(-1)} disabled={sourceSearchMatches.length === 0}>
            <ChevronUp size={16} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Next source match" onclick={() => void moveSourceSearch(1)} disabled={sourceSearchMatches.length === 0}>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Jump to top of source" onclick={scrollSourceToTop}>
            <ChevronsUp size={16} aria-hidden="true" />
          </button>
        {/if}
        {#if data?.language === 'mermaid' && renderedSvg}
          <button type="button" aria-label="Zoom out graph" onclick={() => zoomGraph(1 / 1.2)}>
            <ZoomOut size={16} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Reset graph view" onclick={resetGraphView}>
            <RotateCcw size={15} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Zoom in graph" onclick={() => zoomGraph(1.2)}>
            <ZoomIn size={16} aria-hidden="true" />
          </button>
        {/if}
        <button type="button" aria-label="Copy artifact text" onclick={copyContent} disabled={!data}>
          <Copy size={16} aria-hidden="true" />
        </button>
        <button type="button" aria-label="Close artifact" onclick={close}>
          <X size={17} aria-hidden="true" />
        </button>
      </div>
    </header>
    {#if copyStatus}
      <div class="process-artifact-copy-status">{copyStatus}</div>
    {/if}
    <div class="process-artifact-body">
      {#if loading}
        <div class="process-display-message">Loading plant artifact...</div>
      {:else if error}
        <div class="process-display-error">{error}</div>
      {:else if data}
        {#if data.language === 'mermaid'}
          {#if renderedSvg}
            <div
              bind:this={graphViewport}
              class="process-artifact-diagram"
              class:panning={graphPan !== null}
              role="application"
              aria-label="Pan and zoom full component graph"
              onwheel={wheelZoomGraph}
              onpointerdown={startGraphPan}
              onpointermove={updateGraphPan}
              onpointerup={finishGraphPan}
              onpointercancel={finishGraphPan}
            >
              <div
                class="process-artifact-diagram-inner"
                style="transform: translate({graphOffset.x}px, {graphOffset.y}px) scale({graphScale});"
              >
                {@html renderedSvg}
              </div>
            </div>
          {:else if renderError}
            <div class="process-artifact-render-error">
              Mermaid render failed: {renderError}
            </div>
            <pre><code>{data.content}</code></pre>
          {:else}
            <div class="process-display-message">Rendering Mermaid graph...</div>
          {/if}
        {:else}
          <div class="process-artifact-source" bind:this={sourceViewport}>
            <section class="process-artifact-component-index" aria-label="Plant components">
              {#each data.components as component (component.id)}
                <div class="process-artifact-component-row">
                  <button
                    type="button"
                    class:overview={component.shownOnOverview}
                    onclick={() => void searchForComponent(component)}
                  >
                    {component.label}
                  </button>
                  <span>{component.kind} · {component.id}</span>
                  {#if component.sourcePath !== null}
                    <button
                      type="button"
                      class="source-icon"
                      aria-label="Show implementation source for {component.label}"
                      title="Show implementation source"
                      onclick={() => { componentSource = component }}
                    >
                      <FileCode2 size={14} aria-hidden="true" />
                    </button>
                  {/if}
                </div>
              {/each}
            </section>
            <pre><code>{#each sourceLines as line, lineIndex (`${lineIndex}-${line}`)}<span data-source-line={lineIndex} class:active-line={sourceSearchMatches[sourceSearchCursor] === lineIndex}>{#each sourceTextSegments(line) as segment}<span class:source-match={segment.match}>{segment.text}</span>{/each}</span>{lineIndex + 1 < sourceLines.length ? '\n' : ''}{/each}</code></pre>
          </div>
        {/if}
      {:else}
        <div class="process-display-error">Plant artifact did not load.</div>
      {/if}
    </div>
  </section>
  {#if componentSource}
    <div
      class="process-component-source-backdrop"
      role="presentation"
      onclick={closeComponentSourceFromBackdrop}
    >
      <section class="process-component-source-modal" aria-label="Component implementation source">
        <header>
          <div>
            <strong>{componentSource.label}</strong>
            <span>{componentSource.kind} · {componentSource.sourcePath}</span>
          </div>
          <button type="button" aria-label="Close component source" onclick={() => { componentSource = null; importedSource = null }}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        {#if componentSourceFile}
          <pre><code>{#each sourceLinesFor(componentSourceFile.content) as line, lineIndex (`component-${componentSource.id}-${lineIndex}`)}<span data-component-source-line={lineIndex}>{#each sourceNavigationSegments(line, componentSource.sourceLinks) as segment, segmentIndex (`${lineIndex}-${segmentIndex}-${segment.text}`)}{#if segment.link}<button
                    type="button"
                    class="source-link"
                    title="Open {segment.link.targetPath} at {segment.link.importedName}"
                    onclick={() => void openImportedSource(segment.link)}
                  >{segment.text}</button>{:else}{segment.text}{/if}{/each}</span>{lineIndex + 1 < sourceLinesFor(componentSourceFile.content).length ? '\n' : ''}{/each}</code></pre>
        {:else}
          <div class="process-display-error">Implementation source was not included in the artifact payload.</div>
        {/if}
      </section>
    </div>
  {/if}
  {#if importedSource}
    {@const importedFile = sourceFileByPath.get(importedSource.targetPath)}
    <div
      class="process-imported-source-backdrop"
      role="presentation"
      onclick={closeImportedSourceFromBackdrop}
    >
      <section class="process-component-source-modal process-imported-source-modal" aria-label="Imported implementation source">
        <header>
          <div>
            <strong>{importedSource.importedName}</strong>
            <span>{importedSource.targetPath}{#if importedSource.targetLineIndex !== null} · line {importedSource.targetLineIndex + 1}{/if}</span>
          </div>
          <button type="button" aria-label="Close imported source" onclick={() => { importedSource = null }}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        {#if importedFile}
          <pre bind:this={importedSourceViewport}><code>{#each sourceLinesFor(importedFile.content) as line, lineIndex (`imported-${importedSource.targetPath}-${lineIndex}`)}<span data-import-source-line={lineIndex} class:active-line={importedSource.targetLineIndex === lineIndex}>{line}</span>{lineIndex + 1 < sourceLinesFor(importedFile.content).length ? '\n' : ''}{/each}</code></pre>
        {:else}
          <div class="process-display-error">Imported source file was not included in the artifact payload: {importedSource.targetPath}</div>
        {/if}
      </section>
    </div>
  {/if}
</div>
