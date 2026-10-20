/** Mines retrieval pairs (a person's or agent's words → the signal they mean)
 * for T11's observables.search recall (plan v3.1 Appendix F: recall@8 ≥ 0.95
 * on ≥ 150 pairs). Two sources:
 *
 * - procedure phrases: the knowledge snapshot's procedures name each tag
 *   after the words for it ("neutron flux «NIS-PR-AVG»"); the words before a
 *   «tag» up to a clause boundary are the query, the tag's signal the answer;
 * - agent searches: in recorded probe stages, each signals.search query an
 *   agent sent, paired with the signals it then composed that the search
 *   returned (an agent's own words for what it went on to show).
 *
 *   bun scripts/display-eval/mine-retrieval-pairs.ts <knowledge snapshot.json> <out.json> [<stage-dir>:<stage> ...]
 *
 * Only signals the reference Plant has are kept; a tag it lacks is counted,
 * not paired. Pairs are written in retrieval.ts's shape, scoped to Unit 2,
 * where they were mined; the plant's pair file holds these and, after them,
 * the hand-drafted pairs qualified by unit. */
import { join } from 'node:path'
import { compileProcessPlant, createPwrReferencePlantDefinition, signalMeasuredOn } from '../../apps/world/src/packs/process-plant/index.ts'
import type { RetrievalPair } from './retrieval.ts'

interface MinedPair {
  readonly pack: 'process-plant'
  readonly query: string
  readonly expect: { readonly path: string; readonly tagId?: string; readonly component: string }
  readonly source: string
  readonly kind: 'procedure-phrase' | 'agent-search'
  readonly review: 'AI-mined, pending review'
}

const { graph } = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:halden-2', loopCount: 4 }))
const resolve = (name: string) => {
  const binding = graph.signalBindingByTagId.get(name as never) ?? graph.signalBindingByExternalRef.get(name as never) ?? graph.signalBindingByPath.get(name as never)
  return binding === undefined ? undefined : {
    path: String(binding.path),
    ...(binding.tagId === undefined ? {} : { tagId: String(binding.tagId) }),
    component: String(signalMeasuredOn(graph, binding.owner).id),
  }
}

// Words that end the phrase naming a tag, read backwards from the «tag».
const BOUNDARY = /(?:[.:;,()\[\]→]|\bAND\b|\bOR\b|\band\b|\bor\b|\bif\b|\bwith\b|\bfrom\b|\bto\b|\bat\b|\bon\b|»|—|-{2,}|\/)/
const FILLER = /^(?:the|a|an|its|each|any|all|both|check|verify|confirm|monitor|read|observe|record|compare|is|are|reads?|of)$/i
const TRAILING = /^(?:using|via|by|in|for|of|the|per|as|against|indicated|shown|reading|value)$/i

