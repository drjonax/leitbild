/** T10 citation replay (plan v3.1 Appendix F; lead ruling R9): the model
 * answers from cards built from P1's real observation reads on frozen Runs
 * (cards.ts), one card, two re-keyed cards in one namespace, or a card of
 * states with their `since`, in English and Norwegian. Then the guard as
 * specified: a number next to a key must match one of that item's numbers at
 * its typed precision. Measured: exact ⟦k⟧ tokens ≥ 95 %, key use ≥ 90 %
 * (displayed values retyped with their key), contradictions (upper bound
 * ≤ 2 %), guard false positives ≤ 1 % (every flag is hand-checked).
 *
 *   OPENROUTER_API_KEY=… bun scripts/display-eval/citations.ts <absolute-out-dir> --budget=<USD> [--runs=<id,…>]
 */
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { FROZEN_SPECS, freezeRun, type FrozenRun } from './frozen-runs.ts'
import { buildCard, cardLimits, cardText, type Card } from './cards.ts'
import { chat, createLedger, type ChatMessage, type Ledger } from './openrouter.ts'
import { REPLAY_SKILL, REPLAY_TOOLS } from './replay.ts'
import { wilson } from './stats.ts'

// ---- the guard and the citation measures (pure) ----

const EXACT = /⟦k(\d+)⟧/g
// Key-like marks that are not the exact token.
const MALFORMED = /\[\[?k\d+\]?\]|\(k\d+\)|⟦\s+k\d+|k\d+\s+⟧|⟦K\d+⟧|【k\d+】|\{k\d+\}|⟦k\d+(?:\s*[,;]\s*k?\d+)+⟧|⟦k\d+\s*[–—-]\s*k?\d+⟧/g
// Clock times, dates, refs and ids are no values: masked before numbers are read.
const TIMES = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b|\b\d{1,2}:\d{2}(?::\d{2})?\b|[\w.@-]+:[\w.@:-]+(?:#[\w.@:-]+)?/g
// A number may carry its unit ("15.5MPa"); a letter or digit before it makes it part of a word. Thousands are grouped
// by commas in English ("2,291") and by spaces in Norwegian ("2 291"), whose decimal mark is the comma ("15,5").
const NUMBER = {
  en: /(?<![\p{L}\d.,])[-−]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d:,])|(?<![\p{L}\d.,])[-−]?\d+(?:\.\d+)?(?![\d:])/gu,
  nb: /(?<![\p{L}\d.,])[-−]?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:,\d+)?(?![\d:])|(?<![\p{L}\d.,])[-−]?\d+(?:[.,]\d+)?(?![\d:])/gu,
} as const

interface Found { readonly text: string; readonly value: number; readonly decimals: number; readonly index: number }
const numbersIn = (answer: string, language: 'en' | 'nb'): ReadonlyArray<Found> => {
  const masked = answer.replace(TIMES, match => ' '.repeat(match.length)).replace(EXACT, match => ' '.repeat(match.length))
  return [...masked.matchAll(NUMBER[language])].map(match => {
    const plain = match[0].replace('−', '-')
    const text = language === 'en' ? plain.replaceAll(',', '') : plain.replace(/[ \u00a0\u202f]/g, '').replace(',', '.')
    return { text: match[0], value: Number(text), decimals: text.includes('.') ? text.split('.')[1]!.length : 0, index: match.index! }
  })
}

/** Whether a number shown with `decimals` decimals is one of the item's numbers rounded to them (never more digits than the item shows). */
const matchesItem = (found: Found, numbers: Card['items'][number]['numbers']) => numbers.some(number =>
  found.decimals <= number.decimals && Math.abs(found.value - number.value) <= 0.5 * 10 ** -found.decimals + 1e-9)

export interface CitationScore {
  readonly exact: number
  readonly malformed: number
  readonly unknownKeys: ReadonlyArray<string>
  /** Numbers the answer shows that equal a value on the cards. */
  readonly displayedNumbers: number
  /** Of those, the ones with a key right after them. */
  readonly keyedDisplayed: number
  /** Numbers right before a key. */
  readonly keyedNumbers: number
  readonly flagged: ReadonlyArray<{ readonly key: string; readonly number: string; readonly item: string; readonly at: string }>
  /** Guard v2 revision 2 (R40; spec sha 9601acb4…, $SP/p1/eval/guard-v2/spec.md): cited numbers, and its flags. */
  readonly v2: { readonly cited: number; readonly namesSkipped: number; readonly flagged: ReadonlyArray<{ readonly keys: ReadonlyArray<string>; readonly number: string; readonly at: string }> }
}

