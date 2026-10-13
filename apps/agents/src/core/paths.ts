// ============================================================================
// Filesystem layout — one source of truth for every persistent path Leitbild
// uses on disk. Paths are functions (not constants) so LEITBILD_HOME can be
// overridden per-test or per-deploy, including in tests that mock homedir().
//
// Layout:
//   $LEITBILD_HOME/                              ← global / shared
//     providers.json                            ← provider keys + order
//     packs/<namespace>/                        ← installed Packs
//     authoring/                                ← deployment-authored content
//       tools/                                  ← drop-in TS tools
//       skills/<name>/                          ← drop-in skills
//       scripts/*.md                            ← drop-in scripts
//       geodata/<category>.geojson              ← user-paste geodata
//     geodata/.bundled/<version>/               ← cached leitbild-geodata snapshot (NOT user data)
//     knowledge/                                ← shared knowledge files
//     logs/admin.jsonl                          ← janitor + registry events
//     workspaces/                               ← Workspace-scoped Module state
//       <workspace-id>/
//         agents/                              ← Agents Module state
//           workspace.json                     ← Module marker
//           snapshot.json                      ← Agent profiles and runtime state
//           generation-inspections.json         ← opt-in prompt/tool inspection archive
//           people.sqlite                      ← People, direct messages, read markers
//           rooms/                             ← Rooms, messages, membership
//
// LEITBILD_HOME defaults to ~/.leitbild.
// ============================================================================

import { homedir } from 'node:os'
import { join } from 'node:path'
import { workspaceIdSchema, type WorkspaceId } from '@leitbild/contracts'

export const leitbildHome = (): string =>
  process.env.LEITBILD_HOME && process.env.LEITBILD_HOME.length > 0
    ? process.env.LEITBILD_HOME
    : join(homedir(), '.leitbild')

// Shared (global) paths — registries, configs, packs dirs.
//
// Authored content is not a Pack and is never governed by Room Pack activation.
const authoringRoot = (): string => join(leitbildHome(), 'authoring')

export const sharedPaths = {
  root: (): string => leitbildHome(),
  providers: (): string => join(leitbildHome(), 'providers.json'),
  packs: (): string => join(leitbildHome(), 'packs'),
  skills: (): string => join(authoringRoot(), 'skills'),
  scripts: (): string => join(authoringRoot(), 'scripts'),
  tools: (): string => join(authoringRoot(), 'tools'),
  knowledge: (): string => join(leitbildHome(), 'knowledge'),
  geodata: (): string => join(authoringRoot(), 'geodata'),
  adminLog: (): string => join(leitbildHome(), 'logs', 'admin.jsonl'),
  workspacesRoot: (): string => join(leitbildHome(), 'workspaces'),
}

export interface RoomsWorkspacePaths {
  readonly root: string
  readonly marker: string
  readonly snapshot: string
  readonly logs: string
  readonly documents: string
}

export interface AgentsWorkspacePaths {
  readonly root: string
  readonly marker: string
  readonly snapshot: string
  readonly inspections: string
  readonly executions: string
  readonly people: string
  readonly memory: string
  readonly vectors: string
}

export interface WorkspaceModulePaths {
  readonly root: string
  readonly rooms: RoomsWorkspacePaths
  readonly agents: AgentsWorkspacePaths
}

export const workspaceModulePaths = (id: WorkspaceId): WorkspaceModulePaths => {
  assertValidWorkspaceId(id)
  const root = join(leitbildHome(), 'workspaces', id)
  const agentsRoot = join(root, 'agents')
  const roomsRoot = join(agentsRoot, 'rooms')
  return {
    root,
    rooms: {
      root: roomsRoot,
      marker: join(roomsRoot, 'workspace.json'),
      snapshot: join(roomsRoot, 'snapshot.json'),
      logs: join(roomsRoot, 'logs'),
      documents: join(roomsRoot, 'documents'),
    },
    agents: {
      root: agentsRoot,
      marker: join(agentsRoot, 'workspace.json'),
      snapshot: join(agentsRoot, 'snapshot.json'),
      inspections: join(agentsRoot, 'generation-inspections.json'),
      executions: join(agentsRoot, 'executions.sqlite'),
      people: join(agentsRoot, 'people.sqlite'),
      memory: join(agentsRoot, 'memory'),
      vectors: join(agentsRoot, 'vectors.jsonl'),
    },
  }
}

export const isValidWorkspaceId = (id: string): id is WorkspaceId =>
  workspaceIdSchema.safeParse(id).success

// Defense-in-depth: throws if a caller bypassed the boundary check. Cheap
// guard that prevents accidental path traversal if a future call site
// forgets to validate before constructing Workspace paths.
export const assertValidWorkspaceId: (id: string) => asserts id is WorkspaceId = (id) => {
  workspaceIdSchema.parse(id)
}
