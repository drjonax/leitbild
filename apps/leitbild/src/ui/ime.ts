// Keystrokes that belong to an input method (IME) composition, e.g. Japanese,
// Chinese or Korean text: Enter there confirms a character, so it must never
// submit, send or cancel.

/** Safari ends a composition with a keydown whose isComposing is already false but whose keyCode is 229 ("Process"). */
const IME_PROCESS_KEY_CODE = 229

export const composingKeystroke = (event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean =>
  event.isComposing || event.keyCode === IME_PROCESS_KEY_CODE
