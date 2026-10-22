/** Display performance baseline (plan v5 §5.8): every release stays within +20 % of it.
 *
 *   bun scripts/display-eval/perf.ts mature  --origin=http://127.0.0.1:<port> --workspace=<id> [--definition=<featured id>]
 *     Starts the featured demo (default halden-offsite-power-restoration) and advances it at maximum pace until its
 *     Historian holds its sample budget (features/historian/policy.ts), then five minutes more so eviction runs, and
 *     leaves it paused. Prints the Run id. A young Run hides what history size costs.
 *
 *   bun scripts/display-eval/perf.ts measure --origin=… --workspace=<id> --run=<mature Run> --out=<file.json>
 *       [--port=<CDP port>] [--profile=<Chrome profile dir>] [--seconds=60] [--trace=<file.json>] [--label=<name>]
 *     In its own headless Chrome at 1920 × 1080 with the Assistant's chat open: the map alone for 15 s; the first
 *     unit overview opened from the rail (first open); the next three units through the deck (first open of each,
 *     so four are mounted); switches between the four mounted entries; the Run playing at realtime for `seconds`
 *     with a CDP trace (main-thread time) and every sample timed in the page (server time = the request's time to
 *     first byte; client apply = from the response to the frame painted after the client read it); pop-over open
 *     times on four drawn items; the World embed bundle as its frame loaded it. Leaves the Run paused.
 *
 *   bun scripts/display-eval/perf.ts summarize --out=<baseline.json> <measure.json …>
 *     The median of each metric over several measurements of one stack (the baseline file).
 *
 *   bun scripts/display-eval/perf.ts compare --baseline=<baseline.json> <measure.json | baseline.json> [--floor-ms=<n>]
 *     Each metric against the baseline; one more than 20 % above it fails (§5.8), a time only when it also rose by
 *     more than --floor-ms (default 0). Exits 1 on a failure. Compare a summary of three measurements, not one.
 *
 * Writes one JSON file; the shots and the trace go beside it. Loopback stacks only; no model is called. */
