import { gridPriceAreaSchema } from '../schemas/grid-golden.ts'
import type { AuditContext } from './audit-context.ts'
import { checkStatus, type AuditCheck, type AuditFailure } from './audit-report.ts'

const priceAreas = gridPriceAreaSchema.options
const referencedFamilies = ['hydro', 'wind'] as const

const round = (value: number): number => Math.round(value * 10) / 10
const percent = (value: number): string => Number.isFinite(value) ? `${(value * 100).toFixed(1)} %` : 'no reference quantity'
const deviationFrom = (modelValue: number, referenceValue: number): number =>
  referenceValue === 0 ? (modelValue === 0 ? 0 : Number.POSITIVE_INFINITY) : (modelValue - referenceValue) / referenceValue

export const attachmentCheck = (context: AuditContext): AuditCheck => {
  const thresholds = context.golden.thresholds
  const limits = thresholds.maxAttachmentKm
  const failures: AuditFailure[] = []
  for (const generator of context.graph.generators) {
    const limit = limits.generator[generator.family]
    if (generator.attachmentKm <= limit) continue
    failures.push({ message: `generator ${generator.label} (${generator.family}, ${round(generator.capacityMw)} MW) is ${generator.attachmentKm.toFixed(1)} km from its bus (max ${limit} km)`, assetIds: [generator.id, generator.busId] })
  }
  for (const load of context.graph.loads) {
    const limit = limits.load[load.family]
    if (load.attachmentKm <= limit) continue
    failures.push({ message: `load ${load.label} (${load.family}, ${round(load.demandMw)} MW) is ${load.attachmentKm.toFixed(1)} km from its bus (max ${limit} km)`, assetIds: [load.id, load.busId] })
  }
  const maximum = (values: ReadonlyArray<number>): number => values.reduce((best, value) => Math.max(best, value), 0)
  return {
    id: 'attachment-distance',
    title: 'Generator and load attachment distance by kind',
    status: checkStatus(failures.length > thresholds.maxAttachmentViolations, undefined),
    summary: `${failures.length} assets attached beyond their kind limit (max ${thresholds.maxAttachmentViolations})`,
    metrics: {
      violations: failures.length,
      maximumGeneratorKm: maximum(context.graph.generators.map(generator => generator.attachmentKm)),
      maximumLoadKm: maximum(context.graph.loads.map(load => load.attachmentKm)),
    },
    failures,
  }
}

export const generationCheck = (context: AuditContext): AuditCheck => {
  const thresholds = context.golden.thresholds
  const reference = context.golden.references.generation.capacityMwByFamily
  const failures: AuditFailure[] = []
  const metrics: Record<string, number> = {}
  const unassigned = context.graph.generators.filter(generator => generator.priceArea === undefined)
  const unassignedMw = unassigned.reduce((sum, generator) => sum + generator.capacityMw, 0)
  for (const family of referencedFamilies) {
    const tolerance = thresholds.generationTolerance[family]
    for (const area of priceAreas) {
      const modelMw = context.graph.generators
        .filter(generator => generator.family === family && generator.priceArea === area)
        .reduce((sum, generator) => sum + generator.capacityMw, 0)
      const referenceMw = reference[family][area]
      metrics[`${family}.${area}.modelMw`] = round(modelMw)
      metrics[`${family}.${area}.referenceMw`] = referenceMw
      const deviation = deviationFrom(modelMw, referenceMw)
      if (Math.abs(deviation) <= tolerance) continue
      failures.push({
        message: `${family} in ${area}: model ${round(modelMw)} MW vs reference ${referenceMw} MW (${percent(deviation)}, tolerance ±${percent(tolerance)})`,
        assetIds: [`reference:${family}.${area}`],
      })
    }
  }
  const otherAreas = context.graph.generators.filter(generator => generator.priceArea !== undefined && !(priceAreas as ReadonlyArray<string>).includes(generator.priceArea))
  if (otherAreas.length > 0) {
    failures.push({ message: `${otherAreas.length} generators carry a price area outside NO1–NO5`, assetIds: otherAreas.map(generator => generator.id) })
  }
  if (unassignedMw > thresholds.maxUnassignedGenerationMw) {
    failures.push({ message: `${unassigned.length} generators (${round(unassignedMw)} MW) have no price area (max ${thresholds.maxUnassignedGenerationMw} MW)`, assetIds: unassigned.map(generator => generator.id) })
  }
  for (const family of ['solar', 'thermal', 'nuclear'] as const) {
    metrics[`${family}.unreferencedMw`] = round(context.graph.generators.filter(generator => generator.family === family).reduce((sum, generator) => sum + generator.capacityMw, 0))
  }
  metrics.unassignedMw = round(unassignedMw)
  return {
    id: 'generation-by-area',
    title: 'Generation capacity per kind and price area against registry totals',
    status: checkStatus(failures.length > 0, undefined),
    summary: `${failures.length} deviations; ${round(unassignedMw)} MW without price area; solar/thermal/nuclear have no registry reference and are reported only`,
    metrics,
    failures,
  }
}

export const loadCheck = (context: AuditContext): AuditCheck => {
  const thresholds = context.golden.thresholds
  const reference = context.golden.references.load
  const failures: AuditFailure[] = []
  const metrics: Record<string, number> = {}
  if (context.graph.referenceHour === undefined) {
    failures.push({ message: `the model declares no reference hour; the golden reference is ${reference.referenceHour}`, assetIds: [context.graph.modelId] })
  } else if (Date.parse(context.graph.referenceHour) !== Date.parse(reference.referenceHour)) {
    failures.push({ message: `model reference hour ${context.graph.referenceHour} differs from the golden reference ${reference.referenceHour}`, assetIds: [context.graph.modelId] })
  }
  for (const area of priceAreas) {
    const modelMw = context.graph.loads.filter(load => load.priceArea === area).reduce((sum, load) => sum + load.demandMw, 0)
    const referenceMw = reference.demandMwByArea[area]
    metrics[`${area}.modelMw`] = round(modelMw)
    metrics[`${area}.referenceMw`] = referenceMw
    const deviation = deviationFrom(modelMw, referenceMw)
    if (Math.abs(deviation) <= thresholds.loadTolerance) continue
    failures.push({ message: `load in ${area}: model ${round(modelMw)} MW vs reference ${referenceMw} MW (${percent(deviation)}, tolerance ±${percent(thresholds.loadTolerance)})`, assetIds: [`reference:load.${area}`] })
  }
  const unassigned = context.graph.loads.filter(load => load.priceArea === undefined || !(priceAreas as ReadonlyArray<string>).includes(load.priceArea))
  if (unassigned.length > 0) {
    failures.push({ message: `${unassigned.length} loads (${round(unassigned.reduce((sum, load) => sum + load.demandMw, 0))} MW) have no NO1–NO5 price area`, assetIds: unassigned.map(load => load.id) })
  }
  const totalModel = context.graph.loads.reduce((sum, load) => sum + load.demandMw, 0)
  const totalReference = priceAreas.reduce((sum, area) => sum + reference.demandMwByArea[area], 0)
  metrics.totalModelMw = round(totalModel)
  metrics.totalReferenceMw = totalReference
  return {
    id: 'load-by-area',
    title: 'Load per price area against the reference hour',
    status: checkStatus(failures.length > 0, undefined),
    summary: `model ${round(totalModel)} MW vs reference ${totalReference} MW at ${reference.referenceHour}; ${failures.length} deviations`,
    metrics,
    failures,
  }
}