// Rule 6a: a number after a naming word, directly or through a list of named numbers ("Units 1 and 2"), names a part.
const NAMING = /\b(?:unit|units|enhet|enheter|enhetene|blokk|blokkene|reaktor|loop|sg|circuit|krets|train|pump|halden)[\s-]*(?:\d+\s*(?:,|and|og|&)\s*)*$/i
// Rule 5: limit words; a number within three words after one may match a threshold.
const LIMIT = /\b(?:limit|limits|rating|rated|threshold|setpoint|trip|alarm|above|below|over|under|exceeds?|grense|grensen|grenseverdi\w*|merkeverdi\w*|alarmgrense\w*)\b(?:\W+\S+){0,3}\W*$/i
// Rule 1: a key group, exact keys only (a range ⟦k1–k8⟧ is none).
const GROUP = /⟦k\d+⟧(?:\s*(?:,|and|og|\/)?\s*⟦k\d+⟧)*/g
// Clauses end at ; ! ? a line break, or a full stop that is not a decimal point.
const CLAUSE_END = /[;!?\n]|\.(?!\d)/g

/** Guard v2 (R40): key groups, any key of the group, ranges by both ends, limits after a limit word, names skipped. */
const guardV2 = (answer: string, numbers: ReadonlyArray<Found>, items: ReadonlyMap<string, Card['items'][number]>, limits: ReadonlyMap<string, Card['items'][number]['numbers']>): CitationScore['v2'] => {
  const ends = [...answer.matchAll(CLAUSE_END)].map(match => match.index!)
  const clauseEnd = (index: number) => ends.find(end => end >= index) ?? answer.length
  const groups = [...answer.matchAll(GROUP)].map(match => ({ index: match.index!, keys: [...match[0].matchAll(/⟦k(\d+)⟧/g)].map(key => `k${key[1]}`) }))
  let namesSkipped = 0
  const labels = [...items.values()].map(item => item.label.toLowerCase())
  // Rule 6b: the number with the word after it, or in parentheses, as a card label writes it.
  const inLabel = (found: Found): boolean => {
    const after = /^\s*([\p{L}\d]+)/u.exec(answer.slice(found.index + found.text.length))?.[1]!.toLowerCase() ?? ''
    const parenthesised = answer[found.index - 1] === '(' && answer[found.index + found.text.length] === ')'
    return labels.some(label => (after !== '' && label.includes(`${found.text.toLowerCase()} ${after}`)) || (parenthesised && label.includes(`(${found.text})`)))
  }
  const cited: Array<{ readonly ends: ReadonlyArray<Found>; readonly keys: ReadonlyArray<string> }> = []
  for (let index = 0; index < numbers.length; index++) {
    const found = numbers[index]!
    if (NAMING.test(answer.slice(Math.max(0, found.index - 30), found.index)) || inLabel(found)) { namesSkipped += 1; continue }
    // Rule 4: "a–b", "a - b", "a to b", "a til b" is one cited number with two ends.
    const next = numbers[index + 1]
    const between = next === undefined ? '' : answer.slice(found.index + found.text.length, next.index)
    const range = next !== undefined && /^\s*(?:%\s*)?(?:[–—-]|to|til)\s*$/.test(between)
    const last = range ? next! : found
    const group = groups.find(entry => entry.index > last.index && entry.index <= clauseEnd(last.index + last.text.length))
    if (range) index += 1
    if (group === undefined) continue
    cited.push({ ends: range ? [found, next!] : [found], keys: group.keys.filter(key => items.has(key)) })
  }
  const holds = (found: Found, keys: ReadonlyArray<string>) => keys.some(key => matchesItem(found, items.get(key)!.numbers))
    || (LIMIT.test(answer.slice(Math.max(0, found.index - 60), found.index)) && keys.some(key => matchesItem(found, limits.get(key) ?? [])))
  const flagged = cited.filter(entry => entry.keys.some(key => items.get(key)!.numbers.length > 0 || (limits.get(key) ?? []).length > 0) && !entry.ends.every(found => holds(found, entry.keys)))
    .map(entry => ({ keys: entry.keys, number: entry.ends.map(found => found.text).join('–'), at: answer.slice(Math.max(0, entry.ends[0]!.index - 40), entry.ends[0]!.index + 50) }))
  return { cited: cited.length, namesSkipped, flagged }
}

