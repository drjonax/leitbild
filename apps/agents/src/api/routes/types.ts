import type { AgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import type { Agent } from '../../core/types/agent.ts'
import type { WSOutbound } from '../../core/types/ws-protocol.ts'
import type { AccessContext, WorkspaceId } from '@leitbild/contracts'
import type { PackManager } from '../../packs/manager.ts'
import type { RoomDefinitionLibrary } from '../../core/definitions/room-definition-library.ts'
import type { PeopleStatus } from '../../core/workspaces/runtime-registry.ts'

// Read-only health snapshot used by /system/diagnostics. Walks the
// registry + wsManager to surface per-Workspace broadcast wiring state.
// Catches the silent-skip class of bug fixed in 5d73a8e: zero-broadcast
// Workspaces under live traffic mean the wiring chain is broken somewhere.
export interface DiagnosticsCapability {
  readonly snapshot: () => {
    readonly workspaces: ReadonlyArray<{
      readonly id: WorkspaceId
      readonly wired: boolean
      readonly agentCount: number
      readonly generatingAgentCount: number
      readonly lastBroadcastAt: number | null
    }>
    readonly wsSessions: number
    readonly configuredIdleMs?: number
    readonly maxLoadedWorkspaces?: number
    // Aggregate People counters and gauges; never names, text or tokens.
    readonly people?: PeopleStatus
  }
}

export interface RouteContext {
  readonly system: AgentsWorkspaceRuntime
  readonly accessContext: AccessContext
  // Workspace bound to this request by the application URL.
  readonly workspaceId: WorkspaceId
  // Deployment-wide catalogs only (Packs, Scripts, Providers).
  readonly broadcastAllWorkspaces: (msg: WSOutbound) => void
  readonly broadcastToWorkspace: (workspaceId: WorkspaceId, msg: WSOutbound) => void
  readonly packManager: PackManager
  readonly roomDefinitions: RoomDefinitionLibrary
  readonly subscribeAgentState: (agent: Agent, workspaceId: WorkspaceId) => void
  readonly unsubscribeAgentState?: (agentId: string) => void
  readonly remoteAddress?: string
  // Read-only health/wiring snapshot. Wired in bootstrap.
  readonly diagnostics?: DiagnosticsCapability
}

export interface RouteEntry {
  readonly method: string
  readonly pattern: RegExp
  readonly handler: (req: Request, match: RegExpMatchArray, ctx: RouteContext) => Promise<Response> | Response
}
