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

/** Same-origin route of an embedded view; the envelope itself goes in the fragment. */
export const embeddedViewPath = (envelope: EmbeddedViewEnvelope): string =>
  `/workspaces/${envelope.subject.workspaceId}/${envelope.moduleId}/embed/${envelope.viewType}`

export const EMBEDDED_VIEW_FRAGMENT_KEY = 'view='

export const embeddedViewFragment = (envelope: EmbeddedViewEnvelope): string =>
  `#${EMBEDDED_VIEW_FRAGMENT_KEY}${encodeURIComponent(JSON.stringify(envelope))}`