import { gzipSync } from 'node:zlib'
import { cpus, loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { ensureChrome, loopbackOrigin, openPage, options, sleep, type Page } from './browser.ts'
import { createStackApi } from './stack-api.ts'

const MATURE_SHARE = 0.97
/** The display generations' sample requests: today's vignette and the pre-swap composed display. */
const SAMPLE_URL = String.raw`/displays/sample|display\.sample/invoke`

const mature = async (origin: string, workspaceId: string, definitionId: string): Promise<void> => {
  const api = createStackApi(origin, workspaceId)
  const runId = await api.launchFeatured(definitionId)
  await api.rename(runId, 'P · perf: history at its budget')
  console.log(`Run ${runId}`)
  for (let chunk = 0; ; chunk += 1) {
    const status = await api.historian(runId)
    const share = status === null ? 0 : status.sampleCount / status.limits.maxSamples
    console.log(JSON.stringify({ at: (await api.presence(runId)).execution.currentSimulationTime, samples: status?.sampleCount, budget: status?.limits.maxSamples, share: Number(share.toFixed(3)), databaseBytes: status?.databaseBytes, captureState: status?.captureState }))
    if (share >= MATURE_SHARE) break
    if (chunk > 30) throw new Error('the Historian did not reach its budget in 300 simulated minutes')
    await api.advance(runId, 10)
  }
  // At the budget the store evicts on every write: run on so the measurement sees that steady state.
  await api.advance(runId, 5)
  const status = await api.historian(runId)
  console.log(JSON.stringify({ mature: runId, at: (await api.presence(runId)).execution.currentSimulationTime, samples: status?.sampleCount, budget: status?.limits.maxSamples, databaseBytes: status?.databaseBytes }))
}

// ---------- in-page instrumentation ----------

/** Runs in every frame before its scripts: in a display embed, times each sample request from its start to its
 * response, to its body read (the client then parses it and updates the display in the same task and its
 * microtasks), and to the frame painted after that (a timer queued from the next animation frame), and keeps
 * Resource Timing for every request. */
export const INSTRUMENT = `(() => {
  if (!/\\/world\\/embed\\//.test(location.pathname) || window.__lbSamples !== undefined) return
  performance.setResourceTimingBufferSize(100000)
  const now = () => performance.timeOrigin + performance.now()
  const records = window.__lbSamples = []
  const fetchNative = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!new RegExp(${JSON.stringify(SAMPLE_URL)}).test(url)) return fetchNative(input, init)
    // Which display asked: a pop-over's sample carries another view state than its window's.
    const record = { start: now(), url, key: typeof init?.body === 'string' ? init.body.length + ':' + init.body.slice(0, 120) : '' }
    records.push(record)
    const response = await fetchNative(input, init)
    record.headers = now()
    record.status = response.status
    for (const method of ['text', 'json']) {
      const read = response[method].bind(response)
      response[method] = async () => {
        const body = await read()
        record.body = now()
        requestAnimationFrame(() => setTimeout(() => { record.painted = now() }, 0))
        return body
      }
    }
    return response
  }
})()`

/** The shown display embed's frame (the largest shown), as `__lb.documents()` finds it. */
export const SHOWN_EMBED = `(() => { const docs = lb.documents().filter(d => d.frame && /\\/world\\/embed\\//.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame)); const area = d => { const r = d.frame.getBoundingClientRect(); return r.width * r.height }; return docs.sort((a, b) => area(b) - area(a))[0] ?? null })()`

/** The shown display's sample records painted after `since` (epoch ms), and its title; with `other`, only samples of
 * another view than the window's own (a pop-over's). */
const shownSince = (page: Page, since: number, other = false) => page.eval<{ title: string; painted: number | null; count: number } | null>(`(() => {
  const shown = ${SHOWN_EMBED}
  if (shown === null) return null
  const win = shown.doc.defaultView
  // Chrome now and then does not run the new-document script in a deck frame: instrument it at once (its view is
  // read before its first sample, so the first sample is still timed), and count it.
  if (win.__lbSamples === undefined) { win.eval(${JSON.stringify(INSTRUMENT)}); window.__lbLate = (window.__lbLate ?? 0) + 1 }
  const own = (win.__lbSamples ?? []).filter(record => record.start < ${since}).at(-1)?.key
  const records = (win.__lbSamples ?? []).filter(record => record.start >= ${since} && record.painted !== undefined && (!${other} || record.key !== own))
  const title = (shown.doc.querySelector('article.vignette > header h1, article.card h1, article.card .title')?.textContent ?? '').trim()
  return { title, painted: records.length > 0 ? Math.min(...records.map(record => record.painted)) : null, count: records.length }
})()`)

/** Waits for the shown display to paint a sample requested after `since`; returns the ms from `since`. */
const paintedAfter = async (page: Page, since: number, title?: string, timeoutMs = 60_000, other = false): Promise<number> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await shownSince(page, since, other)
    if (state !== null && state.painted !== null && (title === undefined || state.title.includes(title))) return state.painted - since
    if (Date.now() > deadline) throw new Error(`no sample painted within ${timeoutMs} ms${title === undefined ? '' : ` on ${title}`}: ${JSON.stringify(state)}`)
    await sleep(25)
  }
}

const percentile = (values: ReadonlyArray<number>, p: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! * 10) / 10
}
const stats = (values: ReadonlyArray<number>) => ({ n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: percentile(values, 100), values: values.map(value => Math.round(value * 10) / 10) })

// ---------- trace ----------

const TRACE_CATEGORIES = ['-*', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'toplevel', 'v8.execute', 'blink.user_timing', 'loading'].join(',')

