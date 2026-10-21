import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { displayRunOf } from '../src/core/api/display-capabilities.ts'
import type { ActorId, IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { composeVignette } from '../src/features/displays/compose/compose.ts'
import { compileVignette, sampleVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { VIGNETTE_ROW_PX } from '../src/ui/embed/vignette/grid.ts'
import { networkDrawing } from '../src/ui/embed/vignette/network.ts'
import { measureCpu } from './helpers/network-layout-measure.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// T32 on the real compose path (architecture B2): a network vignette composed as the Assistant composes it, around the
// Halden switchyard at one and two station hops, compiled by World (scope, server sizing, ELK) and drawn by the
// renderer: ≤ 2 crossings, no overlapping boxes, every name whole, warm p95 CPU of the compile ≤ 30 ms, cold reported.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const person = { id: 'actor:human:t32' as ActorId, label: 'T32', role: 'operator' as const }
const GRID = 'grid:halden-four-unit' as ObjectId
let registry: SimulationRunRegistry
let dataDir: string
let run: ViewRun
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'leitbild-t32-'))
  registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
  })
  const runtime = await registry.create({ scenarioId: 'halden-power-complex' })
  await runtime.setClock({ paused: true })
  await runtime.runMaximumPace(new Date(Date.parse(runtime.snapshot().clock!.currentTime) + 10_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  run = await displayRunOf(registry, runtime, person, new Set())
})
afterAll(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

describe('T32 on the real compose path', () => {
  for (const hops of [1, 2]) {
    test(`the Halden ${hops}-hop network vignette: ≤ 2 crossings, no overlaps, names whole, warm p95 compile CPU ≤ 30 ms`, async () => {
      const graph = await run.port.topology(GRID)
      if ('refused' in graph) throw new Error(graph.refused.message)
      const media = graph.media.filter(medium => (medium.level?.value ?? 0) >= 300).map(medium => medium.label)
      const outcome = await composeVignette(run, {
        title: 'Halden switchyard network', question: 'How is the switchyard connected?', subjects: [GRID],
        views: [{ kind: 'topology', around: [`${GRID}#bus:curated-halden-pwr-switchyard@420`], media, reach: 2 * hops }],
      })
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
      const report = await measureCpu(() => compileVignette(run, outcome.state), 20)
      const view = await compileVignette(run, outcome.state)
      const section = view.sections.find(entry => entry.kind === 'topology')
      if (section?.kind !== 'topology') throw new Error(`no topology drawn: ${view.sections.map(entry => entry.kind).join(', ')}`)
      const { layout } = section
      const sample = await sampleVignette(run, outcome.state)
      const drawing = networkDrawing(section, sample.observations)
      console.log(`T32 compose path, Halden ${hops}-hop: ${section.nodes.length} nodes, ${layout.width}×${layout.height} grid, ${layout.crossings} crossings; compile cold ${report.coldMs.toFixed(1)} ms CPU, warm p95 ${report.warmP95Ms.toFixed(1)} ms (quiet ms)`)
      expect(layout.crossings).toBeLessThanOrEqual(2)
      const boxes = layout.nodes
      const overlapping = boxes.flatMap((a, i) => boxes.slice(i + 1).filter(b => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).map(b => `${a.id} × ${b.id}`))
      expect(overlapping).toEqual([])
      const named = new Map(section.nodes.map(node => [node.id, node.shortLabel ?? node.label]))
      expect(drawing.texts.filter(text => text.reading === null && text.name !== named.get(text.id)).map(text => text.id)).toEqual([])
      expect(drawing.height).toBe(layout.height * VIGNETTE_ROW_PX)
      expect(report.warmP95Ms).toBeLessThanOrEqual(30)
    })
  }
})
