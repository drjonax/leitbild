// Resolves a ```leitbild-view fence to the validated envelope kept as
// execution evidence of the answer's own turn. Nothing in the fence is used as
// a URL or as the view itself; the envelope comes from the evidence alone.
import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
import { checkViewEnvelope, type ViewReference } from '../../../core/render-validators/view-fence.ts'

export interface ViewFenceOrigin {
  readonly roomId: string
  readonly turnId: string
  readonly workspaceId: string
}

export type ViewResolution =
  | { readonly kind: 'view'; readonly envelope: EmbeddedViewEnvelope }
  | { readonly kind: 'refused'; readonly code: string; readonly message: string }

type FetchJson = (path: string) => Promise<{ readonly status: number; readonly body: unknown }>

interface EvidenceCall {
  readonly tool?: unknown
  readonly result?: { readonly success?: unknown; readonly data?: { readonly results?: unknown } }
}

export const resolveViewReference = async (ref: ViewReference, origin: ViewFenceOrigin, fetchJson: FetchJson): Promise<ViewResolution> => {
  const path = `/rooms/${encodeURIComponent(origin.roomId)}/executions/${encodeURIComponent(origin.turnId)}/calls/${encodeURIComponent(ref.callId)}`
  const response = await fetchJson(path)
  if (response.status === 404) return { kind: 'refused', code: 'view_evidence_unavailable', message: 'the tool result behind this display is no longer retained' }
  if (response.status !== 200) return { kind: 'refused', code: 'view_evidence_unreadable', message: `reading the display evidence failed with HTTP ${response.status}` }
  const call = response.body as EvidenceCall
  if (call.tool !== 'workspace_call' || call.result?.success !== true || !Array.isArray(call.result.data?.results)) {
    return { kind: 'refused', code: 'view_evidence_mismatch', message: 'the referenced call did not produce a display' }
  }
  const entry = (call.result.data.results as ReadonlyArray<{ readonly key?: unknown; readonly embeddedView?: unknown }>)
    .find(candidate => candidate.key === ref.key)
  if (entry?.embeddedView === undefined) return { kind: 'refused', code: 'view_evidence_mismatch', message: `no display was composed under "${ref.key}"` }
  const checked = checkViewEnvelope(entry.embeddedView, origin.workspaceId)
  return checked.kind === 'view' ? checked : { kind: 'refused', code: checked.code, message: checked.error }
}

export interface ViewResolutionCache<Fence extends { readonly key: string }> {
  /** One resolution per key for the life of the page; the promise never rejects. */
  readonly resolve: (fence: Fence) => Promise<ViewResolution>
}

/**
 * Chips and the display list share these resolutions, so a re-render (room
 * switch, realtime snapshot) neither refetches evidence nor changes what is
 * listed. A failure is kept like a success, so chip and list always agree;
 * reloading the page tries again. A failed read becomes a visible refusal
 * instead of a display that stays "Preparing" forever.
 */
export const createViewResolutionCache = <Fence extends { readonly key: string }>(
  resolve: (fence: Fence) => Promise<ViewResolution>,
): ViewResolutionCache<Fence> => {
  const resolutions = new Map<string, Promise<ViewResolution>>()
  return {
    resolve: fence => {
      const cached = resolutions.get(fence.key)
      if (cached !== undefined) return cached
      const resolution = (async () => resolve(fence))().catch((error: unknown): ViewResolution => ({
        kind: 'refused',
        code: 'view_evidence_unreachable',
        message: `reading the display evidence failed (${error instanceof Error ? error.message : String(error)}); reload the page to try again`,
      }))
      resolutions.set(fence.key, resolution)
      return resolution
    },
  }
}
