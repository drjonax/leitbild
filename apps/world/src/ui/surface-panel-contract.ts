import type { RunRoles } from '../core/model/index.ts'

/**
 * The parts of the surface panel contract that name no browser type, so Pack
 * code that lays a panel out or reads its roles can be typechecked and run
 * without a DOM.
 */

/** How far a panel reaches over the map from each edge, in CSS pixels. */
export interface MapCover {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

/** The role set a screen plays in a Run that declares roles, with the Run's declaration. */
export interface PanelRoleSet {
  readonly declaration: RunRoles
  readonly roleIds: ReadonlyArray<string>
}
