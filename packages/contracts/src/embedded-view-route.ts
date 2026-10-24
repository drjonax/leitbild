import type { EmbeddedViewEnvelope } from './embedded-views.ts'

// Zod-free so browser bundles can build view routes and check envelopes
// without the schema runtime. Callers pass envelopes that were validated where
// they entered.

// The envelope travels in a URL fragment; 4 KiB keeps it far below browser
// URL limits while leaving room for a compact display composition.
export const EMBEDDED_VIEW_STATE_MAX_LENGTH = 4096
export const EMBEDDED_VIEW_MIN_HEIGHT = 120
// Views up to 960 px tall: a live equipment mimic with its trend and alarms needs about 900.
export const EMBEDDED_VIEW_MAX_HEIGHT = 960
// The most views one publisher lists for the display window at a time.
export const EMBEDDED_VIEW_LISTING_MAX = 30

/** Same-origin route of an embedded view; the envelope itself goes in the fragment. */
export const embeddedViewPath = (envelope: EmbeddedViewEnvelope): string =>
  `/workspaces/${envelope.subject.workspaceId}/${envelope.moduleId}/embed/${envelope.viewType}`

export const EMBEDDED_VIEW_FRAGMENT_KEY = 'view='

export const embeddedViewFragment = (envelope: EmbeddedViewEnvelope): string =>
  `#${EMBEDDED_VIEW_FRAGMENT_KEY}${encodeURIComponent(JSON.stringify(envelope))}`

/** FNV-1a over the text, as 8 hex digits. */
const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * The browser window a view pops out into, opened on the view's route from a
 * click: one per view, whoever opens it, so popping out the same view again
 * brings its window forward.
 */
export const embeddedViewWindowName = (envelope: EmbeddedViewEnvelope): string =>
  `leitbild-view-${fnv1a(`${envelope.subject.workspaceId}\n${envelope.subject.id}\n${envelope.viewType}\n${envelope.state}`)}`

export const EMBEDDED_VIEW_WINDOW_FEATURES = 'popup,width=1024,height=720'
