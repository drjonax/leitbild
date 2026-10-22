/** T10 on the production path (P2 E1): the model answers from the cards World's composer returns (composeDefault, as
 * the AI caller, on the frozen Runs), read as the Agents read them (re-keyed per turn, one line per item), under the
 * shipped operator-displays skill as Agents injects it; the shipped guard (apps/agents citations.ts) checks every
 * answer. Measured as in T10: exact ⟦k⟧ tokens, key use, the production guard's flags against its cited numbers
 * (hand-checked), contradictions.
 *
 *   OPENROUTER_API_KEY=… bun scripts/display-eval/t10-production.ts <absolute-out-dir> --budget=<USD> [--runs=<id,…>] [--dry]
 *
 * --dry builds the cards and prints the contexts and card lines without calling a model. */
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { composeDefault } from '../../apps/world/src/features/displays/compose/compose.ts'
import { cardLines, createTurnCards } from '../../apps/agents/src/agents/answer-cards.ts'
import { citationIssues, readingFlags } from '../../apps/agents/src/agents/citations.ts'
import { createSkillStore, loadSkills } from '../../apps/agents/src/skills/loader.ts'
import { createToolRegistry } from '../../apps/agents/src/core/tool-registry.ts'
import type { DisplayCard } from '../../packages/contracts/src/index.ts'
import { FROZEN_SPECS, freezeRun, type FrozenRun } from './frozen-runs.ts'
import { productionReading, scoreCitations, type CitationCase } from './citations.ts'
import { chat, createLedger, type ChatMessage, type ChatTool } from './openrouter.ts'
import { wilson } from './stats.ts'

/** Fresh questions for E1 (none asked in rounds 1–3), in round 3's mix; tables and differences are asked for. */
export const CITATION_CASES_E1: ReadonlyArray<CitationCase> = [
  { kind: 'single', language: 'en', question: 'What stands out on this display? Quote the values.' },
  { kind: 'single', language: 'en', question: 'Which readings are closest to a limit, and how close?' },
  { kind: 'single', language: 'en', question: 'Give me a table of the readings that matter.' },
  { kind: 'single', language: 'en', question: 'Should I be concerned by anything here? Use the numbers.' },
  { kind: 'single', language: 'en', question: 'Summarise this for the shift log with the key values.' },
  { kind: 'single', language: 'en', question: 'What are the three numbers I need from this display?' },
  { kind: 'single', language: 'nb', question: 'Hva er de viktigste tallene på dette displayet?' },
  { kind: 'single', language: 'nb', question: 'Er noe her nær en grense? Oppgi verdiene.' },
  { kind: 'multi', language: 'en', question: 'Compare the two displays in a table.' },
  { kind: 'multi', language: 'en', question: 'Which display matters more right now? Back it with values from both.' },
  { kind: 'multi', language: 'en', question: 'Give one sentence per display with its key numbers.' },
  { kind: 'multi', language: 'en', question: 'What differs most between the two displays, in numbers?' },
  { kind: 'multi', language: 'nb', question: 'Hva er forskjellen mellom de to displayene? Bruk tallene.' },
  { kind: 'since', language: 'en', question: 'Since when has each state on this display held?' },
  { kind: 'since', language: 'en', question: 'Which state changed most recently, and what does it read?' },
  { kind: 'since', language: 'nb', question: 'Hvor lenge har tilstandene på displayet vart?' },
]

/** Every frozen Run but the live situation monitor: plant, grid, weather and the entity-floor packs. */
export const PRODUCTION_RUNS = FROZEN_SPECS.map(spec => spec.id).filter(id => id !== 'norway-situation-monitor')

/** The operator-displays skill exactly as Agents injects it ("[name] description" and body, workspace-runtime.ts). */
export const injectedSkill = async (): Promise<string> => {
  const store = createSkillStore()
  await loadSkills(new URL('../../apps/agents/skills', import.meta.url).pathname, store, createToolRegistry())
  const skill = store.get('operator-displays')!
  return `[${skill.name}] ${skill.description}\n${skill.body}`
}

const COMPOSE = 'world.simulation-run.display.compose'
const WORKSPACE_CALL: ChatTool = { type: 'function', function: { name: 'workspace_call', description: 'Invoke Workspace Capabilities.', parameters: { type: 'object', properties: { calls: { type: 'array', items: { type: 'object' } } }, required: ['calls'] } } }

/** The assets of a Run in context order, and the World default card of an asset (refused defaults are none). */
const assetsOf = (frozen: FrozenRun): ReadonlyArray<string> => frozen.context.text.split('\n').filter(line => /^- [a-z0-9-]+:[^ ]+ · /.test(line)).map(line => line.slice(2).split(' · ')[0]!)
const defaultCard = async (frozen: FrozenRun, objectId: string): Promise<{ title: string; card: DisplayCard } | null> => {
  const outcome = await composeDefault(frozen.displayRun, objectId)
  return outcome.ok ? { title: outcome.state.title, card: outcome.card } : null
}

