// One vignette row in px: the OpenBridge grid. The composer counts rows; the display Capability sizes a frame from them.
export const VIGNETTE_ROW_PX = 24

/** The views of a set that fill the frame they are given: their table scrolls inside it rather than set its height. */
const FILLING_VIEWS: ReadonlySet<string> = new Set(['fleet', 'compare'])

/**
 * Whether a vignette fills its frame (a generated display, drawn for the room the window gives it) rather than being
 * as tall as its rows (advice): every view is a fleet or a comparison. Read from its state, as the frame mounts.
 */
export const fillsFrame = (state: string): boolean => {
  const views = (JSON.parse(state) as { readonly views?: ReadonlyArray<{ readonly kind?: unknown }> }).views ?? []
  return views.length > 0 && views.every(view => typeof view.kind === 'string' && FILLING_VIEWS.has(view.kind))
}

/**
 * Whether a view's sections stand beside its flow drawing: only where the drawing is drawn. Without its drawings (an
 * element's pop-over) a view stacks its sections at the width it is given, never in the window's column.
 */
export const standsBeside = (view: { readonly beside?: true; readonly sections: ReadonlyArray<{ readonly kind: string; readonly family?: string }> }, drawings: boolean): boolean =>
  drawings && view.beside === true && view.sections.some(section => section.kind === 'topology' && section.family === 'flow')
