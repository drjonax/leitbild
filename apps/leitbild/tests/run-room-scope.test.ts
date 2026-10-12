import { describe, expect, test } from 'bun:test'
import { moduleResourceDescriptorSchema, newWorkspaceId, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { roomScopeIncludingRun, roomScopeKind, roomSelectsRun, roomServesRun, runDeclaresRoles, sameResource } from '../src/ui/run-room-scope.ts'

const workspaceId = newWorkspaceId()
const observedAt = new Date().toISOString()
const runRef = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'shared-id' })
const familyRef = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.run-family', id: 'shared-id' })
const run = moduleResourceDescriptorSchema.parse({
  ref: runRef,
  title: 'Original',
  links: [{ rel: 'member-of', ref: familyRef }],
  capabilityIds: [], summary: [], observedAt,
})
const room = (subjectLinks: unknown[], inWorkspace: string = workspaceId) => moduleResourceDescriptorSchema.parse({
  ref: { workspaceId: inWorkspace, moduleId: 'agents', type: 'agents.room', id: crypto.randomUUID() },
  title: 'Assistant', links: subjectLinks, capabilityIds: [], summary: [], observedAt,
})
const agentLink = { rel: 'member', ref: { workspaceId, moduleId: 'agents', type: 'agents.agent', id: 'assistant' } }

describe('Run Room scope', () => {
  test('a Workspace-scoped Room selects every Run of its Workspace, not of another', () => {
    const workspaceRoom = room([agentLink])
    expect(roomScopeKind(workspaceRoom)).toBe('workspace')
    expect(roomSelectsRun(workspaceRoom, run)).toBe(true)
    const unrelated = moduleResourceDescriptorSchema.parse({ ...run, ref: { ...run.ref, id: 'unrelated' }, links: [] })
    expect(roomSelectsRun(workspaceRoom, unrelated)).toBe(true)
    expect(roomSelectsRun(room([], newWorkspaceId()), run)).toBe(false)
  })

  test('a Resource-scoped Room selects exactly the Run it names', () => {
    const runRoom = room([{ rel: 'scope-resource', ref: runRef }, agentLink])
    expect(roomScopeKind(runRoom)).toBe('resource')
    expect(roomSelectsRun(runRoom, run)).toBe(true)
    const sibling = moduleResourceDescriptorSchema.parse({ ...run, ref: { ...run.ref, id: 'sibling' } })
    expect(roomSelectsRun(runRoom, sibling)).toBe(false)
    // The family shares the Run's id but is another Resource, so it selects nothing here.
    expect(roomSelectsRun(room([{ rel: 'scope-resource', ref: familyRef }]), run)).toBe(false)
  })

  test('scope links it does not understand select no Run', () => {
    const malformed = room([{ rel: 'scope-member', ref: runRef }])
    expect(roomScopeKind(malformed)).toBe('collection')
    expect(roomSelectsRun(malformed, run)).toBe(false)
  })

  test('compares complete Resource identity when family and original share an id', () => {
    expect(sameResource(run.ref, familyRef)).toBe(false)
    expect(roomSelectsRun(room([{ rel: 'scope-collection', ref: familyRef }]), run)).toBe(true)
  })

  test('supports dynamic all-except and fixed selected-only links', () => {
    expect(roomSelectsRun(room([
      { rel: 'scope-collection', ref: familyRef },
      { rel: 'scope-excluded', ref: runRef },
    ]), run)).toBe(false)
    expect(roomSelectsRun(room([
      { rel: 'scope-collection', ref: familyRef },
      { rel: 'scope-member', ref: runRef },
    ]), run)).toBe(true)
  })

  test('explicit reopening restores one excluded Run without changing future-copy policy', () => {
    const other = workspaceResourceReferenceSchema.parse({ ...run.ref, id: 'other' })
    const dynamicRoom = room([
      { rel: 'scope-collection', ref: familyRef },
      { rel: 'scope-excluded', ref: run.ref },
      { rel: 'scope-excluded', ref: other },
    ])
    expect(roomScopeIncludingRun(dynamicRoom, familyRef, run.ref)).toEqual({
      kind: 'collection',
      collection: familyRef,
      members: { mode: 'all', except: [other] },
    })

    const fixedRoom = room([
      { rel: 'scope-collection', ref: familyRef },
      { rel: 'scope-member', ref: other },
    ])
    expect(roomScopeIncludingRun(fixedRoom, familyRef, run.ref)).toEqual({
      kind: 'collection',
      collection: familyRef,
      members: { mode: 'selected', only: [other, run.ref] },
    })
  })
})

describe('Run Assistant', () => {
  test('a Run whose summary publishes roles offers no Run Assistant; a Run without roles does', () => {
    const roleRun = moduleResourceDescriptorSchema.parse({ ...run, summary: [{ key: 'roles', label: 'Roles', kind: 'count', value: 6 }] })
    expect(runDeclaresRoles(roleRun)).toBe(true)
    // A Controller and four groups: World counts the roles derived from groups (einsatz-registration.test.ts).
    const groupRun = moduleResourceDescriptorSchema.parse({ ...run, summary: [{ key: 'viewer-count', label: 'Viewers', kind: 'count', value: 0 }, { key: 'roles', label: 'Roles', kind: 'count', value: 5 }] })
    expect(runDeclaresRoles(groupRun)).toBe(true)
    expect(runDeclaresRoles(run)).toBe(false)
    const viewers = moduleResourceDescriptorSchema.parse({ ...run, summary: [{ key: 'viewer-count', label: 'Viewers', kind: 'count', value: 2 }] })
    expect(runDeclaresRoles(viewers)).toBe(false)
  })

  test('no Room stays beside a role Run, not even a Workspace-scoped Room that selects every Run', () => {
    const roleRun = moduleResourceDescriptorSchema.parse({ ...run, summary: [{ key: 'roles', label: 'Roles', kind: 'count', value: 5 }] })
    // The Workspace Assistant, or ?agents=<room> in the URL, names a Room whose scope is the Workspace.
    const workspaceRoom = room([agentLink])
    expect(roomScopeKind(workspaceRoom)).toBe('workspace')
    expect(roomSelectsRun(workspaceRoom, roleRun)).toBe(true)
    expect(roomServesRun(workspaceRoom, roleRun)).toBe(false)
    expect(roomServesRun(room([{ rel: 'scope-resource', ref: runRef }, agentLink]), roleRun)).toBe(false)
    expect(roomServesRun(room([{ rel: 'scope-collection', ref: familyRef }]), roleRun)).toBe(false)
    // A Run without roles keeps the Rooms whose scope contains it, and only those.
    expect(roomServesRun(workspaceRoom, run)).toBe(true)
    expect(roomServesRun(room([{ rel: 'scope-collection', ref: familyRef }, { rel: 'scope-excluded', ref: runRef }]), run)).toBe(false)
  })
})
