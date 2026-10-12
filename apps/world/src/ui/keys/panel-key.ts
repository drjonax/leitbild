/**
 * A key as the World key router hands it to the open surface panel. It names
 * no browser type, so Pack code that answers keys can be typechecked and run
 * without a DOM.
 */
export interface PanelKey {
  /** `KeyboardEvent.key`, e.g. "Enter", "ArrowDown", "n", "E". */
  readonly key: string
  /** `KeyboardEvent.code`, the physical key, e.g. "KeyN", "Digit1", "BracketLeft". */
  readonly code: string
  readonly shift: boolean
}
