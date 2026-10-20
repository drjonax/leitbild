import type { MapCover } from '../surface-panel-contract.ts'
import { noMapCover } from '../surface-panel-interaction.ts'

/**
 * How far the floating grid panel reaches over the map: from the side its frame stands on (the half its
 * centre lies in) to its far edge. A full-height panel covers that side for the camera and for the alarm
 * strip, which keeps clear of declared covers; nothing is drawn before the frame exists.
 */
export const gridPanelMapCover = (frame: { readonly left: number; readonly width: number } | null, parentWidth: number): MapCover => {
  if (frame === null) return noMapCover
  return frame.left + frame.width / 2 >= parentWidth / 2
    ? { ...noMapCover, right: Math.max(0, Math.ceil(parentWidth - frame.left)) }
    : { ...noMapCover, left: Math.ceil(frame.left + frame.width) }
}
