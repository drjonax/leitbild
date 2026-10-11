import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  VariablePath,
} from '../../src/packs/process-plant/index.ts'
import type {
  ProcessPlantMultiPlantSnapshot,
  ProcessPlantTelemetrySeries,
} from '../../src/packs/process-plant/engineering/index.ts'
import { saturationTemperatureCFromPressureMPa } from '../../src/packs/process-plant/runtime/thermophysics.ts'

export type ProcessPlantCredibilityMeasurement =
  | {
      readonly kind: 'point'
      readonly path: VariablePath
      readonly atMs: number
    }
  | {
      readonly kind: 'minAfter'
      readonly path: VariablePath
      readonly afterMs: number
    }
  | {
      readonly kind: 'maxAfter'
      readonly path: VariablePath
      readonly afterMs: number
    }
  | {
      readonly kind: 'delta'
      readonly path: VariablePath
      readonly fromMs: number
      readonly toMs: number
    }
  | {
      /** The change from fromMs to toMs of a reading above a reference (a core exit over the cold legs, or over its steam generators' saturation temperature). */
      readonly kind: 'deltaAbove'
      readonly path: VariablePath
      readonly reference: ProcessPlantCredibilityReference
      readonly fromMs: number
      readonly toMs: number
    }
  | {
      /** The most a reading stands apart from a reference, either way, after afterMs (a cold leg from its steam generators' saturation temperature). */
      readonly kind: 'maxApartAfter'
      readonly path: VariablePath
      readonly reference: ProcessPlantCredibilityReference
      readonly afterMs: number
    }

/** What a reading is judged against: another reading, or the saturation temperature at a pressure reading. */
export interface ProcessPlantCredibilityReference {
  readonly path: VariablePath
  readonly as: 'value' | 'saturationTemperatureC'
}

export interface ProcessPlantCredibilityTargetRange {
  readonly min?: number
  readonly max?: number
}

export interface ProcessPlantCredibilityTarget<
  TCaseId extends string = string,
  TSourceRefId extends string = string,
> {
  readonly id: string
  readonly caseId: TCaseId
  readonly label: string
  readonly signal: string
  readonly expectation: string
  readonly measure: ProcessPlantCredibilityMeasurement
  readonly acceptable: ProcessPlantCredibilityTargetRange
  readonly severity: 'gate' | 'watch'
  readonly sourceRefs: ReadonlyArray<TSourceRefId>
}

export interface ProcessPlantCredibilityTargetResult<
  TCaseId extends string = string,
  TSourceRefId extends string = string,
> {
  readonly targetId: string
  readonly caseId: TCaseId
  readonly label: string
  readonly signal: string
  readonly expectation: string
  readonly observed: number
  readonly acceptable: ProcessPlantCredibilityTargetRange
  readonly passed: boolean
  readonly severity: ProcessPlantCredibilityTarget<TCaseId, TSourceRefId>['severity']
  readonly sourceRefs: ReadonlyArray<TSourceRefId>
}

export interface ProcessPlantCredibilityCaseSummaryInput<TCaseId extends string = string> {
  readonly id: TCaseId
  readonly title: string
  readonly eventFamily: string
}

export interface ProcessPlantCredibilityCaseResultSummary<TCaseId extends string = string> {
  readonly caseId: TCaseId
  readonly title: string
  readonly eventFamily: string
  readonly targetCount: number
  readonly passedTargetCount: number
  readonly failedGateTargetCount: number
  readonly failedWatchTargetCount: number
}

export interface ProcessPlantCredibilityReportConfig<
  TCaseId extends string = string,
  TSourceRefId extends string = string,
> {
  readonly title: string
  readonly subtitle: string
  readonly scope: string
  readonly cases: ReadonlyArray<ProcessPlantCredibilityCaseSummaryInput<TCaseId>>
  readonly results: ReadonlyArray<ProcessPlantCredibilityTargetResult<TCaseId, TSourceRefId>>
}

const seriesFor = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: VariablePath,
): ProcessPlantTelemetrySeries => {
  const series = telemetry.find(candidate => candidate.path === path)
  if (!series) throw new Error(`missing process plant credibility telemetry series: ${path}`)
  return series
}

