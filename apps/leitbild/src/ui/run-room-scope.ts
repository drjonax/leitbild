import type {
  ModuleResourceDescriptor,
  WorkspaceResourceReference,
  WorkspaceRoomScope,
} from '@leitbild/contracts'

export const sameResource = (left: WorkspaceResourceReference, right: WorkspaceResourceReference): boolean =>
  left.workspaceId === right.workspaceId
  && left.moduleId === right.moduleId
  && left.type === right.type
  && left.id === right.id

export const runFamilyFor = (run: ModuleResourceDescriptor): WorkspaceResourceReference | undefined =>
  run.links.find(link => link.rel === 'member-of' && link.ref.type === 'world.run-family')?.ref

export const roomUsesFamily = (room: ModuleResourceDescriptor, family: WorkspaceResourceReference): boolean =>
  room.links.some(link => link.rel === 'scope-collection' && sameResource(link.ref, family))

/**
 * A Room's scope kind as its catalog links publish it. Agents publishes no
 * scope link for a Workspace scope, one `scope-resource` link for a Resource
 * scope and a `scope-collection` link (with member or excluded links) for a
 * collection scope. Any other `scope-*` link counts as a collection scope, so
 * a Room whose links are not understood selects no Run rather than every Run.
 */
export const roomScopeKind = (room: ModuleResourceDescriptor): WorkspaceRoomScope['kind'] => {
  const scope = room.links.filter(link => link.rel.startsWith('scope-'))
  if (scope.length === 0) return 'workspace'
  return scope.some(link => link.rel === 'scope-resource') ? 'resource' : 'collection'
}

/** Whether a Room may serve beside this Run: its scope must contain the Run. */
export const roomSelectsRun = (room: ModuleResourceDescriptor, run: ModuleResourceDescriptor): boolean => {
  if (room.ref.workspaceId !== run.ref.workspaceId) return false
  const kind = roomScopeKind(room)
  if (kind === 'workspace') return true
  if (kind === 'resource') return room.links.some(link => link.rel === 'scope-resource' && sameResource(link.ref, run.ref))
  const family = runFamilyFor(run)
  if (!family || !roomUsesFamily(room, family)) return false
  const selected = room.links.filter(link => link.rel === 'scope-member')
  if (selected.length > 0) return selected.some(link => sameResource(link.ref, run.ref))
  return !room.links.some(link => link.rel === 'scope-excluded' && sameResource(link.ref, run.ref))
}

export const roomScopeIncludingRun = (
  room: ModuleResourceDescriptor,
  family: WorkspaceResourceReference,
  run: WorkspaceResourceReference,
): WorkspaceRoomScope => {
  const selected = room.links.filter(link => link.rel === 'scope-member').map(link => link.ref)
  if (selected.length > 0) {
    return {
      kind: 'collection',
      collection: family,
      members: { mode: 'selected', only: selected.some(ref => sameResource(ref, run)) ? selected : [...selected, run] },
    }
  }
  return {
    kind: 'collection',
    collection: family,
    members: {
      mode: 'all',
      except: room.links.filter(link => link.rel === 'scope-excluded' && !sameResource(link.ref, run)).map(link => link.ref),
    },
  }
}
