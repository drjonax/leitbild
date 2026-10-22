import { workspaceDefinitionRevisionReferenceSchema } from '@leitbild/contracts'
import { z } from 'zod'
import { electricalConnectionDefinitionSchema, electricalPortDefinitionSchema, electricalPortsFromObject, geoJsonGeometrySchema, objectIdSchema, type CompiledScenario } from '../model/index.ts'
import type { WorldPack } from '../packs/protocol.ts'
import { defaultHistorianLimits } from '../../features/historian/policy.ts'

export const scenarioWriteResultSchema = z.object({
  definition: workspaceDefinitionRevisionReferenceSchema,
  title: z.string().min(1),
  uiPath: z.string().min(1),
}).strict()
export const scenarioPreviewSchema = z.object({
  scenarioId: z.string().min(1),
  packs: z.array(z.string()),
  objectives: z.array(z.string()),
  view: z.object({
    center: z.tuple([z.number().finite(), z.number().finite()]),
    zoom: z.number().finite(),
    layers: z.array(z.string()),
  }).strict(),
  assets: z.array(z.object({
    id: objectIdSchema, label: z.string(), kind: z.string(), packId: z.string(),
    electricalPorts: z.array(electricalPortDefinitionSchema),
    geometry: geoJsonGeometrySchema.optional(),
  }).strict()),
  initialInventory: z.array(z.object({
    packId: z.string(), kind: z.string(), count: z.number().int().nonnegative(),
  }).strict()),
  connections: z.array(electricalConnectionDefinitionSchema),
  timeline: z.object({
    cueCount: z.number().int().nonnegative(),
    lastCueAtSeconds: z.number().nonnegative().nullable(),
    cues: z.array(z.object({
      id: z.string().min(1),
      atSeconds: z.number().nonnegative(),
      title: z.string().min(1).optional(),
      actions: z.array(z.object({
        type: z.string().min(1),
        capabilityId: z.string().min(1).optional(),
        inputKeys: z.array(z.string()).optional(),
        identifiers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
      }).strict()),
    }).strict()),
  }).strict(),
  recording: z.object({
    selections: z.array(z.object({ packId: z.string(), profileId: z.string(), intervalMs: z.number(), initialSeriesCount: z.number().int().nonnegative().nullable(), samplesPerSimulationSecond: z.number().nonnegative().nullable() }).strict()),
    sampleBudget: z.number(), ageLimitSeconds: z.number(), byteBudget: z.number(),
    sampleWindowSimulationSeconds: z.number().nonnegative().nullable(),
  }).strict(),
}).strict()
export type ScenarioPreview = z.infer<typeof scenarioPreviewSchema>

const inputOutline = (input: unknown): { inputKeys: string[]; identifiers: Record<string, string | string[]> } => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { inputKeys: [], identifiers: {} }
  const root = input as Record<string, unknown>
  const identifiers: Record<string, string | string[]> = {}
  const visit = (value: unknown, path: string, depth: number): void => {
    if (Object.keys(identifiers).length >= 16 || depth > 3 || typeof value !== 'object' || value === null) return
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key
      if (/id$/i.test(key) && typeof child === 'string') identifiers[childPath] = child
      else if (/ids$/i.test(key) && Array.isArray(child) && child.every(item => typeof item === 'string')) identifiers[childPath] = child.slice(0, 16)
      else visit(child, childPath, depth + 1)
      if (Object.keys(identifiers).length >= 16) return
    }
  }
  visit(root, '', 0)
  return { inputKeys: Object.keys(root).slice(0, 32), identifiers }
}

export const scenarioPreviewFor = (scenario: CompiledScenario, packs: ReadonlyArray<WorldPack>): ScenarioPreview => {
  const selections = scenario.recording.map(selection => {
    const pack = packs.find(pack => pack.descriptor.id === selection.packId)!
    const profile = pack.recording!.profiles.find(profile => profile.id === selection.profileId)!
    const intervalMs = selection.intervalMs ?? profile.defaultIntervalMs
    const initialSeriesCount = pack.recording?.estimateSeries?.(scenario.initialObjects.filter(object => object.packId === selection.packId), selection.profileId) ?? null
    return { packId: selection.packId, profileId: selection.profileId, intervalMs, initialSeriesCount, samplesPerSimulationSecond: initialSeriesCount === null ? null : initialSeriesCount * 1000 / intervalMs }
  })
  const rate = selections.reduce((sum, selection) => sum + (selection.samplesPerSimulationSecond ?? 0), 0)
  const inventory = new Map<string, { packId: string; kind: string; count: number }>()
  for (const object of scenario.initialObjects) {
    const key = `${object.packId}\u0000${object.kind}`
    const current = inventory.get(key)
    inventory.set(key, { packId: object.packId, kind: object.kind, count: (current?.count ?? 0) + 1 })
  }
  return scenarioPreviewSchema.parse({
    scenarioId: scenario.id,
    packs: scenario.packs,
    objectives: scenario.objectives ?? [],
    view: {
      center: scenario.view.map.center.coordinates,
      zoom: scenario.view.map.zoom,
      layers: scenario.view.map.layers,
    },
    assets: scenario.initialObjects.map(object => ({
      id: object.id, label: object.label, kind: object.kind, packId: object.packId,
      electricalPorts: electricalPortsFromObject(object),
      geometry: packs.find(pack => pack.descriptor.id === object.packId)?.scenario?.previewGeometry?.(object)
        ?? object.spatial.geometry ?? object.spatial.position?.point,
    })),
    initialInventory: [...inventory.values()].sort((left, right) => left.packId.localeCompare(right.packId) || left.kind.localeCompare(right.kind)),
    connections: scenario.connections,
    timeline: {
      cueCount: scenario.timeline?.cues.length ?? 0,
      lastCueAtSeconds: scenario.timeline?.cues.reduce<number | null>(
        (latest, cue) => latest === null ? cue.at.seconds : Math.max(latest, cue.at.seconds),
        null,
      ) ?? null,
      cues: (scenario.timeline?.cues ?? []).map(cue => ({
        id: cue.id,
        atSeconds: cue.at.seconds,
        ...(cue.title === undefined ? {} : { title: cue.title }),
        actions: cue.actions.map(action => action.type === 'invoke_capability'
          ? { type: action.type, capabilityId: action.capabilityId, ...inputOutline(action.input) }
          : { type: action.type }),
      })),
    },
    recording: {
      selections, sampleBudget: defaultHistorianLimits.maxSamples, ageLimitSeconds: defaultHistorianLimits.maxAgeMs / 1000, byteBudget: defaultHistorianLimits.maxBytes,
      sampleWindowSimulationSeconds: rate > 0 && selections.every(selection => selection.initialSeriesCount !== null) ? defaultHistorianLimits.maxSamples / rate : null,
    },
  })
}
