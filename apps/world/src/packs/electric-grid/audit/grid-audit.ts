import type { GridCurationCollection } from '../schemas/grid-curation.ts'
import type { GridGolden } from '../schemas/grid-golden.ts'
import type { AuditGraph } from './audit-graph.ts'
import { createAuditContext, isLine, type AuditContext } from './audit-context.ts'
import { checkStatus, verdictOf, type AuditCheck, type GridAuditReport } from './audit-report.ts'
import { curationStatuses, curationsCheck } from './curation-checks.ts'
import { goldenCorridorsCheck, goldenExcludedCorridorsCheck, goldenInterconnectorsCheck, goldenSubstationsCheck } from './golden-checks.ts'
import { attachmentCheck, generationCheck, loadCheck } from './inventory-checks.ts'
import { measureNveCoverage, type NveLine } from './nve-coverage.ts'
import {
  backboneRadialChecks,
  componentsCheck,
  offTerminalEndsCheck,
  parallelDuplicateCheck,
  voltageMismatchCheck,
} from './topology-checks.ts'

export interface GridAuditOptions {
  /** ISO date the review-by expiries are judged against. */
  readonly asOf: string
  readonly curations: GridCurationCollection
  /** Pre-fetched NVE Nettanlegg5 lines; the coverage check runs only when supplied. */
  readonly nveLines?: ReadonlyArray<NveLine>
}

/** Lowest model line voltage, as a fraction of the NVE floor, that may cover an NVE line. */
const coveringVoltageFraction = 0.9

const nveCoverageCheck = (context: AuditContext, nveLines: ReadonlyArray<NveLine>): AuditCheck => {
  const settings = context.golden.thresholds.nveCoverage
  const lines = context.graph.branches.filter(branch => isLine(branch)
    && branch.curationIds.length === 0
    && branch.nominalKv >= settings.minKv * coveringVoltageFraction)
  const withoutGeometry = lines.filter(branch => branch.geometry === undefined)
  const coverage = measureNveCoverage(nveLines, lines.flatMap(branch => branch.geometry ?? []), settings)
  const share = coverage.totalKm === 0 ? 0 : coverage.uncoveredKm / coverage.totalKm
  const failed = coverage.lineCount === 0 || share > settings.maxUncoveredShare
  const unmeasured = withoutGeometry.length > 0 ? `${withoutGeometry.length} of ${lines.length} model lines lack reference geometry` : undefined
  return {
    id: 'nve-coverage',
    title: `NVE Nettanlegg5 ≥${settings.minKv} kV lines within ${settings.bufferKm * 1000} m of model lines`,
    status: checkStatus(failed, unmeasured),
    summary: `${coverage.uncoveredKm.toFixed(1)} of ${coverage.totalKm.toFixed(1)} NVE km uncovered (${(share * 100).toFixed(2)} %, max ${(settings.maxUncoveredShare * 100).toFixed(2)} %)`,
    metrics: { nveLines: coverage.lineCount, nveKm: coverage.totalKm, uncoveredKm: coverage.uncoveredKm, uncoveredShare: share, linesWithoutGeometry: withoutGeometry.length },
    failures: [
      ...(coverage.lineCount === 0 ? [{ message: `no NVE line at or above ${settings.minKv} kV was supplied`, assetIds: [] }] : []),
      ...coverage.lines.filter(line => line.uncoveredKm > 0).map(line => ({
        message: `NVE ${line.name ?? 'unnamed line'} (${line.voltageKv} kV): ${line.uncoveredKm.toFixed(2)} of ${line.lengthKm.toFixed(2)} km without a model line`,
        assetIds: [`nve:${line.globalId}`],
      })),
    ],
    ...(unmeasured === undefined ? {} : { unmeasured }),
  }
}

export const auditGridTopology = (graph: AuditGraph, golden: GridGolden, options: GridAuditOptions): GridAuditReport => {
  const context = createAuditContext(graph, golden, options.curations, options.asOf)
  const statuses = curationStatuses(context)
  const checks: AuditCheck[] = [
    componentsCheck(context),
    ...backboneRadialChecks(context),
    voltageMismatchCheck(context),
    parallelDuplicateCheck(context),
    offTerminalEndsCheck(context),
    attachmentCheck(context),
    generationCheck(context),
    loadCheck(context),
    goldenSubstationsCheck(context),
    goldenCorridorsCheck(context),
    goldenExcludedCorridorsCheck(context),
    goldenInterconnectorsCheck(context),
    curationsCheck(context, statuses),
    ...(options.nveLines === undefined ? [] : [nveCoverageCheck(context, options.nveLines)]),
  ]
  return {
    modelId: graph.modelId,
    modelKind: graph.modelKind,
    goldenId: golden.id,
    asOf: options.asOf,
    verdict: verdictOf(checks),
    counts: {
      buses: graph.buses.length,
      branches: graph.branches.length,
      hvdcLinks: graph.hvdcLinks.length,
      generators: graph.generators.length,
      loads: graph.loads.length,
    },
    oracles: { nveCoverage: options.nveLines === undefined ? 'not-supplied' : 'supplied' },
    checks,
    curations: statuses,
  }
}