/** Scores one answer against the cards it was given. */
export const scoreCitations = (answer: string, cards: ReadonlyArray<Card>, language: 'en' | 'nb' = 'en', limits: ReadonlyMap<string, Card['items'][number]['numbers']> = new Map()): CitationScore => {
  const items = new Map(cards.flatMap(card => card.items).map(item => [item.key, item]))
  const exact = [...answer.matchAll(EXACT)]
  const unknownKeys = exact.map(match => `k${match[1]}`).filter(key => !items.has(key))
  const numbers = numbersIn(answer, language)
  // The number next to a key: the nearest number before it in the same clause, with no other key between.
  const clusterAfter = (found: Found): ReadonlyArray<string> => {
    const rest = answer.slice(found.index + found.text.length)
    const match = /^[^.;!?\n⟦]{0,30}?((?:⟦k\d+⟧\s*)+)/u.exec(rest)
    return match === null ? [] : [...match[1]!.matchAll(/⟦k(\d+)⟧/g)].map(key => `k${key[1]}`)
  }
  const keyAfter = (found: Found): string | null => clusterAfter(found)[0] ?? null
  const allNumbers = [...items.values()].flatMap(item => item.numbers)
  const displayed = numbers.filter(found => matchesItem(found, allNumbers))
  const keyed = numbers.flatMap(found => { const key = keyAfter(found); return key === null ? [] : [{ found, key }] })
  const flagged = keyed.filter(({ found, key }) => {
    const item = items.get(key)
    return item !== undefined && item.numbers.length > 0 && !matchesItem(found, item.numbers)
  }).map(({ found, key }) => ({ key, number: found.text, item: items.get(key)!.reading, at: answer.slice(Math.max(0, found.index - 40), found.index + 40) }))
  return {
    v2: guardV2(answer, numbers, items, limits),
    exact: exact.length,
    malformed: [...answer.matchAll(MALFORMED)].length,
    unknownKeys,
    displayedNumbers: displayed.length,
    keyedDisplayed: displayed.filter(found => keyAfter(found) !== null).length,
    keyedNumbers: keyed.length,
    flagged,
  }
}

// ---- cases ----

export interface CitationCase { readonly kind: 'single' | 'multi' | 'since'; readonly language: 'en' | 'nb'; readonly question: string }
export const CITATION_CASES: ReadonlyArray<CitationCase> = [
  { kind: 'single', language: 'en', question: 'What does this display tell me? Cite every value you use.' },
  { kind: 'single', language: 'en', question: 'Is anything here outside its normal range?' },
  { kind: 'single', language: 'en', question: 'Which value here matters most right now, and why?' },
  { kind: 'single', language: 'en', question: 'Give me the three most important readings.' },
  { kind: 'multi', language: 'en', question: 'Compare these two displays: what stands out?' },
  { kind: 'multi', language: 'en', question: 'How do the two relate right now?' },
  { kind: 'multi', language: 'en', question: 'Summarise both displays in two sentences, with their values.' },
  { kind: 'multi', language: 'en', question: 'Which of the two needs attention first?' },
  { kind: 'since', language: 'en', question: 'Since when has each of these states held?' },
  { kind: 'since', language: 'en', question: 'What changed most recently here?' },
  { kind: 'since', language: 'en', question: 'Which state has held longest, and what does it read?' },
  { kind: 'single', language: 'nb', question: 'Hva forteller dette displayet meg? Oppgi verdiene du bruker.' },
  { kind: 'multi', language: 'nb', question: 'Sammenlign de to displayene: hva skiller seg ut?' },
  { kind: 'since', language: 'nb', question: 'Siden når har disse tilstandene vart?' },
]

