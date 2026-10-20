/** T11 (plan v3.1 Appendix F): retrieval recall@8 of
 * world.simulation-run.observables.search (architecture A4) on at least 150
 * pairs, at least 20 per pack, every pack of the integrated fixture. A pair is
 * a person's or agent's words and what they mean, matched as the pair
 * declares (lead ruling R23): an observable by its ref `objectId#signalId`
 * (signalId as the pack declares it: the plant's variable path, the grid's
 * `<assetId>.<quantity>` or `grid.<name>`, the weather's quantity id), by
 * objectId + its I&C tag, a grid element by its asset id (or an observable
 * measured on it), or an object. Pairs live in
 * apps/world/tests/fixtures/retrieval/.
 *
 *   LEITBILD_PROBE_ORIGIN=http://127.0.0.1:<port> bun scripts/display-eval/retrieval.ts <absolute-output-dir> [--seconds=240]
 *
 * Runs on a loopback local stack only: saves the integrated fixture in its own
 * Workspace, plays it `--seconds` at maximum pace (the Einsatz cues create
 * Truck 2 and tasks R-2 and U-2 by then), checks every pair's expected
 * identity exists in that Run, then asks the search in batches of 8 queries. */
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { referencePlantCatalog } from './plant-catalog.ts'
import { fixturePath } from './scenarios.ts'

/** One search query as A4 takes it. */
export interface SearchQuery { readonly text: string; readonly pack?: string; readonly category?: string; readonly objectId?: string }

/** What a pair means; any one expectation among the top 8 matches is a hit. */
export type Expected =
  | { readonly kind: 'object'; readonly objectId: string }
  /** An observable by its ref, `objectId#signalId`. */
  | { readonly kind: 'ref'; readonly ref: string }
  /** An observable of this object carrying this I&C tag. */
  | { readonly kind: 'tag'; readonly objectId: string; readonly tag: string }
  /** A grid element by its asset id, or an observable measured on it. */
  | { readonly kind: 'element'; readonly objectId: string; readonly element: string }

export interface RetrievalPair {
  readonly pack: string
  readonly query: SearchQuery
  readonly expect: ReadonlyArray<Expected>
  /** How the words name it: a label, part of one, a folded or Norwegian spelling, a qualified or id form, a category word, or mined words. */
  readonly form: 'label' | 'partial' | 'folded' | 'norwegian' | 'qualified' | 'id' | 'category' | 'quantity' | 'procedure-phrase' | 'agent-search'
  readonly source: string
  readonly review: 'AI-mined, pending review' | 'AI-drafted, pending review'
  /** Lead ruling R34's review, from the query text alone: out of the gate set, with the reason. */
  readonly removed?: string
  /** R34: the expectations the query names replace the mined ones, which raw recall still scores. */
  readonly rekeyed?: { readonly reason: string; readonly was: ReadonlyArray<Expected> }
}

/** One match as A4 returns it. */
export interface SearchMatch {
  readonly kind: 'observable' | 'element' | 'object'
  readonly ref?: string
  readonly objectId: string
  readonly label: string
  readonly pack: string
  readonly element?: { readonly id: string; readonly class: string }
  readonly tag?: string
  readonly quantity?: string
  readonly score: number
}
export interface SearchResult { readonly matches: ReadonlyArray<SearchMatch>; readonly refused?: { readonly code: string; readonly message: string } }

export const PACKS = ['process-plant', 'electric-grid', 'weather', 'einsatz', 'ambulance', 'drone'] as const
export const pairFile = (pack: string): string => new URL(`../../apps/world/tests/fixtures/retrieval/${pack}-pairs.json`, import.meta.url).pathname
export const loadPairs = async (): Promise<ReadonlyArray<RetrievalPair>> =>
  (await Promise.all(PACKS.map(async pack => (await Bun.file(pairFile(pack)).json() as { pairs: ReadonlyArray<RetrievalPair> }).pairs))).flat()

export const hits = (expected: Expected, match: SearchMatch): boolean => {
  if (expected.kind === 'ref') return match.kind === 'observable' && match.ref === expected.ref
  if (match.objectId !== expected.objectId) return false
  if (expected.kind === 'object') return match.kind === 'object'
  if (expected.kind === 'tag') return match.kind === 'observable' && match.tag === expected.tag
  return match.kind !== 'object' && match.element?.id === expected.element
}

/**
 * Recall@8 per pack and over the reviewed pairs (R34: the gate set, without removed pairs, with re-keyed expectations),
 * with every miss and what came back instead; raw recall scores every pair with its original expectations.
 */
