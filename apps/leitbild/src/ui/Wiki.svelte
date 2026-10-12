<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { parseProductSourceReference } from '@leitbild/knowledge/source-reference'
  import { renderWiki, wikiPageUrl } from './wiki-render.ts'
  import WikiFeedback from './WikiFeedback.svelte'
  import WikiAssistant from './WikiAssistant.svelte'
  import Wordmark from './Wordmark.svelte'
  import { defaultNavigationWidth, minimumNavigationWidth, maximumNavigationWidth, navigationWidth } from './wiki-layout.ts'
  interface Heading {
    title: string
    level: number
    line: number
    anchor: string
  }
  interface Entry {
    path: string
    title: string
    summary: string
    parent: string | null
    hub: boolean
    procedureId?: string
    headings?: Heading[]
  }
  interface Document {
    path: string
    title: string
    revision: string
    content: string
    headings: Heading[]
    children: Entry[]
    parent: string | null
  }
  interface Source {
    path: string
    content: string
    revision: string
    totalLines: number
  }
  let entries = $state<Entry[]>([]),
    document = $state<Document | null>(null)
  let matches = $state<
    { path: string; title: string; snippet: string; section?: string }[] | null
  >(null)
  let query = $state(''),
    searchedQuery = $state(''),
    error = $state(''),
    html = $state(''),
    publication = $state('')
  let nextOffset = $state<number | undefined>(),
    matchTotal = $state(0),
    loading = $state(false),
    menuOpen = $state(false)
  let sourceBaseUrl = $state<string | undefined>(),
    article = $state<HTMLElement | null>(null),
    dialog = $state<HTMLDialogElement | null>(null)
  let source = $state<Source | null>(null),
    sourceError = $state(''),
    sourceLoading = $state(false),
    sourceQuery = $state('')
  let ranges = $state<ReadonlyArray<{ startLine: number; endLine: number }>>([])
  let requestId = 0,
    searchId = 0,
    sourceId = 0
  let preferredWidth = $state(defaultNavigationWidth)
  let viewportWidth = $state(1200)
  let dragging = $state(false)
  let dragPointer: number | null = null
  let dragStartX = 0, dragStartWidth = 0
  const sidebarWidth = $derived(navigationWidth(preferredWidth, viewportWidth))
  const widthKey = 'leitbild.wiki.navigationWidth'
  const rememberWidth = () => {
    try { localStorage.setItem(widthKey, String(preferredWidth)) }
    catch (cause) { console.warn('Wiki navigation width could not be saved', cause) }
  }
  const beginResize = (event: PointerEvent) => {
    if (event.button !== 0 || dragPointer !== null) return
    dragPointer = event.pointerId
    dragStartX = event.clientX
    dragStartWidth = sidebarWidth
    dragging = true
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const resize = (event: PointerEvent) => {
    if (event.pointerId !== dragPointer) return
    preferredWidth = navigationWidth(dragStartWidth + event.clientX - dragStartX, viewportWidth)
  }
  const finishResize = (event: PointerEvent) => {
    if (event.pointerId !== dragPointer) return
    dragPointer = null
    dragging = false
    const target = event.currentTarget as HTMLElement
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
    rememberWidth()
  }
  const resizeWithKeyboard = (event: KeyboardEvent) => {
    const widths: Record<string, number> = {
      ArrowLeft: sidebarWidth - 20, ArrowRight: sidebarWidth + 20,
      Home: minimumNavigationWidth, End: maximumNavigationWidth(viewportWidth),
    }
    if (!(event.key in widths)) return
    event.preventDefault()
    preferredWidth = navigationWidth(widths[event.key]!, viewportWidth)
    rememberWidth()
  }
  const pageUrl = (path: string) =>
    wikiPageUrl(
      path,
      new URLSearchParams(location.search).get('revision') ?? undefined,
    )
  const children = (path: string) =>
    entries.filter((entry) => entry.parent === path)
  const root = $derived(entries.find((entry) => entry.path === 'index.md'))
  const sections = $derived(
    entries.filter((entry) => entry.parent === 'index.md' && entry.hub),
  )
  const breadcrumbs = $derived.by(() => {
    const result: Entry[] = []
    let next = document?.parent
    while (next) {
      const entry = entries.find((value) => value.path === next)
      if (!entry) break
      result.unshift(entry)
      next = entry.parent
    }
    return result
  })
  const get = async <T,>(url: string): Promise<T> => {
    const response = await fetch(url),
      body = await response.json()
    if (!response.ok)
      throw new Error(
        typeof body.error === 'string'
          ? body.error
          : 'Knowledge request failed',
      )
    return body as T
  }
  const open = async (): Promise<void> => {
    const id = ++requestId
    loading = true
    error = ''
    menuOpen = false
    try {
      const params = new URLSearchParams(location.search)
      const value = await get<Document>(
        `/api/knowledge/read?${new URLSearchParams({ path: params.get('path') ?? 'index.md', revision: params.get('revision') ?? publication })}`,
      )
      if (id !== requestId) return
      document = value
      html = renderWiki(value, params.get('revision') ?? undefined, entries)
      await tick()
      if (article?.querySelector('.mermaid')) {
        try {
          const { default: mermaid } = await import('mermaid')
          if (id !== requestId) return
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'neutral',
          })
          await mermaid.run({
            nodes: article.querySelectorAll<HTMLElement>('.mermaid'),
          })
        } catch (cause) {
          if (id === requestId)
            error = `Diagram could not be rendered: ${String(cause)}`
        }
      }
      if (id !== requestId) return
      if (location.hash)
        window.document
          .getElementById(decodeURIComponent(location.hash.slice(1)))
          ?.scrollIntoView()
      else window.scrollTo({ top: 0 })
    } catch (cause) {
      if (id === requestId) error = String(cause)
    } finally {
      if (id === requestId) loading = false
    }
  }
  const inspect = async (reference: string): Promise<void> => {
    const id = ++sourceId
    source = null
    sourceError = ''
    sourceLoading = true
    sourceQuery = ''
    dialog?.showModal()
    try {
      const normalized = reference.replace(
        /#L(\d+)(?:-L?(\d+))?$/,
        (_m, a, b) => `:${a}${b ? `-${b}` : ''}`,
      )
      const parsed = parseProductSourceReference(normalized)
      if (!parsed)
        throw new Error('This reference is not an exposed product source file.')
      const value = await get<Source>(
        `/api/knowledge/source?path=${encodeURIComponent(parsed.path)}`,
      )
      if (id !== sourceId) return
      source = value
      ranges = parsed.lineRanges
      await tick()
      dialog?.querySelector('.highlight')?.scrollIntoView({ block: 'center' })
    } catch (cause) {
      if (id === sourceId) sourceError = String(cause)
    } finally {
      if (id === sourceId) sourceLoading = false
    }
  }
  const followLink = (event: MouseEvent): void => {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return
    const anchor = (event.target as Element).closest('a')
    if (!anchor || anchor.target === '_blank') return
    if (anchor.dataset.source) {
      event.preventDefault()
      void inspect(anchor.dataset.source)
      return
    }
    const target = new URL(anchor.href)
    if (target.origin !== location.origin || target.pathname !== '/wiki') return
    if (target.search === location.search && target.hash) return
    ++searchId
    matches = null
    event.preventDefault()
    history.pushState(null, '', target)
    void open()
  }
  const search = async (more = false): Promise<void> => {
    const id = ++searchId
    try {
      if (!more) searchedQuery = query.trim()
      if (!searchedQuery) {
        matches = null
        nextOffset = undefined
        return
      }
      const result = await get<{
        revision: string
        matches: NonNullable<typeof matches>
        total: number
        nextOffset?: number
      }>(
        `/api/knowledge/search?query=${encodeURIComponent(searchedQuery)}&offset=${more ? (nextOffset ?? 0) : 0}`,
      )
      if (id !== searchId) return
      if (result.revision !== publication)
        throw new Error(
          'Knowledge changed. Reload to search the new publication.',
        )
      matches = more ? [...(matches ?? []), ...result.matches] : result.matches
      nextOffset = result.nextOffset
      matchTotal = result.total
    } catch (cause) {
      if (id === searchId) error = String(cause)
    }
  }
  onMount(() => {
    try {
      const saved = localStorage.getItem(widthKey)
      if (saved !== null) preferredWidth = navigationWidth(Number(saved), Number.MAX_SAFE_INTEGER)
    } catch (cause) { console.warn('Wiki navigation width could not be restored', cause) }
    const pop = () => {
      const params = new URLSearchParams(location.search)
      // Native hash navigation also emits popstate. It changes position, not
      // the document/publication, so it must not refetch or rerender diagrams.
      if (
        (params.get('path') ?? 'index.md') === document?.path &&
        (params.get('revision') ?? publication) === document?.revision
      ) {
        ++requestId
        loading = false
        error = ''
        return
      }
      void open()
    }
    window.addEventListener('popstate', pop)
    window.document.addEventListener('click', followLink)
    void get<{ revision: string; documents: Entry[]; sourceBaseUrl?: string }>(
      '/api/knowledge/index',
    )
      .then(async (value) => {
        entries = value.documents
        publication = value.revision
        sourceBaseUrl = value.sourceBaseUrl
        await open()
      })
      .catch((cause) => {
        error = String(cause)
      })
    return () => {
      window.removeEventListener('popstate', pop)
      window.document.removeEventListener('click', followLink)
      ++requestId
      ++sourceId
      ++searchId
    }
  })
