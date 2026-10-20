// T02, row identity for the P1 bridge (plan v3.1 Appendix F; architecture
// P5): what each drawn item binds and writes, read as a reviewer can diff it,
// beside diagram-parity's geometry. Every mimic intent an agent wrote in the
// probe evidence (both chat heights), the unit overview at every window size
// and loop count, the detail of every drawable component, and what procedure
// tags open (their equipment's detail at the T01 view size). Each case is a
// line: per item its id and a digest of its binding, presentation, rows,
// flap lines, marker and components; per stub its text, word and states; per
// pipe its link, carrier and state; or the refusal, hashed with its words.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
} from '../../../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../../../src/packs/process-plant/runtime-instance.ts'
import { compileDetailDisplay, compileOverviewDisplay, type ComposedDisplayCompileResult } from '../../../src/packs/process-plant/displays/compose.ts'
import { compileMimic, type MimicCompileResult } from '../../../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import { MIMIC_MAX_WIDTH, type CompiledMimic } from '../../../src/packs/process-plant/displays/mimic/mimic-model.ts'
import type { MimicIntent } from '../../../src/packs/process-plant/displays/mimic/scope.ts'
import { presentationFor } from '../../../src/packs/process-plant/displays/mimic/presentation.ts'
import { chatMimicProfile } from '../../../src/packs/process-plant/displays/mimic/profiles.ts'
import { PARITY_VIEWS } from '../diagram-parity/cases.ts'
import { PROCEDURE_TAGS } from '../../display-characterization/old-path.ts'

/** The view T01 opens procedure tag displays in. */
const VIEW_SIZE = { width: 1280, height: 800 }

const intents = JSON.parse(readFileSync(new URL('../diagram-parity/intents.json', import.meta.url), 'utf8')) as {
  readonly probe: ReadonlyArray<{ readonly intent: MimicIntent }>
}

export interface RowCase {
  readonly key: string
  readonly record: () => string
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12)

const rowsOf = (mimic: CompiledMimic): string => [
  ...mimic.items.map(item => `${item.id}:${digest([item.binding, item.presentation, item.rows, item.flapLines, item.marker, item.components, item.trend ?? null])}`),
  ...mimic.stubs.map(stub => `${stub.id}:${digest([stub.direction, stub.text, stub.word, stub.states])}`),
  ...mimic.pipes.map(pipe => `${pipe.id}:${digest([pipe.linkId, pipe.carrier, pipe.state])}`),
  `paths:${digest([mimic.paths, mimic.trendPaths, mimic.summary])}`,
].join(' ')

const refused = (messages: ReadonlyArray<string>): string => `refused ${digest(messages)} ${messages.join(' | ').slice(0, 160)}`

const mimicRows = (result: MimicCompileResult): string => (result.ok ? rowsOf(result.mimic) : refused(result.issues.map(issue => issue.message)))

const displayRows = (result: ComposedDisplayCompileResult): string => {
  if (!result.ok) return refused(result.issues.map(issue => issue.message))
  const panel = result.display.panels.find(entry => entry.kind === 'mimic')
  if (panel?.kind !== 'mimic') throw new Error('a generated display draws a mimic')
  return rowsOf(panel.mimic)
}

const plantInstance = (loopCount: number): ProcessPlantRuntimeInstance => {
  const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: `plant:parity-${loopCount}`, loopCount }))
  const runtime = createProcessPlantRuntime({ system: compiled })
  return {
    plant: compiled,
    runtime,
    ramps: createProcessPlantRampRunner({ runtime }),
    protection: createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation }),
    performance: createProcessPlantRuntimePerformance(),
  }
}

const viewKey = (view: { readonly width: number; readonly height: number } | null): string => (view === null ? 'natural' : `${view.width}x${view.height}`)

export const rowCases = (): ReadonlyArray<RowCase> => {
  const system = plantInstance(4)
  const graph = system.plant.graph
  const recorded = new Set<string>()
  const chat = (height: number) => ({ profile: chatMimicProfile, maxWidth: MIMIC_MAX_WIDTH, maxHeight: height })
  const drawable = graph.components.filter(component => presentationFor(component).element !== 'not-drawn').map(component => String(component.id))
  const tagged = [...new Set(PROCEDURE_TAGS.flatMap(tag => {
    const binding = graph.signalBindingByTagId.get(tag as never)
    return binding?.owner.type === 'component' ? [String(graph.components[binding.owner.componentIndex]!.id)] : []
  }))]
  const others = [2, 3, 5, 6].map(loopCount => ({ loopCount, system: plantInstance(loopCount) }))
  return [
    ...intents.probe.flatMap(({ intent }) => [624, 744].map(height => ({
      key: `probe ${JSON.stringify(intent)} @${MIMIC_MAX_WIDTH}x${height}`,
      record: () => mimicRows(compileMimic(system.plant, intent, chat(height))),
    }))),
    ...[null, ...PARITY_VIEWS].map(view => ({ key: `overview loops 4 @${viewKey(view)}`, record: () => displayRows(compileOverviewDisplay(system, recorded, view)) })),
    ...others.flatMap(other => [null, PARITY_VIEWS[0]!].map(view => ({
      key: `overview loops ${other.loopCount} @${viewKey(view)}`,
      record: () => displayRows(compileOverviewDisplay(other.system, recorded, view)),
    }))),
    ...drawable.map(id => ({ key: `detail ${id} @${viewKey(PARITY_VIEWS[0]!)}`, record: () => displayRows(compileDetailDisplay(system, recorded, [id], PARITY_VIEWS[0]!)) })),
    ...tagged.map(id => ({ key: `tag display ${id} @${viewKey(VIEW_SIZE)}`, record: () => displayRows(compileDetailDisplay(system, recorded, [id], VIEW_SIZE)) })),
  ]
}