export const scoreRecall = (pairs: ReadonlyArray<RetrievalPair>, results: ReadonlyArray<SearchResult>) => {
  const rankOf = (expect: ReadonlyArray<Expected>, result: SearchResult) => {
    const at = result.matches.slice(0, 8).findIndex(match => expect.some(expected => hits(expected, match)))
    return at < 0 ? null : at + 1
  }
  const raw = pairs.map((pair, index) => ({ pair, rank: rankOf(pair.rekeyed?.was ?? pair.expect, results[index]!), result: results[index]! }))
  const rows = pairs.flatMap((pair, index) => pair.removed === undefined ? [{ pair, rank: rankOf(pair.expect, results[index]!), result: results[index]! }] : [])
  const tally = (subset: typeof rows) => ({ pairs: subset.length, hits: subset.filter(row => row.rank !== null).length, recall: subset.length === 0 ? null : subset.filter(row => row.rank !== null).length / subset.length })
  const byPack = Object.fromEntries(PACKS.map(pack => [pack, tally(rows.filter(row => row.pair.pack === pack))]))
  const all = tally(rows)
  return {
    all,
    byPack,
    raw: { all: tally(raw), byPack: Object.fromEntries(PACKS.map(pack => [pack, tally(raw.filter(row => row.pair.pack === pack))])) },
    // T11: recall@8 ≥ 0.95 on ≥ 150 pairs, ≥ 20 per pack.
    pass: all.pairs >= 150 && (all.recall ?? 0) >= 0.95 && PACKS.every(pack => byPack[pack]!.pairs >= 20),
    misses: rows.filter(row => row.rank === null).map(({ pair, result }) => ({
      pack: pair.pack, query: pair.query, form: pair.form,
      ...(result.refused === undefined ? {} : { refused: result.refused.code }),
      got: result.matches.slice(0, 3).map(match => `${match.kind} ${match.ref ?? match.element?.id ?? match.objectId} "${match.label}"`),
    })),
  }
}

/** What exists in the Run the pairs are asked in, to find stale pairs before scoring. */
export interface Known {
  readonly objects: ReadonlySet<string>
  readonly elementExists: (objectId: string, element: string) => boolean
  readonly signalExists: (objectId: string, signalId: string) => boolean
  readonly tagExists: (objectId: string, tag: string) => boolean
}

/** The object a pair's expectation is about (a ref's part before '#'). */
const subjectOf = (expected: Expected): string => expected.kind === 'ref' ? expected.ref.split('#')[0]! : expected.objectId

/** The expectations no Run object, element or signal answers: a corpus defect, fixed before any score. */
export const stalePairs = (pairs: ReadonlyArray<RetrievalPair>, known: Known) => pairs.flatMap(pair => {
  const stale = pair.expect.filter(expected => !known.objects.has(subjectOf(expected))
    || (expected.kind === 'ref' && !known.signalExists(subjectOf(expected), expected.ref.slice(expected.ref.indexOf('#') + 1)))
    || (expected.kind === 'tag' && !known.tagExists(expected.objectId, expected.tag))
    || (expected.kind === 'element' && !known.elementExists(expected.objectId, expected.element)))
  return stale.length === 0 ? [] : [{ query: pair.query.text, stale }]
})

/**
 * Signal ids as the packs declare them (R23): a plant's variable path (every Halden unit runs the reference plant), a
 * weather quantity id, a grid `<assetId>.<quantity>` on an existing asset or a grid-wide `grid.<name>`; and plant I&C tags.
 */
export const signalCatalog = (weatherQuantityIds: ReadonlyArray<string>, gridAssetExists: (assetId: string) => boolean = () => true) => {
  const plant = referencePlantCatalog()
  const gridSignal = (signalId: string): boolean => /^grid\.[a-z-]+$/i.test(signalId)
    || (/^(.+)\.(loading|flow|voltage|energized|state|dispatch|served|exchange)$/.exec(signalId)?.slice(1, 2).every(gridAssetExists) ?? false)
  return {
    signalExists: (objectId: string, signalId: string): boolean => objectId.startsWith('plant:') ? plant.signal(signalId)?.path === signalId
      : objectId.startsWith('weather') ? weatherQuantityIds.includes(signalId)
        : objectId.startsWith('grid:') ? gridSignal(signalId) : false,
    tagExists: (objectId: string, tag: string): boolean => objectId.startsWith('plant:') && plant.signal(tag)?.tagId === tag,
  }
}

