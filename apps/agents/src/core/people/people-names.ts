// ============================================================================
// Person names — one normalisation shared by join, rename and uniqueness.
//
// A name is shown to every other Person in the Workspace, so it must render
// as exactly what it says: no invisible or direction-changing characters, no
// line breaks, no private-use or unassigned code points, and never blank.
// Uniqueness is decided on a locale-free lower-cased key of the normalised
// name, so "Ben", "BEN" and the full-width "Ｂｅｎ" (NFKC) are the same name.
// ============================================================================

/** Shown in one header row and a chat title; longer names stop being readable there. */
export const PERSON_NAME_MAX_CODE_POINTS = 32

/** Transport bound on the raw input before normalisation; a real name is far shorter. */
export const PERSON_NAME_INPUT_MAX_LENGTH = 512

/** Prefix of names given to a Person who has not chosen one (User1, User2, …). */
export const DEFAULT_PERSON_NAME_PREFIX = 'User'

export type PersonNameRejection = 'empty' | 'too_long' | 'invalid_characters'

export type PersonNameResult =
  | { readonly ok: true; readonly name: string; readonly key: string }
  | { readonly ok: false; readonly reason: PersonNameRejection }

// Cc controls, Cf format characters (bidi overrides and isolates, ZWJ, ZWNJ,
// ZWSP, BOM, …), Co private use, Cs lone surrogates, Cn unassigned, the Zl/Zp
// line and paragraph separators, and every default-ignorable code point
// (combining grapheme joiner, variation selectors, Mongolian free variation
// selectors, Hangul fillers), which render as nothing. Emoji with a variation
// selector (for example a red heart) are refused with them; plain emoji pass.
const FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u
// A name must show something: at least one letter, number, symbol or
// punctuation mark. The Braille blank (U+2800) is a symbol that looks empty.
const VISIBLE_CHARACTER = /[\p{L}\p{N}\p{S}\p{P}]/u
const BRAILLE_BLANK = /\u2800/gu
// Only space separators collapse; every other whitespace-like character is
// one of the forbidden categories above and is rejected rather than hidden.
const SPACE_RUNS = /\p{Zs}+/gu
const EDGE_SPACES = /^\p{Zs}+|\p{Zs}+$/gu

/** The uniqueness key of an already normalised name. Locale-free on purpose. */
export const personNameKey = (normalisedName: string): string => normalisedName.toLowerCase()

export const normalisePersonName = (raw: string): PersonNameResult => {
  const name = raw.normalize('NFKC').replace(EDGE_SPACES, '').replace(SPACE_RUNS, ' ')
  if (name.length === 0) return { ok: false, reason: 'empty' }
  if (FORBIDDEN_CHARACTERS.test(name)) return { ok: false, reason: 'invalid_characters' }
  if (!VISIBLE_CHARACTER.test(name.replace(BRAILLE_BLANK, ''))) return { ok: false, reason: 'invalid_characters' }
  if ([...name].length > PERSON_NAME_MAX_CODE_POINTS) return { ok: false, reason: 'too_long' }
  return { ok: true, name, key: personNameKey(name) }
}

/**
 * The lowest free `User<N>`, N ≥ 1. Callers pass the keys taken right now and
 * insert the result before yielding, so two joins can never get the same name.
 */
export const allocateDefaultPersonName = (takenKeys: ReadonlySet<string>): string => {
  for (let n = 1; ; n++) {
    const name = `${DEFAULT_PERSON_NAME_PREFIX}${n}`
    if (!takenKeys.has(personNameKey(name))) return name
  }
}
