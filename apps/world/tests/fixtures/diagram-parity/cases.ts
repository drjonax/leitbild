// The drawings whose geometry must not change unless a commit says why
// (T02, geometry identity): every mimic intent an agent wrote in the probe
// evidence (2026-10-09 to 2026-10-19), the 489-intent sweep of the layout
// audit, the unit overview at the window sizes operators use and at its own
// size for two to six loops, and the detail of every drawable component.
// Each case records what was drawn, as a line a reviewer can read in a diff:
// its size and crossings, a hash of its geometry alone and a hash of the
// whole compiled output; or the refusal, hashed, with its opening words.
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
import { compileDetailDisplay, compileOverviewDisplay, type ComposedDisplayCompileResult, type OverviewView } from '../../../src/packs/process-plant/displays/compose.ts'
import { compileMimic, type MimicCompileResult } from '../../../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import type { CompiledMimic } from '../../../src/packs/process-plant/displays/mimic/mimic-model.ts'
import { MIMIC_MAX_WIDTH } from '../../../src/packs/process-plant/displays/mimic/mimic-model.ts'
import { presentationFor } from '../../../src/packs/process-plant/displays/mimic/presentation.ts'
import { chatMimicProfile } from '../../../src/packs/process-plant/displays/mimic/profiles.ts'
import type { MimicIntent } from '../../../src/packs/process-plant/displays/mimic/mimic-model.ts'

const intents = JSON.parse(readFileSync(new URL('./intents.json', import.meta.url), 'utf8')) as {
  readonly probe: ReadonlyArray<{ readonly intent: MimicIntent; readonly seenIn: ReadonlyArray<string> }>
  readonly sweep: ReadonlyArray<{ readonly family: string; readonly intent: MimicIntent }>
}

export interface ParityCase {
  readonly key: string
  readonly record: () => string
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

/** What the layout placed, without the bindings, rows and states the drawing shows there. */
const geometryOf = (mimic: CompiledMimic): unknown => [
  mimic.width,
  mimic.height,
  mimic.crossings,
  mimic.hash,
  mimic.items.map(item => [item.id, item.box, item.orientation, item.text, item.frame, item.vessel ?? null]),
  mimic.pipes.map(pipe => [pipe.id, pipe.points, pipe.gaps]),
  mimic.stubs.map(stub => [stub.id, stub.end, stub.textBox]),
  mimic.zones,
]

const drawn = (mimic: CompiledMimic, output: unknown): string =>
  `drawn ${mimic.width}x${mimic.height} crossings ${mimic.crossings} geometry ${digest(geometryOf(mimic))} output ${digest(output)}`

const refused = (messages: ReadonlyArray<string>): string => {
  const text = messages.join(' | ')
  return `refused ${digest(text)} ${text.slice(0, 160)}`
}

const mimicRecord = (result: MimicCompileResult): string =>
  result.ok ? drawn(result.mimic, result.mimic) : refused(result.issues.map(issue => issue.message))

const displayRecord = (result: ComposedDisplayCompileResult): string => {
  if (!result.ok) return refused(result.issues.map(issue => issue.message))
  const panel = result.display.panels.find(entry => entry.kind === 'mimic')
  if (panel?.kind !== 'mimic') throw new Error('a generated display draws a mimic')
  return `${drawn(panel.mimic, result.display)} height ${result.display.height} panels ${result.display.panels.map(entry => entry.kind).join(',')}`
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

/** Process display windows: Full HD and QHD as measured on production, then the untuned sizes the layout audit timed. */
export const PARITY_VIEWS: ReadonlyArray<OverviewView> = [
  { width: 1896, height: 972 },
  { width: 2536, height: 1332 },
  { width: 1920, height: 1080 },
  { width: 1600, height: 900 },
  { width: 1280, height: 800 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
]

const viewKey = (view: OverviewView | null): string => (view === null ? 'natural' : `${view.width}x${view.height}`)

/** Equipment whose detail is drawn at every untuned size too: the detail the audit timed, and one of each kind an operator opens. */
const DETAILS_AT_EVERY_SIZE = ['sgB', 'rcpA', 'pressurizer', 'core', 'safetyBusA', 'auxFeedwaterPumpMotor', 'mainSteamHeader', 'chargingPump']

export const parityCases = (): ReadonlyArray<ParityCase> => {
  const system = plantInstance(4)
  const graph = system.plant.graph
  const recorded = new Set<string>()
  const chat = (height: number) => ({ profile: chatMimicProfile, maxWidth: MIMIC_MAX_WIDTH, maxHeight: height })
  const intentCases = (set: string, entries: ReadonlyArray<{ readonly intent: MimicIntent }>, heights: ReadonlyArray<number>): ParityCase[] =>
    entries.flatMap(({ intent }) => heights.map(height => ({
      key: `${set} ${JSON.stringify(intent)} @${MIMIC_MAX_WIDTH}x${height}`,
      record: () => mimicRecord(compileMimic(system.plant, intent, chat(height))),
    })))
  const drawable = graph.components.filter(component => presentationFor(component).element !== 'not-drawn').map(component => String(component.id))
  const others = [2, 3, 5, 6].map(loopCount => ({ loopCount, system: plantInstance(loopCount) }))
  return [
    ...intentCases('probe', intents.probe, [624, 744]),
    ...intentCases('sweep', intents.sweep, [624]),
    ...[null, ...PARITY_VIEWS].map(view => ({ key: `overview loops 4 @${viewKey(view)}`, record: () => displayRecord(compileOverviewDisplay(system, recorded, view)) })),
    ...others.flatMap(other => [null, PARITY_VIEWS[0]!].map(view => ({
      key: `overview loops ${other.loopCount} @${viewKey(view)}`,
      record: () => displayRecord(compileOverviewDisplay(other.system, recorded, view)),
    }))),
    ...drawable.map(id => ({ key: `detail ${id} @${viewKey(PARITY_VIEWS[0]!)}`, record: () => displayRecord(compileDetailDisplay(system, recorded, [id], PARITY_VIEWS[0]!)) })),
    ...DETAILS_AT_EVERY_SIZE.flatMap(id => [null, ...PARITY_VIEWS.slice(1)].map(view => ({
      key: `detail ${id} @${viewKey(view)}`,
      record: () => displayRecord(compileDetailDisplay(system, recorded, [id], view)),
    }))),
  ]
}
