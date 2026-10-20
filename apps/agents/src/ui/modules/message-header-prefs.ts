// ============================================================================
// Message-header field visibility preferences.
//
// Per-user toggles for which pieces of the per-message header are shown:
//   - time     (HH:MM:SS)
//   - duration (Ns generation time)
//   - context  (token use, displayed as Npct%, with details on hover)
//   - model    (short form: substring after the last colon in the provider:
//               model identifier — e.g. `gemini:gemini-2.5-pro` -> `gemini-2.5-pro`)
//   - thinking (model reasoning text — live during gen + persisted on the
//               message bubble. When hidden, the live indicator collapses
//               to a single-line preview with an animated ellipsis, and
//               persisted thinking renders as a closed <details>. The
//               per-message disclosure triangle always lets the user
//               unfold a specific message even when globally hidden.
//               Collapsed until the user shows it: the reasoning summary
//               ("Exploring operations scope…") is noise above the answer.)
//
// Persisted in localStorage. Applied as a set of classes on document.body
// (`mh-hide-time`, `mh-hide-duration`, etc.); CSS rules in index.html
// hide elements tagged with `data-mh-piece="<name>"` accordingly. CSS-only
// hide means existing rendered messages update instantly when the user
// toggles, no re-render needed.
// ============================================================================

const STORAGE_KEY = 'leitbild:msg-header-pieces'

export type MessageHeaderPiece = 'time' | 'duration' | 'context' | 'model' | 'thinking'

export const ALL_PIECES: ReadonlyArray<MessageHeaderPiece> = ['time', 'duration', 'context', 'model', 'thinking']

export type MessageHeaderPrefs = Record<MessageHeaderPiece, boolean>

const DEFAULTS: MessageHeaderPrefs = { time: true, duration: true, context: true, model: true, thinking: false }

const defaultPrefs = (): MessageHeaderPrefs => ({ ...DEFAULTS })

export const readPrefs = (): MessageHeaderPrefs => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultPrefs()
    const parsed = JSON.parse(raw) as Partial<MessageHeaderPrefs>
    return {
      time:     typeof parsed.time === 'boolean' ? parsed.time : DEFAULTS.time,
      duration: typeof parsed.duration === 'boolean' ? parsed.duration : DEFAULTS.duration,
      context:  typeof parsed.context === 'boolean' ? parsed.context : DEFAULTS.context,
      model:    typeof parsed.model === 'boolean' ? parsed.model : DEFAULTS.model,
      thinking: typeof parsed.thinking === 'boolean' ? parsed.thinking : DEFAULTS.thinking,
    }
  } catch { return defaultPrefs() }
}

const writePrefs = (prefs: MessageHeaderPrefs): void => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)) } catch { /* quota / disabled */ }
}

// Apply prefs as classes on <body>. CSS rules in index.html target
// `body.mh-hide-<piece> [data-mh-piece="<piece>"]` to hide them.
export const applyPrefs = (prefs: MessageHeaderPrefs): void => {
  for (const piece of ALL_PIECES) {
    document.body.classList.toggle(`mh-hide-${piece}`, !prefs[piece])
  }
}

export const togglePiece = (piece: MessageHeaderPiece): MessageHeaderPrefs => {
  const prefs = readPrefs()
  prefs[piece] = !prefs[piece]
  writePrefs(prefs)
  applyPrefs(prefs)
  return prefs
}

// Boot helper — read + apply once at app start so the body classes are
// in place before the first message renders.
export const initMessageHeaderPrefs = (): void => {
  applyPrefs(readPrefs())
}

// Pretty label per piece — used by the visibility popover.
export const pieceLabels: Record<MessageHeaderPiece, string> = {
  time:     'Time',
  duration: 'Duration',
  context:  'Context use',
  model:    'Model',
  thinking: 'Thinking',
}