const startTrace = (page: Page) => page.send('Tracing.start', { categories: TRACE_CATEGORIES, transferMode: 'ReturnAsStream', options: 'sampling-frequency=10000' })
const endTrace = async (page: Page): Promise<any[]> => {
  const complete = new Promise<any>(resolve => { const off = page.on('Tracing.tracingComplete', params => { off(); resolve(params) }) })
  await page.send('Tracing.end')
  const { stream } = await complete
  let text = ''
  for (;;) {
    const chunk = await page.send('IO.read', { handle: stream, size: 4 * 1024 * 1024 })
    text += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data
    if (chunk.eof) break
  }
  await page.send('IO.close', { handle: stream })
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : parsed.traceEvents
}

const BUCKETS: Readonly<Record<string, ReadonlyArray<string>>> = {
  script: ['FunctionCall', 'EvaluateScript', 'v8.compile', 'v8.compileModule', 'EvaluateModule', 'RunMicrotasks', 'v8.run'],
  style: ['UpdateLayoutTree', 'RecalculateStyles', 'ParseAuthorStyleSheet'],
  layout: ['Layout', 'IntersectionObserverController::computeIntersections'],
  paint: ['PrePaint', 'Paint', 'Layerize', 'Commit', 'UpdateLayer', 'PaintImage', 'RasterTask'],
  gc: ['MinorGC', 'MajorGC', 'V8.GC_SCAVENGER', 'V8.GC_MARK_COMPACTOR', 'BlinkGC.AtomicPhase', 'ThreadState::performIdleLazySweep'],
}

/** Main-thread time of the page's renderer(s) over the trace: top-level tasks, and their time by kind. */
const mainThread = (events: ReadonlyArray<any>, origin: string) => {
  const started = events.find(event => event.name === 'TracingStartedInBrowser')
  const pids = new Set<number>((started?.args?.data?.frames ?? []).filter((frame: any) => String(frame.url ?? '').startsWith(origin)).map((frame: any) => frame.processId))
  const mains = new Set(events.filter(event => event.ph === 'M' && event.name === 'thread_name' && event.args?.name === 'CrRendererMain' && (pids.size === 0 || pids.has(event.pid))).map(event => `${event.pid}:${event.tid}`))
  const onMain = events.filter(event => event.ph === 'X' && mains.has(`${event.pid}:${event.tid}`) && typeof event.dur === 'number')
  const span = (list: ReadonlyArray<any>) => {
    let total = 0, end = -Infinity
    for (const event of [...list].sort((a, b) => a.ts - b.ts)) {
      if (event.ts >= end) { total += event.dur; end = event.ts + event.dur } else if (event.ts + event.dur > end) { total += event.ts + event.dur - end; end = event.ts + event.dur }
    }
    return total / 1000
  }
  const tasks = onMain.filter(event => event.name === 'RunTask' || event.name === 'ThreadControllerImpl::RunTask')
  const timed = onMain.filter(event => event.ts !== undefined)
  const first = Math.min(...timed.map(event => event.ts)), last = Math.max(...timed.map(event => event.ts + event.dur))
  return {
    rendererProcesses: [...pids],
    windowMs: Math.round((last - first) / 1000),
    busyMs: Math.round(span(tasks)),
    longTasks: tasks.filter(event => event.dur >= 50_000).length,
    byKind: Object.fromEntries(Object.entries(BUCKETS).map(([kind, names]) => [kind, Math.round(span(onMain.filter(event => names.includes(event.name))))])),
  }
}

// ---------- the measurement ----------

const VIGNETTE_ITEMS = ['Steam Generator A', 'Pressurizer', 'Reactor Core', 'Reactor Coolant Pump A']
const OLD_ITEMS = ['Quick look: SG A', 'Control · Quick look: PZR', 'Control · Quick look: Core', 'Control · Quick look: RCP A']

