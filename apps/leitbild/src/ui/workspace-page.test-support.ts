// Catalogue fixtures for the Workspace page tests, valid against the contracts.

import {
  moduleCapabilityDescriptorSchema,
  moduleDefinitionDescriptorSchema,
  moduleFeaturedDefinitionSchema,
  moduleResourceDescriptorSchema,
  type ModuleCapabilityDescriptor,
  type ModuleDefinitionDescriptor,
  type ModuleFeaturedDefinition,
  type ModuleResourceDescriptor,
} from '@leitbild/contracts'

export const WS = '0b4b9a52-2f7e-4c1a-9d3e-00000000000a'
export const revision = (letter: string): string => `revision-${letter.repeat(32)}`

export const startCapability: ModuleCapabilityDescriptor = moduleCapabilityDescriptorSchema.parse({
  id: 'world.scenario.start', moduleId: 'world', kind: 'command', scope: { kind: 'definition', definitionType: 'world.scenario' },
  title: 'Start', description: 'Start a run', risk: 'write', idempotent: false,
  inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object' },
})

export const scenario = (id: string, overrides: Partial<{ title: string; description: string; currentRevisionId: string; primary: boolean }> = {}): ModuleDefinitionDescriptor =>
  moduleDefinitionDescriptorSchema.parse({
    ref: { workspaceId: WS, moduleId: 'world', type: 'world.scenario', id },
    title: overrides.title ?? id,
    ...(overrides.description === undefined ? {} : { description: overrides.description }),
    currentRevisionId: overrides.currentRevisionId ?? revision('a'),
    capabilityIds: [startCapability.id],
    ...(overrides.primary === false ? {} : { primaryCapabilityId: startCapability.id }),
  })

export const featured = (id: string, revisionId = revision('a')): ModuleFeaturedDefinition => moduleFeaturedDefinitionSchema.parse({
  definition: { moduleId: 'world', type: 'world.scenario', id },
  revisionId,
  title: `Featured ${id}`,
  summary: 'One sentence.',
  about: 'Several sentences.',
  tags: ['Power grid', 'Desktop'],
  previews: [{
    alt: 'A map of the grid.', width: 1600, height: 1000,
    sources: [{ path: `/assets/world/scenario-previews/${id}-1600.webp`, width: 1600 }, { path: `/assets/world/scenario-previews/${id}-960.webp`, width: 960 }],
  }],
})

export const run = (id: string, status: string, startedAt: string, extra: Partial<{ uiPath: string | null }> = {}): ModuleResourceDescriptor =>
  moduleResourceDescriptorSchema.parse({
    ref: { workspaceId: WS, moduleId: 'world', type: 'world.simulation-run', id },
    title: `Run ${id}`,
    ...(extra.uiPath === null ? {} : { uiPath: extra.uiPath ?? `/workspaces/${WS}/world/runs/${id}` }),
    capabilityIds: [],
    summary: [
      { key: 'started-at', label: 'Started', kind: 'timestamp', value: startedAt },
      { key: 'status', label: 'Status', kind: 'status', value: status },
      { key: 'viewer-count', label: 'Viewers', kind: 'count', value: 1 },
      { key: 'object-count', label: 'Objects', kind: 'count', value: 40 },
    ],
    observedAt: '2026-10-12T22:00:00.000Z',
  })

export const room = (id: string, lastActivity: string): ModuleResourceDescriptor => moduleResourceDescriptorSchema.parse({
  ref: { workspaceId: WS, moduleId: 'agents', type: 'agents.room', id },
  title: `Room ${id}`,
  uiPath: `/workspaces/${WS}/agents?room=${id}`,
  capabilityIds: [],
  summary: [
    { key: 'created-at', label: 'Created', kind: 'timestamp', value: '2026-10-12T20:00:00.000Z' },
    { key: 'status', label: 'Status', kind: 'status', value: 'Paused' },
    { key: 'scope-revision', label: 'Scope revision', kind: 'count', value: 0 },
    { key: 'message-count', label: 'Messages', kind: 'count', value: 6 },
    { key: 'last-activity-at', label: 'Last activity', kind: 'timestamp', value: lastActivity },
  ],
  observedAt: '2026-10-12T22:00:00.000Z',
})