</script>

<svelte:window bind:innerWidth={viewportWidth} />

{#snippet tree(nodes: Entry[])}
  <ul>
    {#each nodes as entry (entry.path)}<li>
        {#if entry.hub && children(entry.path).length}<details
            open={document?.path === entry.path ||
              breadcrumbs.some((parent) => parent.path === entry.path)}
          >
            <summary
              ><a
                class:selected={document?.path === entry.path}
                href={pageUrl(entry.path)}>{entry.title}</a
              ><span class="disclosure" aria-hidden="true">▸</span></summary
            >{@render tree(children(entry.path))}
          </details>
        {:else}<a
            class:selected={document?.path === entry.path}
            href={pageUrl(entry.path)}>{entry.title}</a
          >{/if}
      </li>{/each}
  </ul>
{/snippet}
<svelte:head
  ><title>{document?.title ?? 'Knowledge'} · Leitbild.ai</title></svelte:head
>
<header class="wiki-header">
  <Wordmark href="/workspaces" tone="dark" mark label="Leitbild.ai home" /><span class="header-label"
    >Knowledge & reference</span
  >
  <form
    onsubmit={(event) => {
      event.preventDefault()
      void search()
    }}
  >
    <input
      aria-label="Search knowledge"
      bind:value={query}
      placeholder="Search the wiki…"
    /><button type="submit">Search</button>
  </form>
  <WikiAssistant page={document} />
  <button
    class="menu-button"
    onclick={() => (menuOpen = !menuOpen)}
    aria-expanded={menuOpen}>Contents</button
  >
</header>
<div class="wiki-layout" class:dragging style={`--navigation-width: ${sidebarWidth}px`}>
  <aside id="wiki-navigation" class="navigation" class:mobile-open={menuOpen}>
    <nav aria-label="Knowledge sections">
      {#if root}<section class="nav-section">
          <a
            class="section-title"
            class:selected={document?.path === root.path}
            href={pageUrl(root.path)}>{root.title}</a
          >{@render tree(children(root.path).filter((entry) => !entry.hub))}
        </section>{/if}
      {#each sections as section}<section class="nav-section">
          <a
            class="section-title"
            class:selected={document?.path === section.path}
            href={pageUrl(section.path)}>{section.title}</a
          >{@render tree(children(section.path))}
        </section>{/each}
    </nav>
  </aside>
  <!-- A focusable ARIA separator is an adjustable splitter, not a static rule. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="navigation-divider"
    role="separator"
    tabindex="0"
    aria-label="Resize wiki navigation"
    aria-orientation="vertical"
    aria-controls="wiki-navigation"
    aria-valuemin={minimumNavigationWidth}
    aria-valuemax={maximumNavigationWidth(viewportWidth)}
    aria-valuenow={Math.round(sidebarWidth)}
    title="Drag to resize navigation. Arrow keys adjust; double-click resets."
    onpointerdown={beginResize}
    onpointermove={resize}
    onpointerup={finishResize}
    onpointercancel={finishResize}
    onlostpointercapture={finishResize}
    onkeydown={resizeWithKeyboard}
    ondblclick={() => { preferredWidth = defaultNavigationWidth; rememberWidth() }}
  ></div>
  <main aria-busy={loading}>
    {#if error}<div class="error" role="alert">{error}</div>{/if}
    {#if matches !== null}<section class="search-results">
        <div class="search-title">
          <h2>Search results</h2>
          <button
            onclick={() => {
              ++searchId
              matches = null
            }}>Close search</button
          >
        </div>
        <p>
          {matches.length} of {matchTotal} documents matching “{searchedQuery}”
        </p>
        {#each matches as match}<a
            class="result"
            href={pageUrl(match.path) +
              (match.section ? `#${match.section}` : '')}
            ><strong>{match.title}</strong><span>{match.snippet}</span></a
          >{/each}{#if nextOffset !== undefined}<button
            onclick={() => search(true)}>More results</button
          >{/if}
      </section>{/if}
    {#if document}
      <div class="page-tools">
        <nav class="breadcrumbs" aria-label="Breadcrumb">
          {#each breadcrumbs as crumb}<a href={pageUrl(crumb.path)}
              >{crumb.title}</a
            ><span aria-hidden="true">/</span>{/each}<span
            >{document.title}</span
          >
        </nav>
        <WikiFeedback
          path={document.path}
          title={document.title}
          revision={document.revision}
        />
      </div>
      {#if loading}<span class="loading" role="status">Loading…</span>{/if}
      <article bind:this={article}>{@html html}</article>
      {#if document.children.length}<section class="explore">
          <h2>Explore this section</h2>
          <div class="child-grid">
            {#each document.children as entry}<a
                class="child-card"
                href={pageUrl(entry.path)}
                ><strong>{entry.title}<span aria-hidden="true">→</span></strong>
                <p>{entry.summary}</p></a
              >{/each}
          </div>
        </section>{/if}
      <footer>
        <span>Reference knowledge · {document.revision.slice(0, 12)}</span>
      </footer>
    {:else if loading}<p role="status">Loading knowledge…</p>{/if}
  </main>
</div>
<dialog
  bind:this={dialog}
  aria-label="Implementation source"
  onclose={() => {
    ++sourceId
  }}
>
  <header class="source-header">
    <div>
      <strong>Implementation source</strong>
      <p>{source?.path ?? 'Read-only inspection'}</p>
    </div>
    <button onclick={() => dialog?.close()} aria-label="Close source">✕</button>
  </header>
  {#if sourceLoading}<p role="status">
      Loading source…
    </p>{/if}{#if sourceError}<p class="error" role="alert">
      {sourceError}
    </p>{/if}
  {#if source}<div class="source-tools">
      <span>Code revision: {source.revision}</span><input
        aria-label="Highlight source text"
        bind:value={sourceQuery}
        placeholder="Highlight text…"
      />{#if sourceBaseUrl}<a
          target="_blank"
          rel="noopener"
          href={`${sourceBaseUrl}${source.path}`}>Open on GitHub ↗</a
        >{/if}
    </div>
    <pre class="source-code"><code
        >{#each source.content.split(/\r?\n/) as line, i}<span
            class:highlight={ranges.some(
              (range) => i + 1 >= range.startLine && i + 1 <= range.endLine,
            ) ||
              (sourceQuery.length > 0 &&
                line.toLowerCase().includes(sourceQuery.toLowerCase()))}
            ><small>{i + 1}</small>{line}{'\n'}</span
          >{/each}</code
      ></pre>{/if}
</dialog>

<style>
  :global(body) {
    margin: 0;
    background: #fafbf9;
    color: #24372e;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  }
  .wiki-header {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 1.4rem;
    min-height: var(--lb-topbar-h);
    padding: 0 2rem;
    background: var(--lb-brand-900);
    color: var(--lb-on-dark);
    border-bottom: 1px solid #0d150f;
  }
  .header-label {
    font-size: 0.85rem;
    color: #bacdc1;
  }
  .wiki-header form {
    display: flex;
    gap: 0.4rem;
    margin-left: auto;
  }
  input {
    min-width: 0;
    padding: 0.6rem 0.75rem;
    border: 1px solid #cad6ce;
    border-radius: 6px;
    font: inherit;
    background: #fff;
    color: #24372e;
  }
  button {
    font: inherit;
    cursor: pointer;
    border: 1px solid #c4d0c7;
    border-radius: 6px;
    padding: 0.45rem 0.7rem;
    background: #fff;
    color: #294537;
  }
  button:hover {
    background: #e4eee7;
  }
  .menu-button {
    display: none;
  }
  .wiki-layout {
    display: grid;
    grid-template-columns: var(--navigation-width) 6px minmax(0, 1fr);
    margin: 0;
  }
  .wiki-layout.dragging {
    cursor: col-resize;
    user-select: none;
  }
  .navigation-divider {
    position: sticky;
    top: 75px;
    height: calc(100vh - 95px);
    cursor: col-resize;
    touch-action: none;
    background: linear-gradient(to right, transparent 2px, #d9e3dc 2px, #d9e3dc 3px, transparent 3px);
  }
  .navigation-divider:hover,
  .navigation-divider:focus-visible,
  .dragging .navigation-divider {
    background: #8aaf96;
  }
  .navigation {
    position: sticky;
    top: 75px;
    height: calc(100vh - 95px);
    overflow: auto;
    padding: 1.5rem 1.25rem 1.5rem 0.25rem;
    min-width: 0;
    font-size: 0.85rem;
  }
  .nav-section {
    margin-bottom: 1.8rem;
  }
  .section-title {
    display: block;
    text-decoration: none;
    font-weight: 750;
    font-size: 0.95rem;
    padding: 0.45rem 0.5rem;
    color: #203d2d;
  }
  .navigation ul {
    list-style: none;
    padding: 0;
    margin: 0.15rem 0;
  }
  .navigation ul ul {
    padding-left: 0.4rem;
    border-left: 1px solid #d9e3dc;
    margin-left: 0.45rem;
  }
  .navigation li {
    margin: 0.15rem 0;
  }
  .navigation li a {
    display: block;
    padding: 0.4rem 0.5rem;
    text-decoration: none;
    color: #4a5e52;
    line-height: 1.4;
    border-radius: 5px;
  }
  .navigation summary {
    display: flex;
    align-items: center;
    cursor: pointer;
    list-style: none;
  }
  .navigation summary::-webkit-details-marker { display: none; }
  .navigation summary::marker { content: ''; }
  .navigation summary a {
    flex: 1;
    min-width: 0;
  }
  .navigation a { overflow-wrap: anywhere; }
  .disclosure {
    flex: none;
    padding: 0.35rem 0.5rem;
    color: #6c7e72;
  }
  details[open] > summary > .disclosure { transform: rotate(90deg); }
  .navigation a:hover,
  .navigation a.selected {
    color: #12603c;
    background: #e3eee6;
  }
  .navigation a.selected {
    font-weight: 650;
  }
  main {
    width: 100%;
    box-sizing: border-box;
    max-width: 1100px;
    margin: 0 auto;
    min-width: 0;
    padding: 2rem 2rem 4rem;
  }
  .page-tools {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    margin-bottom: 1.3rem;
  }
  .breadcrumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    font-size: 0.75rem;
    color: #6c7e72;
    margin-bottom: 0;
  }
  .breadcrumbs a {
    color: #3e7555;
    text-decoration: none;
  }
  .loading {
    font-size: 0.8rem;
    color: #567a63;
  }
  article {
    line-height: 1.8;
    font-size: 0.97rem;
    container-type: inline-size;
  }
  article :global(h1) {
    font-size: 2.25rem;
    line-height: 1.2;
    font-weight: 650;
    letter-spacing: -0.035em;
    margin: 0 0 1.6rem;
    color: #163d29;
  }
  article :global(h2) {
    font-size: 1.4rem;
    font-weight: 650;
    margin-top: 2.5rem;
    letter-spacing: -0.015em;
  }
  article :global(h3) {
    font-size: 1.08rem;
    margin-top: 1.8rem;
  }
  article :global(h1),
  article :global(h2),
  article :global(h3),
  article :global(h4) {
    scroll-margin-top: 100px;
  }
  article :global(p) {
    margin: 0.8rem 0 1.2rem;
  }
  article :global(a) {
    color: #146747;
    text-decoration-color: #a7c7b3;
    text-underline-offset: 3px;
  }
  article :global(a:hover) {
    color: #083d28;
    text-decoration-color: currentColor;
  }
  article :global(blockquote) {
    border-left: 3px solid #70a885;
    background: #edf4ee;
    padding: 0.4rem 1.2rem;
    margin: 1.5rem 0;
    color: #42634d;
  }
  article :global(pre) {
    overflow: auto;
    background: #eef2ee;
    padding: 1.2rem;
    border: 1px solid #dee6df;
    border-radius: 8px;
    line-height: 1.55;
    font-size: 0.8rem;
  }
  article :global(code) {
    font-size: 0.85em;
    overflow-wrap: anywhere;
  }
  article :global(table) {
    display: block;
    overflow: auto;
    border-collapse: collapse;
    width: 100%;
    font-size: 0.88rem;
  }
  article :global(th) {
    text-align: left;
    background: #eaf1eb;
  }
  article :global(td),
  article :global(th) {
    padding: 0.65rem 0.8rem;
    border: 1px solid #dce5df;
  }
  article :global(img),
  article :global(svg) {
    max-width: 100%;
    height: auto;
  }
  article :global(.wiki-diagram) {
    overflow: auto;
    margin: 1.6rem 0;
  }
  article :global(.procedure-step) {
    border-top: 1px solid #dce5df;
    padding-top: 1rem;
    margin-top: 1.8rem;
    line-height: 1.5;
  }
  article :global(.procedure-step h2) {
    margin: 0 0 1rem;
    font-size: 1.15rem;
  }
  article :global(.procedure-columns) {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 1.5rem;
  }
  article :global(.procedure-responses) {
    border-left: 1px solid #dce5df;
    padding-left: 1.2rem;
  }
  article :global(.procedure-instruction) {
    margin-bottom: 0.8rem;
  }
  article :global(.procedure-instruction > strong) {
    display: block;
    font-size: 0.76rem;
    color: #526358;
  }
  article :global(.procedure-instruction > p) {
    margin: 0.2rem 0 0;
  }
  article :global(.procedure-caution) {
    border-left: 3px solid #ac762c;
    background: #faf4e8;
    padding: 0.6rem 0.8rem;
  }
  article :global(.procedure-routes h3) {
    font-size: 0.8rem;
    margin: 1rem 0 0.4rem;
    color: #526358;
  }
  article :global(.procedure-routes ul) {
    margin: 0;
    padding-left: 1.2rem;
  }
  article :global(.procedure-routes li) {
    margin: 0.4rem 0;
  }
  article :global(.procedure-outcome) {
    color: #526358;
    font-size: 0.78rem;
    font-weight: 600;
  }
  article :global(.procedure-rationale) {
    margin: 0.1rem 0;
    font-size: 0.86rem;
    color: #526358;
  }
  article :global(.procedure-basis),
  article :global(.procedure-reference) {
    margin: 1rem 0;
    font-size: 0.86rem;
  }
  article :global(.procedure-basis summary),
  article :global(.procedure-reference summary) {
    cursor: pointer;
    color: #146747;
  }
  article :global(.procedure-applicability),
  article :global(.procedure-reader-notice) {
    font-size: 0.82rem;
    color: #526358;
    line-height: 1.5;
  }
  @container (max-width: 640px) {
    article :global(.procedure-columns) {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.5rem;
    }
    article :global(.procedure-responses) {
      border-left: 0;
      border-top: 1px solid #dce5df;
      padding: 0.8rem 0 0;
    }
  }
  .explore {
    border-top: 1px solid #dde7df;
    margin-top: 2rem;
    padding-top: 1rem;
  }
  .explore h2 {
    font-size: 1.15rem;
  }
  .child-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 0.8rem;
  }
  .child-card {
    border: 1px solid #d8e4db;
    border-radius: 9px;
    padding: 1.1rem;
    text-decoration: none;
    color: inherit;
    background: #fff;
    transition:
      border-color 0.15s,
      background 0.15s;
  }
  .child-card:hover {
    border-color: #73a687;
    background: #f1f7f2;
  }
  .child-card strong {
    display: flex;
    justify-content: space-between;
    gap: 0.7rem;
    font-size: 0.94rem;
    color: #235439;
  }
  .child-card p {
    font-size: 0.82rem;
    line-height: 1.6;
    color: #64746a;
    margin: 0.7rem 0 0;
  }
  .child-card strong span {
    color: #6a997b;
  }
  footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    margin-top: 3rem;
    border-top: 1px solid #e0e7e1;
    padding-top: 1rem;
    font-size: 0.72rem;
    color: #728177;
  }
  .error {
    padding: 1rem;
    background: #fff0eb;
    color: #9b3e20;
    border-radius: 8px;
    margin-bottom: 1rem;
  }
  .search-results {
    border: 1px solid #cadfd1;
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 2rem;
    background: #f0f6f1;
  }
  .search-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .search-title h2 {
    margin: 0;
  }
  .search-results p {
    font-size: 0.85rem;
  }
  .result {
    display: block;
    border-top: 1px solid #d9e5dc;
    padding: 0.8rem 0;
    text-decoration: none;
    color: inherit;
  }
  .result span {
    display: block;
    font-size: 0.8rem;
    margin-top: 0.3rem;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  dialog {
    width: min(1100px, 92vw);
    max-height: 85vh;
    border: 1px solid #a8bdb0;
    border-radius: 12px;
    padding: 0;
    background: #fbfdfa;
    color: #24372e;
    box-shadow: 0 30px 100px #10261a66;
  }
  dialog::backdrop {
    background: #12231b99;
    backdrop-filter: blur(3px);
  }
  .source-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.3rem;
    border-bottom: 1px solid #dce6df;
  }
  .source-header p {
    font-size: 0.8rem;
    margin: 0.35rem 0 0;
    overflow-wrap: anywhere;
  }
  .source-tools {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    padding: 0.7rem 1.3rem;
    font-size: 0.75rem;
  }
  .source-tools input {
    font-size: 0.8rem;
  }
  .source-tools a {
    color: #196640;
  }
  .source-code {
    margin: 0;
    overflow: auto;
    max-height: 60vh;
    background: #f0f4f0;
    padding: 1rem 0;
    font-size: 0.77rem;
    line-height: 1.6;
  }
  .source-code span {
    display: block;
    min-width: max-content;
    white-space: pre;
  }
  .source-code small {
    display: inline-block;
    min-width: 4rem;
    padding-right: 1rem;
    text-align: right;
    color: #8b9c90;
    user-select: none;
  }
  .source-code .highlight {
    background: #dcebc2;
  }
  @media (max-width: 750px) {
    .wiki-header {
      padding: 0.5rem 1rem;
      gap: 0.6rem;
      flex-wrap: wrap;
    }
    .header-label {
      display: none;
    }
    .wiki-header form {
      flex: 1;
    }
    .wiki-header input {
      width: 100%;
    }
    .menu-button {
      display: block;
    }
    .wiki-layout {
      display: block;
      padding: 0 1rem;
    }
    .navigation-divider { display: none; }
    .navigation {
      display: none;
      position: static;
      height: auto;
      max-height: 65vh;
      border-right: 0;
      border-bottom: 1px solid #dce5df;
    }
    .navigation.mobile-open {
      display: block;
    }
    main {
      padding: 1.5rem 0;
    }
    article :global(h1) {
      font-size: 1.8rem;
    }
    .child-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
