import { viewerForRoleSet, type RunViewer } from '../../../core/model/index.ts'
import type { PanelRoleSet } from '../../../ui/surface-panel-interaction.ts'
import { openModeViewer, type PictureRole, type PictureViewer } from '../picture.ts'

/**
 * The screen's viewer as the shared picture rules read it: the role view
 * core gives the screen (its class and the union of its roles' `sees`) with
 * each held role as the Run declares it, in declaration order. A screen of a
 * Run without roles plays open mode.
 */

/** A role view as core stamps it, with each held role looked up in the Run's declared roles; open mode without one. */
export const pictureViewerOf = (declared: ReadonlyArray<PictureRole>, viewer: RunViewer | undefined): PictureViewer => {
  if (viewer === undefined) return openModeViewer
  return {
    class: viewer.class,
    sees: viewer.sees,
    roles: viewer.roleIds.map(roleId => {
      const role = declared.find(entry => entry.id === roleId)
      if (role === undefined) throw new Error(`The screen holds role ${roleId}, which the Run does not declare`)
      return role
    }),
  }
}

/** The viewer of the screen playing a role set, or open mode in a Run without roles. */
export const screenViewerFor = (roleSet: PanelRoleSet | null): PictureViewer =>
  roleSet === null ? openModeViewer : pictureViewerOf(roleSet.declaration.roles, viewerForRoleSet(roleSet.declaration, roleSet.roleIds))