const measure = async (origin: string, workspaceId: string, runId: string, out: string, argv: ReturnType<typeof options>): Promise<void> => {
  const api = createStackApi(origin, workspaceId)
  const port = Number(argv.get('port') ?? 44331)
  const seconds = Number(argv.get('seconds') ?? 60)
  const shots = join(dirname(out), `${argv.get('label') ?? 'perf'}-shots`)
  const chrome = await ensureChrome({ port, profile: argv.get('profile') ?? join(dirname(out), 'chrome-perf') })
  await api.pause(runId)
  await api.load(runId)
  const historian = await api.historian(runId)
  const page = await openPage(port, 1920, 1080)
  const result: Record<string, unknown> = {
    label: argv.get('label') ?? null, origin, workspaceId, runId, at: new Date().toISOString(),
    run: { simulationTime: (await api.presence(runId)).execution.currentSimulationTime, historian },
    machine: { cpus: cpus().length, loadavgAtStart: loadavg().map(value => Number(value.toFixed(2))) },
    viewport: '1920x1080', chat: 'open',
  }
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })
    // And as each new page context comes up: Chrome now and then skips the new-document script in a deck frame.
    page.on('Runtime.executionContextCreated', ({ context }) => {
      // A context can close before the call lands; the late check in shownSince covers that frame.
      if (context.origin === origin && context.auxData?.isDefault === true) void page.send('Runtime.evaluate', { expression: INSTRUMENT, contextId: context.id }).catch(() => undefined)
    })
    await page.goto(`${origin}/workspaces/${workspaceId}?world=${encodeURIComponent(runId)}`)
    await page.waitFor({ sel: 'button', text: 'Open process display for Halden Unit 1' }, 120_000)
    await page.click({ sel: 'button', text: 'Open Leitbild Assistant' })
    await page.until(`lb.documents().some(d => d.frame && /\\/agents/.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame))`, 60_000)
    await sleep(10_000)

    // The page without a display: the map and the chat alone.
    await startTrace(page)
    await sleep(15_000)
    const idle = mainThread(await endTrace(page), origin)
    result.idleWithoutDisplay = { ...idle, busyMsPerSecond: Math.round((idle.busyMs / idle.windowMs) * 1000 * 10) / 10 }

    // First open from the rail.
    const opened = Date.now()
    await page.click({ sel: 'button', text: 'Open process display for Halden Unit 1' })
    const firstOpenMs = await paintedAfter(page, opened, 'Halden Unit 1', 120_000)
    const generation = await page.eval<string>(`(() => { const shown = ${SHOWN_EMBED}; return shown === null ? 'none' : shown.doc.querySelector('article.vignette') ? 'vignette' : 'old' })()`)
    result.generation = generation
    result.firstOpenMs = Math.round(firstOpenMs)
    await page.shot(join(shots, '1-first-open.png'))

    // The next three units through the deck: each a first open, so four frames are mounted.
    const deckFirstOpenMs: number[] = []
    for (const unit of [2, 3, 4]) {
      const at = Date.now()
      await page.click({ sel: 'button[aria-label="Next display"]' })
      deckFirstOpenMs.push(await paintedAfter(page, at, `Halden Unit ${unit}`))
      await sleep(1_500)
    }
    result.deckFirstOpenMs = stats(deckFirstOpenMs)

    // Switches between mounted entries: 4 → 1 and back, twice.
    const switchMs: number[] = []
    for (const round of [1, 2]) {
      for (const [button, unit] of [['Previous display', 3], ['Previous display', 2], ['Previous display', 1], ['Next display', 2], ['Next display', 3], ['Next display', 4]] as const) {
        const at = Date.now()
        await page.click({ sel: `button[aria-label="${button}"]` })
        switchMs.push(await paintedAfter(page, at, `Halden Unit ${unit}`))
        await sleep(1_200)
      }
      void round
    }
    result.switchMs = stats(switchMs)
    for (const _ of [3, 2, 1]) { await page.click({ sel: 'button[aria-label="Previous display"]' }); await sleep(800) }
    await paintedAfter(page, Date.now() - 1_000, 'Halden Unit 1')

    // Samples while the Run plays at realtime, with a trace.
    await api.playRealtime(runId)
    await sleep(5_000)
    const windowStart = Date.now()
    await startTrace(page)
    await sleep(seconds * 1_000)
    const events = await endTrace(page)
    const windowEnd = Date.now()
    await api.pause(runId)
    const traceFile = argv.get('trace')
    if (traceFile !== undefined) await Bun.write(traceFile, JSON.stringify(events))
    const sampled = await page.eval<{ records: any[]; timings: any[] }>(`(() => {
      const shown = ${SHOWN_EMBED}
      const win = shown.doc.defaultView
      const records = (win.__lbSamples ?? []).filter(record => record.start >= ${windowStart} && record.start <= ${windowEnd})
      const timings = win.performance.getEntriesByType('resource').filter(entry => new RegExp(${JSON.stringify(SAMPLE_URL)}).test(entry.name))
        .map(entry => ({ at: win.performance.timeOrigin + entry.startTime, ttfb: entry.responseStart - entry.requestStart, duration: entry.duration, bytes: entry.decodedBodySize }))
        .filter(entry => entry.at >= ${windowStart} && entry.at <= ${windowEnd})
      return { records, timings }
    })()`)
    const busy = mainThread(events, origin)
    const samplesPerSecond = sampled.records.length / ((windowEnd - windowStart) / 1000)
    const busyPerSecond = (busy.busyMs / busy.windowMs) * 1000
    const idlePerSecond = (idle.busyMs / idle.windowMs) * 1000
    result.samples = {
      seconds, count: sampled.records.length, perSecond: Math.round(samplesPerSecond * 100) / 100,
      serverMs: stats(sampled.timings.map(entry => entry.ttfb)),
      requestMs: stats(sampled.timings.map(entry => entry.duration)),
      applyMs: stats(sampled.records.filter(record => record.painted !== undefined).map(record => record.painted - record.headers)),
      responseBytes: stats(sampled.timings.map(entry => entry.bytes)),
    }
    result.mainThread = {
      ...busy,
      busyMsPerSecond: Math.round(busyPerSecond * 10) / 10,
      perSampleMs: Math.round((busyPerSecond / samplesPerSecond) * 10) / 10,
      // What the display adds over the page without it (map and chat), per sample.
      displayPerSampleMs: Math.round(((busyPerSecond - idlePerSecond) / samplesPerSecond) * 10) / 10,
    }
    await page.shot(join(shots, '2-after-play.png'))

    // Pop-overs (the pre-swap display's faceplates) on four drawn items.
    const popoverMs: Array<{ item: string; shownMs: number; contentMs?: number; paintedMs: number | null; words?: string }> = []
    for (const item of generation === 'vignette' ? VIGNETTE_ITEMS : OLD_ITEMS) {
      const target = generation === 'vignette' ? { sel: `.flow [role=button][aria-label^="${item}"]` } : { sel: `button[aria-label^="${item}"]` }
      // An item scrolled out of the frame (the narrow window) is scrolled into view first, as a person would.
      await page.eval(`(() => { const shown = ${SHOWN_EMBED}; const el = shown && shown.doc.querySelector(${JSON.stringify(target.sel)}); if (el) el.scrollIntoView({ block: 'center', inline: 'center' }); return el !== null })()`)
      await sleep(300)
      const hit = await page.find(target)
      if (hit === null) { popoverMs.push({ item, shownMs: -1, paintedMs: null }); continue }
      const at = Date.now()
      await page.click(hit)
      // Its card first, then its content: the element's default drawn, or the words it shows instead.
      const card = `(() => { const shown = ${SHOWN_EMBED}; return shown && shown.doc.querySelector('.popover[role=dialog], .popover[aria-label]') })()`
      const shownMs = await page.until(`${card} !== null`, 30_000, 20).catch(() => -1)
      const contentMs = shownMs < 0 ? -1 : await page.until(`(() => { const pop = ${card}; return pop !== null && pop.querySelector('.section, section, table, .status:not(:empty)') !== null && !/Reading the element/.test(pop.innerText) })()`, 30_000, 20).then(ms => ms + shownMs, () => -1)
      const words = shownMs < 0 ? null : await page.eval<string | null>(`(() => { const pop = ${card}; const status = pop && pop.querySelector('.status'); return status ? status.textContent.trim().slice(0, 160) : null })()`)
      // Its first own sample painted: the pop-over's view, not the window's.
      const paintedMs = generation === 'vignette' && contentMs >= 0 ? await paintedAfter(page, at, undefined, 10_000, true).then(Math.round, () => null) : null
      popoverMs.push({ item, shownMs, contentMs, paintedMs, ...(words === null ? {} : { words }) })
      await page.shot(join(shots, `3-popover-${item.replace(/[^A-Za-z0-9]+/g, '-')}.png`))
      await page.key('Escape')
      await sleep(1_000)
    }
    result.popover = { items: popoverMs, shownMs: stats(popoverMs.filter(entry => entry.shownMs >= 0).map(entry => entry.shownMs)), contentMs: stats(popoverMs.flatMap(entry => entry.contentMs !== undefined && entry.contentMs >= 0 ? [entry.contentMs] : [])), paintedMs: stats(popoverMs.flatMap(entry => entry.paintedMs === null ? [] : [entry.paintedMs])) }

    // The World embed bundle as the display frame loaded it: its scripts and styles, raw and gzipped.
    const resources = await page.eval<Array<{ name: string; type: string; decoded: number; encoded: number }>>(`(() => {
      const shown = ${SHOWN_EMBED}
      return shown.doc.defaultView.performance.getEntriesByType('resource').filter(entry => /\\.(js|css)(\\?|$)/.test(entry.name))
        .map(entry => ({ name: entry.name, type: entry.initiatorType, decoded: entry.decodedBodySize, encoded: entry.encodedBodySize }))
    })()`)
    const files = await Promise.all([...new Map(resources.map(entry => [entry.name, entry])).values()].map(async entry => {
      const body = new Uint8Array(await (await fetch(entry.name)).arrayBuffer())
      return { file: new URL(entry.name).pathname, bytes: body.length, gzipBytes: gzipSync(body, { level: 9 }).length }
    }))
    const sum = (kind: RegExp) => files.filter(file => kind.test(file.file)).reduce((total, file) => ({ bytes: total.bytes + file.bytes, gzipBytes: total.gzipBytes + file.gzipBytes }), { bytes: 0, gzipBytes: 0 })
    result.bundle = { js: sum(/\.js$/), css: sum(/\.css$/), files: files.sort((a, b) => b.bytes - a.bytes) }
    result.machine = { ...(result.machine as object), loadavgAtEnd: loadavg().map(value => Number(value.toFixed(2))) }
    result.lateInstrumentedFrames = await page.eval<number>('window.__lbLate ?? 0')
    result.console = page.console.slice(-20)
  } finally {
    await api.pause(runId).catch(() => undefined)
    await Bun.write(out, JSON.stringify(result, null, 2))
    await page.close()
    if (chrome.started) await chrome.stop()
  }
  console.log(JSON.stringify({ out, firstOpenMs: result.firstOpenMs, switchMs: (result.switchMs as any)?.p95, samples: result.samples, mainThread: result.mainThread }, null, 1))
}