/** Round 2 (R40): fresh questions that ask for values, seeds per case, two-card cases only on Runs with two assets. */
export const CITATION_CASES_R2: ReadonlyArray<CitationCase> = [
  { kind: 'single', language: 'en', question: 'Report the readings that matter most, each with its value.' },
  { kind: 'single', language: 'en', question: 'Which readings are furthest from normal, and by how much?' },
  { kind: 'single', language: 'en', question: 'Summarise this display in three sentences, quoting the values.' },
  { kind: 'single', language: 'en', question: 'What would you tell the next shift about these values?' },
  { kind: 'single', language: 'en', question: 'List every reading that is above or below its limit, with the limit.' },
  { kind: 'single', language: 'en', question: 'Give me the values a supervisor needs from this display.' },
  { kind: 'single', language: 'nb', question: 'Hvilke verdier er viktigst her? Oppgi verdiene.' },
  { kind: 'single', language: 'nb', question: 'Er noen av verdiene over eller under grensene sine?' },
  { kind: 'multi', language: 'en', question: 'Compare the two displays value by value.' },
  { kind: 'multi', language: 'en', question: 'Which display shows the more serious state? Quote the values.' },
  { kind: 'multi', language: 'en', question: 'What is the same and what differs between the two displays?' },
  { kind: 'multi', language: 'en', question: 'Give the two most important values from each display.' },
  { kind: 'multi', language: 'nb', question: 'Sammenlign de to displayene verdi for verdi.' },
  { kind: 'since', language: 'en', question: 'When did each state change, and what is it now?' },
  { kind: 'since', language: 'en', question: 'Which state changed last?' },
  { kind: 'since', language: 'nb', question: 'Når endret tilstandene seg, og hva er de nå?' },
]

/** The Runs with observation content (plant, grid or weather): T10 needs numbers on its cards. */
export const CITATION_RUNS = ['halden-normal-operation', 'halden-offsite-power-restoration', 'halden-power-complex', 'halden-weather-response', 'nordic-frequency-event', 'nordland-corridor-security', 'rogaland-black-start', 'integrated-all-packs']

/** The cards of one frozen Run: the first two observed assets' lead values, and states with their `since`. */
export const cardsOf = async (frozen: FrozenRun) => {
  const assets = frozen.context.text.split('\n').filter(line => / · lead: /.test(line)).map(line => line.slice(2).split(' · ')[0]!)
  const leadOf = async (objectId: string) => [...(await frozen.searchRun.port.read({ lead: { objectId: objectId as never, count: 8 } })).observations].map(observation => observation.ref)
  const first = assets[0]!
  // The second card: an asset of another pack where there is one, else the next asset; a Run with one asset has none.
  const packOf = (objectId: string) => frozen.searchRun.objects.find(object => object.id === objectId)?.packId
  const second = assets.find(objectId => objectId !== first && packOf(objectId) !== packOf(first)) ?? assets.find(objectId => objectId !== first) ?? null
  const single = await buildCard(frozen.searchRun, await leadOf(first), 1)
  const other = second === null ? null : await buildCard(frozen.searchRun, await leadOf(second), single.items.length + 1)
  // States with a `since`: the declared observables of the assets, in context order, whose read carries one, up to 6.
  const withSince: string[] = []
  for (const objectId of assets) {
    const [declaration] = await frozen.searchRun.port.declarations([objectId as never])
    const refs = declaration !== undefined && !('refused' in declaration) ? declaration.observables.map(observable => observable.ref) : []
    for (let start = 0; start < refs.length && withSince.length < 6; start += 64) {
      for (const observation of (await frozen.searchRun.port.read({ refs: refs.slice(start, start + 64) })).observations) if (observation.since !== undefined && withSince.length < 6) withSince.push(observation.ref)
    }
    if (withSince.length >= 6) break
  }
  const since = withSince.length === 0 ? null : await buildCard(frozen.searchRun, withSince, 1)
  return { single, multi: other === null ? null : [single, other] as const, since }
}

export const citationCase = async (frozen: FrozenRun, cards: ReadonlyArray<Card>, question: string, language: 'en' | 'nb', ledger: Ledger, seed?: number) => {
  const messages: ChatMessage[] = [{ role: 'system', content: REPLAY_SKILL }, { role: 'user', content: question }]
  cards.forEach((card, index) => {
    const id = `call_card_${index + 1}`
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'display_compose', arguments: JSON.stringify({ title: `Display ${index + 1}`, subjects: [card.items[0]?.subject && 'ref' in card.items[0].subject ? card.items[0].subject.ref.split('#')[0] : 'run'] }) } }] })
    messages.push({ role: 'tool', tool_call_id: id, content: cardText(card) })
  })
  const result = await chat(ledger, messages, REPLAY_TOOLS, 4_000, 'none', seed)
  const answer = result.message.content ?? ''
  const limits = new Map((await Promise.all(cards.map(card => cardLimits(frozen.searchRun, card)))).flatMap(map => [...map]))
  return { answer, costUsd: result.costUsd, score: scoreCitations(answer, cards, language, limits), limits: Object.fromEntries(limits) }
}

