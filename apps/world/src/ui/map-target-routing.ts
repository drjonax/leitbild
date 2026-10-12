import type { GeoJsonPoint, ObjectId, OperationalObject } from '../core/model/index.ts'
import type { PackCommandRequest, PackMapTarget, PackTargetContext, PackTargetingContribution, PackTargetPreview } from '../core/packs/protocol.ts'

/**
 * Where a map click goes. Without a map-target panel the generic surface
 * selects controllers and sends the Pack's target command, as it always has;
 * while an open panel declares map targets, every target click for a
 * controller of the panel's own Pack goes to that panel and the surface never
 * sends one. A controller of another Pack keeps the generic path.
 */

/** The open panel declaring map targets, with its handlers once it has connected them. */
export interface MapTargetPanel {
  readonly label: string
  /** The Pack that contributes the panel; it takes orders only for that Pack's controllers. */
  readonly packId: string
  readonly onMapTarget: ((controllerId: ObjectId, target: PackMapTarget) => void) | null
  /** The panel's own hover preview, e.g. from its recommendation cache; null when it connected none. */
  readonly previewMapTarget: ((controllerId: ObjectId, target: PackMapTarget) => PackTargetPreview | null) | null
}

export interface MapClickContext {
  /** The selected controller, if the selection is one. */
  readonly controller: OperationalObject | null
  readonly targeting: PackTargetingContribution | undefined
  readonly context: PackTargetContext
  readonly panel: MapTargetPanel | null
}

export type MapClickRoute =
  | { readonly kind: 'none' }
  | { readonly kind: 'select'; readonly objectId: ObjectId; readonly note: string | null }
  | { readonly kind: 'panel'; readonly controllerId: ObjectId; readonly target: PackMapTarget }
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'send'; readonly command: PackCommandRequest; readonly subject: string }

const none: MapClickRoute = { kind: 'none' }

/** The open map-target panel when it takes this controller's orders: only its own Pack's controllers. */
const panelFor = (panel: MapTargetPanel | null, controller: OperationalObject): MapTargetPanel | null =>
  panel !== null && controller.packId === panel.packId ? panel : null

const toPanel = (panel: MapTargetPanel, controllerId: ObjectId, target: PackMapTarget): MapClickRoute =>
  panel.onMapTarget === null
    ? { kind: 'note', text: `${panel.label} is still loading; map orders wait for it` }
    : { kind: 'panel', controllerId, target }

const previewOf = (click: MapClickContext, controller: OperationalObject, target: PackMapTarget): PackTargetPreview | null =>
  click.targeting?.describeTarget?.(controller, target, click.context) ?? null

/** A refusal the Pack worded is shown; any other non-target click stays as quiet as it always was. */
const notTargeted = (preview: PackTargetPreview | null): MapClickRoute =>
  preview?.refused ? { kind: 'note', text: preview.text } : none

const send = (command: PackCommandRequest, preview: PackTargetPreview | null, subject: string): MapClickRoute =>
  preview?.refused ? { kind: 'note', text: preview.text } : { kind: 'send', command, subject: preview?.text ?? subject }

export const routeObjectClick = (object: OperationalObject, click: MapClickContext): MapClickRoute => {
  const { controller, targeting, context, panel } = click
  if (targeting?.isController(object, context)) {
    return { kind: 'select', objectId: object.id, note: panelFor(panel, object) ? null : `Selected ${object.label}; click a valid target` }
  }
  // With no unit chosen, a click shares the object's selection with the panel instead of ordering anything.
  if (panel && !controller) return { kind: 'select', objectId: object.id, note: null }
  const owningPanel = controller ? panelFor(panel, controller) : null
  if (owningPanel && controller) return toPanel(owningPanel, controller.id, { kind: 'object', objectId: object.id })
  if (!controller || !targeting || object.id === controller.id) return none
  const target: PackMapTarget = { kind: 'object', objectId: object.id }
  const preview = previewOf(click, controller, target)
  if (!targeting.isTarget(controller, object, context)) return notTargeted(preview)
  return send(targeting.buildSetTargetCommand(controller, object, context), preview, `Sending ${controller.label} to ${object.label}`)
}

/** A click on open ground, reported only while a panel or a Pack takes point targets. */
export const routeGroundClick = (point: GeoJsonPoint, click: MapClickContext): MapClickRoute => {
  const { controller, targeting, context, panel } = click
  if (!controller) return none
  const owningPanel = panelFor(panel, controller)
  if (owningPanel) return toPanel(owningPanel, controller.id, { kind: 'point', point })
  const pointTargets = targeting?.pointTargets
  if (!pointTargets) return none
  const preview = previewOf(click, controller, { kind: 'point', point })
  if (!pointTargets.isTarget(controller, point, context)) return notTargeted(preview)
  return send(pointTargets.buildSetTargetCommand(controller, point, context), preview, `Sending ${controller.label} to the map point`)
}

/** Whether open-ground clicks need reporting at all: only a map-target panel or a point-targeting Pack takes them. */
export const groundClicksWanted = (click: Pick<MapClickContext, 'targeting' | 'panel'>): boolean =>
  click.panel !== null || click.targeting?.pointTargets !== undefined

/** Whether hovered objects can show an order preview: a panel connected one, or a Pack describes targets. */
export const targetPreviewsWanted = (click: Pick<MapClickContext, 'targeting' | 'panel'>): boolean =>
  click.panel?.previewMapTarget != null || click.targeting?.describeTarget !== undefined

/**
 * The preview a hovered object shows while a controller is selected. The
 * panel that takes the controller's orders answers when it connected a
 * preview; otherwise the Pack's describeTarget does, when it has one.
 */
export const previewObjectTarget = (object: OperationalObject, click: MapClickContext): PackTargetPreview | null => {
  const { controller, targeting, context, panel } = click
  if (!controller || object.id === controller.id) return null
  if (targeting?.isController(object, context)) return null
  const target: PackMapTarget = { kind: 'object', objectId: object.id }
  const previewMapTarget = panelFor(panel, controller)?.previewMapTarget
  if (previewMapTarget) return previewMapTarget(controller.id, target)
  return targeting?.describeTarget?.(controller, target, context) ?? null
}

/** What one map click amounts to, decided once every layer has seen it. */
export type MapClickOutcome = 'suppressed' | 'assignment-cancel' | 'handled' | 'ground'

export interface MapClickMarks {
  /** A long press, a hold-gesture target or an assignment handle consumed the click. */
  readonly suppressed: boolean
  /** The hold-gesture assignment is armed: any other click cancels it, and is never also a ground click. */
  readonly assignmentActive: boolean
  /** An object, a label, a Pack feature or a handle took the click. */
  readonly handled: boolean
}

export const mapClickOutcome = (marks: MapClickMarks): MapClickOutcome => {
  if (marks.suppressed) return 'suppressed'
  if (marks.assignmentActive) return 'assignment-cancel'
  return marks.handled ? 'handled' : 'ground'
}