// ---------- baseline and comparison ----------

/** The metrics a release is held to, lower is better. */
export const metricsOf = (result: any): Record<string, number | null> => ({
  firstOpenMs: result.firstOpenMs ?? null,
  deckFirstOpenMsP50: result.deckFirstOpenMs?.p50 ?? null,
  switchMsP50: result.switchMs?.p50 ?? null,
  switchMsP95: result.switchMs?.p95 ?? null,
  sampleServerMsP50: result.samples?.serverMs?.p50 ?? null,
  sampleServerMsP95: result.samples?.serverMs?.p95 ?? null,
  sampleApplyMsP50: result.samples?.applyMs?.p50 ?? null,
  sampleApplyMsP95: result.samples?.applyMs?.p95 ?? null,
  sampleResponseBytesP50: result.samples?.responseBytes?.p50 ?? null,
  mainThreadMsPerSample: result.mainThread?.perSampleMs ?? null,
  displayMainThreadMsPerSample: result.mainThread?.displayPerSampleMs ?? null,
  popoverContentMsP50: result.popover?.contentMs?.p50 ?? null,
  popoverPaintedMsP50: result.popover?.paintedMs?.p50 ?? null,
  embedJsGzipBytes: result.bundle?.js?.gzipBytes ?? null,
  embedCssGzipBytes: result.bundle?.css?.gzipBytes ?? null,
  embedJsBytes: result.bundle?.js?.bytes ?? null,
})