const numericValue = (series: ProcessPlantTelemetrySeries, index: number): number => {
  const point = series.points[index]
  if (!point) throw new Error(`missing process plant credibility telemetry point ${series.path} at index ${index}`)
  if (typeof point.value !== 'number') throw new Error(`process plant credibility variable is not numeric: ${series.path}`)
  return point.value
}

const valueAtOrAfter = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: VariablePath,
  elapsedMs: number,
): number => {
  const series = seriesFor(telemetry, path)
  const index = series.points.findIndex(point => point.elapsedMs >= elapsedMs)
  if (index < 0) throw new Error(`missing process plant credibility point for ${path} at ${elapsedMs}ms`)
  return numericValue(series, index)
}

const valuesAfter = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: VariablePath,
  elapsedMs: number,
): ReadonlyArray<number> => {
  const series = seriesFor(telemetry, path)
  const values = series.points
    .filter(point => point.elapsedMs >= elapsedMs)
    .map(point => {
      if (typeof point.value !== 'number') throw new Error(`process plant credibility variable is not numeric: ${path}`)
      return point.value
    })
  if (values.length === 0) throw new Error(`missing process plant credibility points for ${path} after ${elapsedMs}ms`)
  return values
}

const referenceValue = (reference: ProcessPlantCredibilityReference, value: number): number =>
  reference.as === 'saturationTemperatureC' ? saturationTemperatureCFromPressureMPa(value) : value

/** A reading above its reference at a time: both sampled together. */
const aboveAt = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: VariablePath,
  reference: ProcessPlantCredibilityReference,
  elapsedMs: number,
): number => valueAtOrAfter(telemetry, path, elapsedMs) - referenceValue(reference, valueAtOrAfter(telemetry, reference.path, elapsedMs))

const measureValue = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  measure: ProcessPlantCredibilityMeasurement,
): number => {
  if (measure.kind === 'point') return valueAtOrAfter(telemetry, measure.path, measure.atMs)
  if (measure.kind === 'minAfter') return Math.min(...valuesAfter(telemetry, measure.path, measure.afterMs))
  if (measure.kind === 'maxAfter') return Math.max(...valuesAfter(telemetry, measure.path, measure.afterMs))
  if (measure.kind === 'deltaAbove') return aboveAt(telemetry, measure.path, measure.reference, measure.toMs) - aboveAt(telemetry, measure.path, measure.reference, measure.fromMs)
  if (measure.kind === 'maxApartAfter') {
    const times = seriesFor(telemetry, measure.path).points.filter(point => point.elapsedMs >= measure.afterMs).map(point => point.elapsedMs)
    if (times.length === 0) throw new Error(`missing process plant credibility points for ${measure.path} after ${measure.afterMs}ms`)
    return Math.max(...times.map(elapsedMs => Math.abs(aboveAt(telemetry, measure.path, measure.reference, elapsedMs))))
  }
  return valueAtOrAfter(telemetry, measure.path, measure.toMs) - valueAtOrAfter(telemetry, measure.path, measure.fromMs)
}

const rangeContains = (value: number, range: ProcessPlantCredibilityTargetRange): boolean =>
  (range.min === undefined || value >= range.min)
  && (range.max === undefined || value <= range.max)

export const evaluateProcessPlantCredibilityTarget = <
  TCaseId extends string,
  TSourceRefId extends string,
>(
  trace: ProcessPlantMultiPlantSnapshot,
  target: ProcessPlantCredibilityTarget<TCaseId, TSourceRefId>,
): ProcessPlantCredibilityTargetResult<TCaseId, TSourceRefId> => {
  if (!trace.telemetry) throw new Error(`process plant credibility trace missing telemetry for ${trace.plantId}`)
  const observed = measureValue(trace.telemetry, target.measure)
  return {
    targetId: target.id,
    caseId: target.caseId,
    label: target.label,
    signal: target.signal,
    expectation: target.expectation,
    observed,
    acceptable: target.acceptable,
    passed: rangeContains(observed, target.acceptable),
    severity: target.severity,
    sourceRefs: target.sourceRefs,
  }
}

export const processPlantCredibilityTraceForCase = <TCaseId extends string>(
  traces: ReadonlyArray<ProcessPlantMultiPlantSnapshot>,
  caseId: TCaseId,
): ProcessPlantMultiPlantSnapshot => {
  const trace = traces.find(candidate => candidate.plantId === caseId)
  if (!trace) throw new Error(`missing process plant credibility trace for case: ${caseId}`)
  return trace
}

