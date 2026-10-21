import type { MimicDrawnItem } from '../../../../packs/process-plant/displays/mimic/mimic-model.ts'
import type { Box } from '../../vignette/popover.ts'

// Where an operated item's badges stand (plan §4.3, QA-20): inside the box
// the layout already gave its symbol, so badges never move anything. A
// device's stand in the two corners of its 48 px symbol away from its text
// stack (OpenBridge's badge slots, with no badge spacer); a vessel's in the
// top corners of its box. Who acts on it takes one corner, two badges wide
// for a person's approval of an AI proposal; what holds it the other.

/** OpenBridge's automation badge at its larger size, in px. */
export const BADGE = 20

/** The OpenBridge badge slots of a device's two corners away from its text. */
export const deviceBadgeCorners = (textSide: 'right' | 'bottom'): { readonly who: 'badge-top-left'; readonly hold: 'badge-top-right' | 'badge-bottom-left' } =>
  textSide === 'bottom' ? { who: 'badge-top-left', hold: 'badge-top-right' } : { who: 'badge-top-left', hold: 'badge-bottom-left' }

/** Where a vessel's badges stand: its box, or the span of it a reactor vessel is drawn in (MimicVesselDrawing.span). */
export const vesselBadgeBox = (item: MimicDrawnItem): Box =>
  item.vessel === undefined ? item.box : { x: item.box.x + item.vessel.span.x, y: item.box.y, width: item.vessel.span.width, height: item.box.height }

/** The room an item's badges take at most, in the drawing's px: who acts on it (two badges wide) and what holds it. */
export const badgeRoom = (item: MimicDrawnItem): ReadonlyArray<Box> => {
  const { x, y, width, height } = item.presentation.element === 'device' ? item.box : vesselBadgeBox(item)
  const who = { x, y, width: 2 * BADGE, height: BADGE }
  if (item.presentation.element !== 'device') return [who, { x: x + width - BADGE, y, width: BADGE, height: BADGE }]
  return deviceBadgeCorners(item.text?.side === 'bottom' ? 'bottom' : 'right').hold === 'badge-top-right'
    ? [who, { x: x + width - BADGE, y, width: BADGE, height: BADGE }]
    : [who, { x, y: y + height - BADGE, width: BADGE, height: BADGE }]
}