/** The single, two-card and since cards of a Run: the first asset's default; it and the first asset of another pack.
 * A pack the context lists only by category (the entity floor) contributes its first object, in Run order, whose
 * default card shows a number. */
export const productionCards = async (frozen: FrozenRun) => {
  const assets = assetsOf(frozen)
  const packOf = (objectId: string) => frozen.searchRun.objects.find(object => object.id === objectId)?.packId
  const defaults: Array<{ objectId: string; title: string; card: DisplayCard }> = []
  for (const objectId of assets) {
    const composed = await defaultCard(frozen, objectId)
    if (composed !== null && composed.card.items.length > 0) defaults.push({ objectId, ...composed })
  }
  const covered = new Set(assets.map(packOf))
  for (const object of frozen.searchRun.objects) {
    if (covered.has(object.packId)) continue
    const composed = await defaultCard(frozen, object.id)
    if (composed === null || !composed.card.items.some(item => item.numbers.length > 0)) continue
    defaults.push({ objectId: object.id, ...composed })
    covered.add(object.packId)
  }
  const first = defaults[0] ?? null
  const second = first === null ? null : defaults.find(entry => packOf(entry.objectId) !== packOf(first.objectId)) ?? null
  const since = defaults.find(entry => entry.card.items.some(item => / · since |since \d/.test(item.reading))) ?? null
  return { assets, defaults, single: first === null ? null : [first], multi: first === null || second === null ? null : [first, second], since: since === null ? null : [since] }
}

/** One answer: the turn as Agents shows it (one workspace_call per card, its result lines re-keyed). */
export const productionCase = async (frozen: FrozenRun, given: ReadonlyArray<{ objectId: string; title: string; card: DisplayCard }>, question: string, skill: string, ledger: ReturnType<typeof createLedger>, seed: number) => {
  const turn = createTurnCards()
  const messages: ChatMessage[] = [{ role: 'system', content: skill }, { role: 'user', content: question }]
  const cards: DisplayCard[] = []
  given.forEach((entry, index) => {
    const id = `call_${index + 1}_0`
    const input = { title: entry.title.slice(0, 80), question: question.slice(0, 300), subjects: [entry.objectId], views: [] }
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'workspace_call', arguments: JSON.stringify({ calls: [{ key: `v${index + 1}`, operationId: COMPOSE, target: { kind: 'resource', ref: { type: 'world.simulation-run', id: frozen.runId } }, input }] }) } }] })
    const card = turn.add(entry.card)
    cards.push(card)
    messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ results: [{ key: `v${index + 1}`, operationId: COMPOSE, success: true, data: { view: { viewType: 'display.vignette', title: entry.title }, card: cardLines(card) }, viewRef: `${id}/v${index + 1}` }] }) })
  })
  const result = await chat(ledger, messages, [WORKSPACE_CALL], 4_000, 'none', seed)
  return { answer: result.message.content ?? '', costUsd: result.costUsd, promptTokens: result.promptTokens, cards }
}

/** The production guard and the T10 measures of one answer. */
// A fenced block (the leitbild-view block and its viewRef "call_1_0/v1") is no prose: its digits are no shown values.
export const proseOnly = (answer: string): string => answer.replace(/```[\s\S]*?(?:```|$)/g, block => block.replace(/[^\n]/g, ' '))

export const scoreProduction = (answer: string, cards: ReadonlyArray<DisplayCard>, language: 'en' | 'nb') => {
  const items = cards.flatMap(card => card.items)
  const limits = new Map(items.map(item => [item.key, item.limits ?? []]))
  // The shipped guard reads the answer as sent; the measures read its prose (a fence carries no key, so no flag moves).
  const issues = citationIssues(answer, items)
  const shipped = readingFlags(answer, new Map(items.map(item => [item.key, item])), language)
  const reading = productionReading(proseOnly(answer), items, language, limits)
  const base = scoreCitations(proseOnly(answer), [...cards], language, limits)
  // The harness reading must flag exactly what the shipped one does, so its cited count is the shipped denominator.
  const agrees = JSON.stringify(shipped.map(flag => flag.number)) === JSON.stringify(reading.flagged.map(flag => flag.number))
  return {
    exact: base.exact, malformed: base.malformed, unknownKeys: issues.unknownKeys,
    contradictions: issues.contradictions, readingFlags: shipped.map(flag => ({ number: flag.number, keys: flag.keys, derived: flag.derived, at: answer.slice(Math.max(0, flag.index - 50), flag.end + 50) })),
    cited: reading.cited, names: reading.namesSkipped, derivedChecked: reading.derivedChecked, derivedUnchecked: reading.derivedUnchecked,
    displayed: reading.displayed, keyed: reading.keyed, keyedAfter: reading.keyedAfter, agrees,
  }
}