export const summariseCitations = (rows: ReadonlyArray<{ readonly score: CitationScore }>) => {
  const sum = (pick: (score: CitationScore) => number) => rows.reduce((total, row) => total + pick(row.score), 0)
  const flagged = sum(score => score.flagged.length)
  return {
    answers: rows.length,
    exactToken: wilson(sum(score => score.exact), sum(score => score.exact + score.malformed)),
    keyUse: wilson(sum(score => score.keyedDisplayed), sum(score => score.displayedNumbers)),
    flaggedByGuard: wilson(flagged, sum(score => score.keyedNumbers)),
    v2Cited: sum(score => score.v2.cited),
    flaggedByGuardV2: wilson(sum(score => score.v2.flagged.length), sum(score => score.v2.cited)),
    namesSkippedV2: sum(score => score.v2.namesSkipped),
    unknownKeys: sum(score => score.unknownKeys.length),
  }
}

if (import.meta.main) {
  const [directory, ...rest] = Bun.argv.slice(2)
  const option = (name: string) => rest.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
  const budget = Number(option('budget'))
  if (!directory || !isAbsolute(directory) || !(budget > 0)) throw new Error('Usage: citations.ts <absolute-out-dir> --budget=<USD> [--runs=<id,…>]')
  const runs = option('runs')?.split(',') ?? CITATION_RUNS
  // Round 2 (R40): its own questions, a seed per case, and a second pass of the single and two-card questions (seed
  // + 1000) only if the first leaves fewer than 200 cited numbers (pre-registered).
  const round = Number(option('round') ?? 1)
  const cases = round === 2 ? CITATION_CASES_R2 : CITATION_CASES
  const ledger = createLedger(budget)
  await mkdir(join(directory, 'data'), { recursive: true })
  const rows: Array<Record<string, any>> = []
  const citedSoFar = () => rows.reduce((sum, row) => sum + (row.score?.v2.cited ?? 0), 0)
  for (const pass of round === 2 ? [0, 1] : [0]) {
    if (pass === 1 && citedSoFar() >= 200) break
    for (const spec of FROZEN_SPECS.filter(entry => runs.includes(entry.id))) {
    const frozen = await freezeRun(spec, join(directory, 'data'))
    try {
      const cards = await cardsOf(frozen)
      for (const [index, testCase] of cases.entries()) {
        if (pass === 1 && testCase.kind === 'since') continue
        const given = testCase.kind === 'single' ? [cards.single] : testCase.kind === 'multi' ? (cards.multi === null ? null : [...cards.multi]) : cards.since === null ? null : [cards.since]
        if (given === null) { rows.push({ run: spec.id, case: index, pass, ...testCase, skipped: testCase.kind === 'multi' ? 'one asset in this Run' : 'no observed state with a since in this Run' }); continue }
        const seed = round === 2 ? 40_000 + pass * 1_000 + FROZEN_SPECS.indexOf(spec) * 50 + index : undefined
        const result = await citationCase(frozen, given, testCase.question, testCase.language, ledger, seed)
        rows.push({ run: spec.id, case: index, pass, seed, ...testCase, ...result, cards: given })
        console.log(JSON.stringify({ run: spec.id, case: index, kind: testCase.kind, language: testCase.language, exact: result.score.exact, malformed: result.score.malformed, flagged: result.score.flagged.length, keyed: `${result.score.keyedDisplayed}/${result.score.displayedNumbers}`, costUsd: result.costUsd }))
        await Bun.write(join(directory, 't10-rows.jsonl'), rows.map(entry => JSON.stringify(entry)).join('\n') + '\n')
      }
    } finally { await frozen.close() }
    }
  }
  const scored = rows.filter(row => row.score !== undefined) as Array<{ score: CitationScore; kind: string; language: string }>
  const summary = {
    t10: summariseCitations(scored),
    byKind: Object.fromEntries(['single', 'multi', 'since'].map(kind => [kind, summariseCitations(scored.filter(row => row.kind === kind))])),
    norwegian: summariseCitations(scored.filter(row => row.language === 'nb')),
    skipped: rows.filter(row => row.skipped !== undefined).length,
    ledger: { calls: ledger.calls, costUsd: ledger.spentUsd },
  }
  await Bun.write(join(directory, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
}
