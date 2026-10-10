export type AuditCheckStatus = 'pass' | 'fail' | 'not-measurable'
export type AuditVerdict = 'pass' | 'fail' | 'incomplete'

export interface AuditFailure {
  readonly message: string
  /** Exact model asset ids (or golden/curation/NVE ids) the failure is about. */
  readonly assetIds: ReadonlyArray<string>
}

export type AuditMetricValue = number | ReadonlyArray<number>

export interface AuditCheck {
  readonly id: string
  readonly title: string
  readonly status: AuditCheckStatus
  readonly summary: string
  readonly metrics: Readonly<Record<string, AuditMetricValue>>
  readonly failures: ReadonlyArray<AuditFailure>
  /** Present when the model lacks data the check needs (status not-measurable, or partial). */
  readonly unmeasured?: string
}

export type CurationStatusKind = 'applied' | 'unused' | 'expired' | 'violated'

export interface CurationStatus {
  readonly id: string
  readonly kind: string
  readonly status: CurationStatusKind
  readonly reasons: ReadonlyArray<string>
}

export interface GridAuditReport {
  readonly modelId: string
  readonly modelKind: 'grid-model-v1' | 'grid-model-v2'
  readonly goldenId: string
  readonly asOf: string
  readonly verdict: AuditVerdict
  readonly counts: {
    readonly buses: number
    readonly branches: number
    readonly hvdcLinks: number
    readonly generators: number
    readonly loads: number
  }
  readonly oracles: { readonly nveCoverage: 'supplied' | 'not-supplied' }
  readonly checks: ReadonlyArray<AuditCheck>
  readonly curations: ReadonlyArray<CurationStatus>
}

export const checkStatus = (failed: boolean, unmeasured: string | undefined): AuditCheckStatus =>
  failed ? 'fail' : unmeasured === undefined ? 'pass' : 'not-measurable'

export const verdictOf = (checks: ReadonlyArray<AuditCheck>): AuditVerdict =>
  checks.some(check => check.status === 'fail')
    ? 'fail'
    : checks.some(check => check.status === 'not-measurable') ? 'incomplete' : 'pass'