/** The words naming each «tag» in a procedure text. */
export const procedurePhrases = (text: string): ReadonlyArray<{ readonly tag: string; readonly phrase: string }> => {
  const found: Array<{ tag: string; phrase: string }> = []
  for (const line of text.split('\n')) {
    let previous: { readonly end: number; readonly phrase: string } | null = null
    for (const match of line.matchAll(/«([A-Z0-9][A-Z0-9-]+)»/g)) {
      // A tag listed after another ("«TRIP-BKR-A» AND «TRIP-BKR-B»", "«BUS-A» / «BUS-B»") shares its words.
      const between = previous === null ? null : line.slice(previous.end, match.index)
      if (previous !== null && between !== null && /^(?:\s|,|\/|AND|OR|and|or)*$/.test(between)) {
        found.push({ tag: match[1]!, phrase: previous.phrase })
        previous = { end: match.index! + match[0].length, phrase: previous.phrase }
        continue
      }
      const before = line.slice(0, match.index)
      const words = before.split(/\s+/).filter(Boolean)
      const kept: string[] = []
      for (let index = words.length - 1; index >= 0 && kept.length < 6; index -= 1) {
        const word = words[index]!
        if (BOUNDARY.test(word)) {
          const tail = word.split(BOUNDARY).at(-1)?.trim()
          if (tail) kept.unshift(tail)
          break
        }
        kept.unshift(word)
      }
      while (kept.length > 0 && FILLER.test(kept[0]!)) kept.shift()
      while (kept.length > 0 && TRAILING.test(kept.at(-1)!)) kept.pop()
      const phrase = kept.join(' ').replace(/[*_`"]/g, '').replace(/^[^A-Za-z]+/, '').trim()
      // A phrase that names another tag-like token (Tcold before a hot-leg tag) is ambiguous: left out.
      // A lone lower-case word ("lowest", "turbine-driven") names no signal on its own.
      const lone = !phrase.includes(' ') && phrase === phrase.toLowerCase()
      const usable = phrase.length >= 4 && /[a-z]/.test(phrase) && !lone && !/\b[A-Z]{2,}-[A-Z0-9]/.test(phrase)
      if (usable) found.push({ tag: match[1]!, phrase })
      previous = usable ? { end: match.index! + match[0].length, phrase } : null
    }
  }
  return found
}

if (import.meta.main) {
  const [snapshotPath, outPath, ...stages] = Bun.argv.slice(2)
  if (!snapshotPath || !outPath) throw new Error('Usage: mine-retrieval-pairs.ts <knowledge snapshot.json> <out.json> [<stage-dir>:<stage> ...]')
  const snapshot = await Bun.file(snapshotPath).json() as { readonly revision: string; readonly documents: ReadonlyArray<{ readonly path: string; readonly content: string }> }
  const pairs = new Map<string, MinedPair>()
  const missing = new Map<string, number>()
  const add = (pair: MinedPair) => { const key = `${pair.query.toLowerCase()}→${pair.expect.path}`; if (!pairs.has(key)) pairs.set(key, pair) }
  for (const document of snapshot.documents.filter(entry => /procedures\//.test(entry.path))) {
    for (const { tag, phrase } of procedurePhrases(document.content)) {
      const signal = resolve(tag)
      if (signal === undefined) { missing.set(tag, (missing.get(tag) ?? 0) + 1); continue }
      add({ pack: 'process-plant', query: phrase, expect: signal, source: `wiki@${snapshot.revision.slice(0, 7)}:${document.path}`, kind: 'procedure-phrase', review: 'AI-mined, pending review' })
    }
  }
  // Agent searches in recorded stages: the probe saved each turn's compose records; the stage's own search calls come
  // from the transcripts' generation evidence, which the probe does not keep, so they are read from <stage>-searches.json
  // (written by collect-searches.ts) when present.
  for (const entry of stages) {
    const [directory, stage] = entry.split(':')
    if (!directory || !stage) throw new Error(`Stage must be <dir>:<stage>, got ${entry}`)
    const file = Bun.file(join(directory, `${stage}-searches.json`))
    if (!await file.exists()) throw new Error(`${file.name} is missing: run collect-searches.ts for that stage first`)
    for (const turn of await file.json() as ReadonlyArray<{ readonly scenario: string; readonly searches: ReadonlyArray<{ readonly query: string; readonly returned: ReadonlyArray<string> }>; readonly composed: ReadonlyArray<string> }>) {
      for (const search of turn.searches) {
        for (const name of turn.composed.filter(composed => search.returned.includes(composed))) {
          const signal = resolve(name)
          if (signal !== undefined && search.query.trim().length >= 3) add({ pack: 'process-plant', query: search.query.trim(), expect: signal, source: `${stage}:${turn.scenario}`, kind: 'agent-search', review: 'AI-mined, pending review' })
        }
      }
    }
  }
  const list = [...pairs.values()]
  const shaped = list.map((pair): RetrievalPair => ({
    pack: 'process-plant', query: { text: pair.query, objectId: 'plant:halden-2' },
    expect: [pair.expect.path, ...(pair.expect.tagId === undefined ? [] : [pair.expect.tagId])].map(signal => ({ kind: 'signal' as const, objectId: 'plant:halden-2', signal })),
    form: pair.kind, source: pair.source, review: pair.review,
  }))
  await Bun.write(outPath, JSON.stringify({
    about: 'Mined T11 retrieval pairs for the process plant, scoped to Unit 2 (retrieval.ts shape).',
    pairs: shaped,
    tagsTheModelLacks: Object.fromEntries([...missing].sort((left, right) => right[1] - left[1])),
  }, null, 1) + '\n')
  const byKind = list.reduce<Record<string, number>>((tally, pair) => ({ ...tally, [pair.kind]: (tally[pair.kind] ?? 0) + 1 }), {})
  console.log(JSON.stringify({ pairs: list.length, byKind, distinctSignals: new Set(list.map(pair => pair.expect.path)).size, tagsTheModelLacks: missing.size }))
}
