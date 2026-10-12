/**
 * The Board's keymap. The World key router delivers keys to the open panel
 * whatever element in the frame has focus, and the panel tells it which ones
 * it handled, so their default action is prevented and a focused button's
 * own activation never commits twice.
 *
 * ↑/↓ or J/K move within the focused list; N or Home select the most urgent
 * unserved row; [ ] or F6 switch between work list and unit board; Enter
 * commits or confirms; 1-9 choose an alternative; R recalls, H halts and M
 * arms a move of the selected unit; C closes or acknowledges the selected
 * task; Esc cancels.
 *
 * A letter means one thing without Shift (Caps Lock or not) and may mean
 * another with it: `Shift+e` is its own entry, and a Shift+letter with no
 * entry is not the Board's key. Digits and named keys ignore Shift.
 */

type SimpleIntent = 'up' | 'down' | 'urgent' | 'switch' | 'commit' | 'recall' | 'hold' | 'move' | 'close' | 'cancel'
export type BoardIntent =
  | { readonly kind: SimpleIntent }
  | { readonly kind: 'alternative'; readonly number: number }

/** Letters by their lower-case key, a shifted letter as `Shift+<letter>`. */
const letters: Readonly<Record<string, SimpleIntent>> = {
  k: 'up',
  j: 'down',
  n: 'urgent',
  r: 'recall',
  h: 'hold',
  m: 'move',
  c: 'close',
}

const named: Readonly<Record<string, SimpleIntent>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'urgent',
  '[': 'switch',
  ']': 'switch',
  F6: 'switch',
  Enter: 'commit',
  Escape: 'cancel',
}

const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

/**
 * The intent of a key (`KeyboardEvent.key` with Shift); undefined for a key
 * the Board does not handle, which its panel then reports as not handled.
 */
export const intentOf = (key: string, shift: boolean): BoardIntent | undefined => {
  const digit = digits.indexOf(key as typeof digits[number])
  if (digit >= 0) return { kind: 'alternative', number: digit + 1 }
  const letter = /^[a-zA-Z]$/.test(key) ? key.toLowerCase() : undefined
  const [map, entry] = letter === undefined ? [named, key] : [letters, shift ? `Shift+${letter}` : letter]
  return Object.hasOwn(map, entry) ? { kind: map[entry]! } : undefined
}