const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round(((sorted[middle - 1]! + sorted[middle]!) / 2) * 10) / 10
}

const summarize = async (out: string, files: ReadonlyArray<string>): Promise<void> => {
  const runs = await Promise.all(files.map(async file => ({ file, result: JSON.parse(await Bun.file(file).text()) })))
  const metrics = runs.map(run => metricsOf(run.result))
  const names = Object.keys(metrics[0] ?? {})
  const summary = {
    label: runs[0]?.result.label ?? null, origin: runs[0]?.result.origin ?? null, runId: runs[0]?.result.runId ?? null,
    generation: runs[0]?.result.generation ?? null, measuredAt: runs.map(run => run.result.at), files,
    loadavg: runs.map(run => run.result.machine),
    metrics: Object.fromEntries(names.map(name => [name, median(metrics.flatMap(entry => entry[name] === null || entry[name] === undefined ? [] : [entry[name]!]))])),
    spread: Object.fromEntries(names.map(name => [name, metrics.map(entry => entry[name] ?? null)])),
  }
  await Bun.write(out, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary.metrics, null, 1))
}

/** `floorMs`: a time metric fails only when it also rises by more than this many ms (a 6 ms median is noise-bound). */
const compare = async (baselineFile: string, candidateFile: string, floorMs = 0): Promise<boolean> => {
  const baseline = JSON.parse(await Bun.file(baselineFile).text())
  const candidate = JSON.parse(await Bun.file(candidateFile).text())
  const theirs: Record<string, number | null> = candidate.metrics ?? metricsOf(candidate)
  let pass = true
  for (const [name, base] of Object.entries(baseline.metrics as Record<string, number | null>)) {
    const value = theirs[name] ?? null
    const change = base === null || value === null || base === 0 ? null : (value - base) / base
    const over = change !== null && change > 0.2 && !(/Ms/.test(name) && value! - base! <= floorMs)
    if (over) pass = false
    console.log(`${over ? 'FAIL' : 'ok  '} ${name.padEnd(30)} baseline ${String(base).padStart(9)}  now ${String(value).padStart(9)}  ${change === null ? '' : `${change >= 0 ? '+' : ''}${Math.round(change * 100)} %`}`)
  }
  return pass
}

if (import.meta.main) {
  const argv = options(Bun.argv.slice(2))
  const [command, ...files] = argv.rest
  if (command === 'summarize') { const out = argv.get('out'); if (out === undefined) throw new Error('summarize needs --out=<file.json>'); await summarize(out, files); process.exit(0) }
  if (command === 'compare') { const baseline = argv.get('baseline'); if (baseline === undefined || files[0] === undefined) throw new Error('compare needs --baseline=<file.json> <file.json>'); process.exit(await compare(baseline, files[0], Number(argv.get('floor-ms') ?? 0)) ? 0 : 1) }
  const origin = loopbackOrigin(argv.get('origin'))
  const workspaceId = argv.get('workspace')
  if (workspaceId === undefined) throw new Error('--workspace=<id> is required')
  if (command === 'mature') await mature(origin, workspaceId, argv.get('definition') ?? 'halden-offsite-power-restoration')
  else if (command === 'measure') {
    const runId = argv.get('run'), out = argv.get('out')
    if (runId === undefined || out === undefined) throw new Error('measure needs --run=<id> and --out=<file.json>')
    await measure(origin, workspaceId, runId, out, argv)
  } else throw new Error('usage: perf.ts mature|measure|summarize|compare … (see the header)')
}
