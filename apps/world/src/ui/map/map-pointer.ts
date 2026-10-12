import type { OperationalObject } from '../../core/model/index.ts'

/**
 * What the map does with the pointer it last saw. Hover cards, target
 * previews and the long press are mouse gestures. A touch screen follows a
 * tap with a compatibility mousemove: shown a hover card for it, WebKit drops
 * the tap's click because content appeared, and the object it leaves hovered
 * is stale by the next press. So the map tracks the type of the last pointer
 * it saw (`PointerEvent.pointerType`), and before any it shows nothing on
 * hover.
 */

/** Whether a hover over an object shows its card and target preview: only for a mouse. */
export const hoverCardsFor = (pointerType: string | null): boolean => pointerType === 'mouse'

export interface MapPress {
  readonly pointerType: string
  readonly button: number
  /** The object under the mouse when the press began. */
  readonly hovered: OperationalObject | null
  /** A placement or a map assignment is under way: a press belongs to it. */
  readonly busy: boolean
  /** Whether a long press on the object starts its Pack's map assignment: only when that Pack declares one. */
  readonly canLongPress: (object: OperationalObject) => boolean
}

/**
 * The object a press arms the long press for, or null: a primary mouse press
 * on a hovered object whose Pack takes a long press, while nothing else is
 * under way. Any other press is a plain tap or click, whose click is never
 * swallowed by a long press it could not see.
 */
export const longPressObject = (press: MapPress): OperationalObject | null => {
  if (press.busy || press.button !== 0 || press.pointerType !== 'mouse' || press.hovered === null) return null
  return press.canLongPress(press.hovered) ? press.hovered : null
}
