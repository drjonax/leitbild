// One vignette row in px: the OpenBridge grid. The composer counts rows; the display Capability sizes a frame from them.
export const VIGNETTE_ROW_PX = 24

/**
 * Whether a view's sections stand beside its flow drawing: only where the drawing is drawn. Without its drawings (an
 * element's pop-over) a view stacks its sections at the width it is given, never in the window's column.
 */
export const standsBeside = (view: { readonly beside?: true; readonly sections: ReadonlyArray<{ readonly kind: string; readonly family?: string }> }, drawings: boolean): boolean =>
  drawings && view.beside === true && view.sections.some(section => section.kind === 'topology' && section.family === 'flow')