type Scored = ReturnType<typeof scoreProduction>
export const summariseProduction = (rows: ReadonlyArray<{ readonly score: Scored }>) => {
  const sum = (pick: (score: Scored) => number) => rows.reduce((total, row) => total + pick(row.score), 0)
  return {
    answers: rows.length,
    exactToken: wilson(sum(score => score.exact), sum(score => score.exact + score.malformed)),
    keyUse: wilson(sum(score => score.keyed), sum(score => score.displayed)),
    keyUseAfter: wilson(sum(score => score.keyedAfter), sum(score => score.displayed)),
    cited: sum(score => score.cited),
    productionFlags: wilson(sum(score => score.contradictions.length), sum(score => score.cited)),
    singleReadingFlags: sum(score => score.readingFlags.length),
    names: sum(score => score.names),
    derivedChecked: sum(score => score.derivedChecked),
    derivedUnchecked: sum(score => score.derivedUnchecked.length),
    unknownKeys: sum(score => score.unknownKeys.length),
    harnessDisagrees: rows.filter(row => !row.score.agrees).length,
  }
}

if (import.meta.main) {
  const [directory, ...rest] = Bun.argv.slice(2)
  const option = (name: string) => rest.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
  const dry = rest.includes('--dry')
  const budget = Number(option('budget') ?? 0)
  if (!directory || !isAbsolute(directory) || (!dry && !(budget > 0))) throw new Error('Usage: t10-production.ts <absolute-out-dir> --budget=<USD> [--runs=<id,…>] [--dry]')
  const runs = option('runs')?.split(',') ?? PRODUCTION_RUNS
  const skill = await injectedSkill()
  const ledger = createLedger(dry ? 0.000001 : budget)
  await mkdir(join(directory, 'data'), { recursive: true })
  const rows: Array<Record<string, any>> = []
  const runCards: Array<Record<string, unknown>> = []
  for (const spec of FROZEN_SPECS.filter(entry => runs.includes(entry.id))) {
    const frozen = await freezeRun(spec, join(directory, 'data'))
    try {
      const cards = await productionCards(frozen)
      runCards.push({ run: spec.id, context: frozen.context.text, assets: cards.assets, defaults: cards.defaults.map(entry => ({ objectId: entry.objectId, title: entry.title, lines: cardLines(entry.card), chars: cardLines(entry.card).join('\n').length, items: entry.card.items.length })) })
      if (dry) { console.log(JSON.stringify(runCards.at(-1), null, 1)); continue }
      for (const [index, testCase] of CITATION_CASES_E1.entries()) {
        const given = testCase.kind === 'single' ? cards.single : testCase.kind === 'multi' ? cards.multi : cards.since
        if (given === null) { rows.push({ run: spec.id, case: index, ...testCase, skipped: `no ${testCase.kind} cards in this Run` }); continue }
        const seed = 80_000 + FROZEN_SPECS.indexOf(spec) * 50 + index
        const result = await productionCase(frozen, given, testCase.question, skill, ledger, seed)
        const score = scoreProduction(result.answer, result.cards, testCase.language)
        rows.push({ run: spec.id, case: index, seed, ...testCase, answer: result.answer, costUsd: result.costUsd, promptTokens: result.promptTokens, cards: result.cards, score })
        console.log(JSON.stringify({ run: spec.id, case: index, kind: testCase.kind, language: testCase.language, exact: score.exact, cited: score.cited, contradictions: score.contradictions.length, flags: score.readingFlags.length, keyed: `${score.keyed}/${score.displayed}`, agrees: score.agrees, costUsd: result.costUsd }))
        await Bun.write(join(directory, 't10-production-rows.jsonl'), rows.map(entry => JSON.stringify(entry)).join('\n') + '\n')
      }
    } finally { await frozen.close() }
  }
  await Bun.write(join(directory, 'run-cards.json'), JSON.stringify(runCards, null, 1))
  if (dry) process.exit(0)
  const scored = rows.filter(row => row.score !== undefined) as Array<{ score: Scored; kind: string; language: string }>
  const summary = {
    t10: summariseProduction(scored),
    byKind: Object.fromEntries(['single', 'multi', 'since'].map(kind => [kind, summariseProduction(scored.filter(row => row.kind === kind))])),
    norwegian: summariseProduction(scored.filter(row => row.language === 'nb')),
    skipped: rows.filter(row => row.skipped !== undefined).length,
    ledger: { calls: ledger.calls, costUsd: ledger.spentUsd },
  }
  await Bun.write(join(directory, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
}
