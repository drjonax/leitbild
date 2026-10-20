/** Which of the 13 evidence kinds World adds to a display (evidence.ts,
 * displayEvidenceKindSchema) the agent's answers actually use, over the
 * replay corpus: recorded probe stages and the 19 Oct live-probe audit data.
 * A value is used when the answer cites it by tag, path or shown name.
 *
 *   bun scripts/display-eval/evidence-kinds.ts [--live=<live-probe-data dir>] [<stage-dir>:<stage> ...]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addedEvidenceUse, displayEvidenceOf } from './decisive.ts'

/** The kinds at bacf7a115 (apps/world/src/packs/process-plant/displays/composition.ts displayEvidenceKindSchema). */
export const EVIDENCE_KINDS = ['cause', 'hold', 'isolation', 'wider', 'delivers', 'trip', 'criterion', 'stabilize', 'program', 'isolates', 'reference', 'mode', 'flow'] as const

interface Presented { readonly source: string; readonly input: unknown; readonly data: unknown; readonly answer: string }

const viewRefOf = (content: string): string | null => /```leitbild-view\nview (\S+)\n```/.exec(content)?.[1] ?? null

/** The display each answer presented, from the live-probe audit's per-reply compose records. */
const fromLiveProbe = (directory: string): ReadonlyArray<Presented> => readdirSync(directory)
  .filter(file => file.endsWith('.json') && !file.includes('capture-index') && !file.startsWith('analysis'))
  .flatMap(file => {
    const record = JSON.parse(readFileSync(join(directory, file), 'utf8'))
    return ((record.replies ?? []) as ReadonlyArray<any>).flatMap(reply => {
      const ref = viewRefOf(reply.content ?? '')
      const compose = ref === null ? undefined : ((reply.compose ?? []) as ReadonlyArray<any>).find(entry => entry.viewRef === ref)
      return compose === undefined ? [] : [{ source: `live-probe/${file}#${reply.label}`, input: compose.input, data: compose.resultData, answer: reply.content }]
    })
  })

/** The display each answer of a recorded probe stage presented. */
const fromStage = async (directory: string, stage: string): Promise<ReadonlyArray<Presented>> => {
  const rows = (await Bun.file(join(directory, `${stage}-rows.jsonl`)).text()).split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
  const presented: Presented[] = []
  for (const row of rows) {
    const recorded = await Bun.file(join(directory, `${stage}-${row.id}.json`)).json()
    const ref = viewRefOf(recorded.answer?.content ?? '')
    const compose = ref === null ? undefined : ((recorded.composes ?? []) as ReadonlyArray<any>).find(entry => entry.result?.viewRef === ref)
    if (compose !== undefined) presented.push({ source: `${stage}/${row.id}`, input: compose.input, data: compose.result.data, answer: recorded.answer.content })
  }
  return presented
}

export const countKinds = (presented: ReadonlyArray<Presented>) => {
  const perKind = Object.fromEntries(EVIDENCE_KINDS.map(kind => [kind, { displays: 0, items: 0, citedItems: 0, answersCiting: 0 }]))
  const unknownKinds = new Set<string>()
  for (const display of presented) {
    const uses = addedEvidenceUse(displayEvidenceOf({ input: display.input, result: { data: display.data } }), display.answer)
    for (const kind of new Set(uses.map(use => use.kind))) {
      const tally = perKind[kind]
      if (tally === undefined) { unknownKinds.add(kind); continue }
      const ofKind = uses.filter(use => use.kind === kind)
      tally.displays += 1
      tally.items += ofKind.length
      tally.citedItems += ofKind.filter(use => use.cited).length
      if (ofKind.some(use => use.cited)) tally.answersCiting += 1
    }
  }
  return {
    displays: presented.length,
    displaysWithAddedValues: presented.filter(display => displayEvidenceOf({ input: display.input, result: { data: display.data } }).added.length > 0).length,
    perKind,
    neverAdded: EVIDENCE_KINDS.filter(kind => perKind[kind]!.displays === 0),
    addedNeverCited: EVIDENCE_KINDS.filter(kind => perKind[kind]!.displays > 0 && perKind[kind]!.citedItems === 0),
    unknownKinds: [...unknownKinds],
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2)
  const live = args.find(argument => argument.startsWith('--live='))?.slice('--live='.length)
  const presented: Presented[] = live === undefined ? [] : [...fromLiveProbe(live)]
  for (const entry of args.filter(argument => !argument.startsWith('--'))) {
    const [directory, stage] = entry.split(':')
    if (!directory || !stage) throw new Error(`Stage must be <dir>:<stage>, got ${entry}`)
    presented.push(...await fromStage(directory, stage))
  }
  console.log(JSON.stringify(countKinds(presented), null, 1))
}