export const processPlantCredibilityCaseResultSummaries = <
  TCaseId extends string,
  TSourceRefId extends string,
>(
  cases: ReadonlyArray<ProcessPlantCredibilityCaseSummaryInput<TCaseId>>,
  results: ReadonlyArray<ProcessPlantCredibilityTargetResult<TCaseId, TSourceRefId>>,
): ReadonlyArray<ProcessPlantCredibilityCaseResultSummary<TCaseId>> =>
  cases.map(testCase => {
    const caseTargets = results.filter(result => result.caseId === testCase.id)
    return {
      caseId: testCase.id,
      title: testCase.title,
      eventFamily: testCase.eventFamily,
      targetCount: caseTargets.length,
      passedTargetCount: caseTargets.filter(result => result.passed).length,
      failedGateTargetCount: caseTargets.filter(result => !result.passed && result.severity === 'gate').length,
      failedWatchTargetCount: caseTargets.filter(result => !result.passed && result.severity === 'watch').length,
    }
  })

const formatRange = (range: ProcessPlantCredibilityTargetRange): string => {
  if (range.min !== undefined && range.max !== undefined) return `${range.min} to ${range.max}`
  if (range.min !== undefined) return `>= ${range.min}`
  if (range.max !== undefined) return `<= ${range.max}`
  return 'record only'
}

const svgEscape = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

export const renderProcessPlantCredibilityReportSvg = <
  TCaseId extends string,
  TSourceRefId extends string,
>(config: ProcessPlantCredibilityReportConfig<TCaseId, TSourceRefId>): string => {
  const rowHeight = 34
  const grouped = config.cases.map(testCase => ({
    testCase,
    results: config.results.filter(result => result.caseId === testCase.id),
  }))
  const height = 138 + grouped.reduce((total, group) => total + 48 + group.results.length * rowHeight, 0)
  const rows = grouped.map((group, groupIndex) => {
    const groupY = 116 + grouped.slice(0, groupIndex).reduce((total, previous) => total + 48 + previous.results.length * rowHeight, 0)
    const targetRows = group.results.map((result, index) => {
      const y = groupY + 42 + index * rowHeight
      const statusColor = result.passed ? '#15803d' : result.severity === 'gate' ? '#b91c1c' : '#a16207'
      const status = result.passed ? 'PASS' : result.severity === 'gate' ? 'FAIL' : 'WATCH'
      return `
        <g transform="translate(52 ${y})">
          <rect x="0" y="-21" width="1096" height="30" rx="4" fill="${index % 2 === 0 ? '#ffffff' : '#f8fafc'}" stroke="#e5e7eb"/>
          <text x="12" y="-2" font-family="Inter, system-ui, sans-serif" font-size="12" font-weight="700" fill="${statusColor}">${status}</text>
          <text x="82" y="-2" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#111827">${svgEscape(result.label)}</text>
          <text x="590" y="-2" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#475569">obs ${result.observed.toFixed(3)} / target ${svgEscape(formatRange(result.acceptable))}</text>
        </g>`
    }).join('')
    return `
      <g>
        <text x="50" y="${groupY}" font-family="Inter, system-ui, sans-serif" font-size="18" font-weight="800" fill="#111827">${svgEscape(group.testCase.title)}</text>
        <text x="50" y="${groupY + 21}" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#64748b">${svgEscape(group.testCase.eventFamily)}</text>
        ${targetRows}
      </g>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}">
  <rect width="1200" height="${height}" fill="#eef2f7"/>
  <text x="50" y="42" font-family="Inter, system-ui, sans-serif" font-size="26" font-weight="800" fill="#111827">${svgEscape(config.title)}</text>
  <text x="50" y="68" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#475569">${svgEscape(config.subtitle)}</text>
  <text x="50" y="92" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#64748b">${svgEscape(config.scope)}</text>
  ${rows}
</svg>`
}

export const writeProcessPlantCredibilityArtifacts = async (config: {
  readonly summaryJsonPath: string
  readonly reportSvgPath: string
  readonly summary: unknown
  readonly reportSvg: string
}): Promise<void> => {
  await mkdir(dirname(config.summaryJsonPath), { recursive: true })
  await writeFile(config.summaryJsonPath, `${JSON.stringify(config.summary, null, 2)}\n`)
  await writeFile(config.reportSvgPath, config.reportSvg)
}