if (import.meta.main) {
  const [directory, ...rest] = Bun.argv.slice(2)
  if (!directory || !isAbsolute(directory)) throw new Error('Usage: LEITBILD_PROBE_ORIGIN=http://127.0.0.1:<port> bun scripts/display-eval/retrieval.ts <absolute-output-dir> [--seconds=240]')
  const seconds = Number(rest.find(argument => argument.startsWith('--seconds='))?.slice(10) ?? 240)
  const origin = process.env.LEITBILD_PROBE_ORIGIN
  if (origin === undefined || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('LEITBILD_PROBE_ORIGIN must be a loopback local stack')
  const request = async (path: string, body?: unknown): Promise<any> => {
    const response = await fetch(origin + path, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 400)}`)
    return JSON.parse(text)
  }
  const actor = { kind: 'human', id: 'retrieval-eval', displayName: 'Retrieval evaluation' }
  const invoke = (workspaceId: string, operationId: string, input: unknown, target: Record<string, unknown> = {}) =>
    request(`/api/workspaces/${workspaceId}/capabilities/${operationId}/invoke`, { ...target, input, actor })
  await mkdir(directory, { recursive: true })
  const source = await Bun.file(fixturePath('fixture:integrated-all-packs')!).json()
  const { workspace } = await request('/api/workspaces', { name: 'Retrieval evaluation (local)' })
  await invoke(workspace.id, 'world.scenario.create', { source })
  const { definitions } = await request(`/api/workspaces/${workspace.id}/definitions`)
  const definition = definitions.find((entry: { ref: { id: string } }) => entry.ref.id === source.id)
  const launched = await invoke(workspace.id, 'world.scenario.start', {}, { definition: { ...definition.ref, revisionId: definition.currentRevisionId } })
  const resource = launched.createdResources?.find((entry: { type: string }) => entry.type === 'world.simulation-run') ?? launched.result?.resource
  await invoke(workspace.id, 'world.simulation-run.execution.set', { playback: 'paused' }, { resource })
  const presence = async () => (await request(`/api/workspaces/${workspace.id}/world/simulation-runs/${encodeURIComponent(resource.id)}/presence`)).execution
  const target = Date.parse((await presence()).currentSimulationTime) + seconds * 1_000
  await invoke(workspace.id, 'world.simulation-run.execution.advance', { minutes: seconds / 60, onComplete: 'pause' }, { resource })
  for (let waited = 0; ; waited += 2_000) { // patience, not a product limit
    const execution = await presence()
    if (execution.playback === 'paused' && Date.parse(execution.currentSimulationTime) >= target) break
    if (waited > 300_000) throw new Error('The Run did not reach its time within the deadline')
    await Bun.sleep(2_000)
  }
  const { objects } = await request(`/api/workspaces/${workspace.id}/world/simulation-runs/${encodeURIComponent(resource.id)}/objects`)
  const { weatherQuantities } = await import('../../apps/world/src/packs/weather/quantities.ts')
  const pairs = await loadPairs()
  // The grid assets the corpus names, as elements or inside its own refs, each asked of this Run's Grid.
  const assets = [...new Set(pairs.flatMap(pair => pair.expect.flatMap(expected => expected.kind === 'element' ? [expected.element]
    : expected.kind === 'ref' && expected.ref.startsWith('grid:') ? [/#(.+)\.[a-z]+$/.exec(expected.ref)?.[1]].filter(id => id !== undefined && !id.startsWith('grid')) as string[] : [])))]
  const missing = new Set<string>()
  for (const assetId of assets) await invoke(workspace.id, 'world.electric-grid.asset.get', { gridId: 'grid:halden-four-unit', assetId }, { resource }).catch(() => missing.add(assetId))
  const known: Known = {
    objects: new Set((objects as ReadonlyArray<{ id: string }>).map(object => object.id)),
    ...signalCatalog(weatherQuantities.map(quantity => quantity.id), assetId => !missing.has(assetId)),
    elementExists: (_objectId, element) => !missing.has(element),
  }
  const stale = stalePairs(pairs, known)
  if (stale.length > 0) {
    await Bun.write(join(directory, 'stale-pairs.json'), JSON.stringify(stale, null, 2))
    throw new Error(`${stale.length} pairs name what this Run does not hold; see stale-pairs.json`)
  }
  const results: SearchResult[] = []
  for (let start = 0; start < pairs.length; start += 8) {
    const batch = pairs.slice(start, start + 8)
    const { result } = await invoke(workspace.id, 'world.simulation-run.observables.search', { queries: batch.map(pair => pair.query) }, { resource })
    for (const [index] of batch.entries()) {
      const answer = (result.results as ReadonlyArray<{ query: number; matches: ReadonlyArray<SearchMatch>; refused?: { code: string; message: string } }>).find(entry => entry.query === index)
      results.push({ matches: answer?.matches ?? [], ...(answer?.refused === undefined ? {} : { refused: answer.refused }) })
    }
  }
  const scored = scoreRecall(pairs, results)
  await Bun.write(join(directory, 'retrieval-results.json'), JSON.stringify({ origin, seconds, runId: resource.id, results }, null, 2))
  await Bun.write(join(directory, 'retrieval-summary.json'), JSON.stringify(scored, null, 2))
  console.log(JSON.stringify({ all: scored.all, byPack: scored.byPack, pass: scored.pass, misses: scored.misses.length, raw: scored.raw }, null, 2))
}
