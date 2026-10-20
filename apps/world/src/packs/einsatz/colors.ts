/**
 * The colours Einsatz draws its objects in, on the map and on the Board's
 * icon badges alike. They are neutral: a contact says nothing of what was
 * seen, an identified track only that it was identified. Each stays at least
 * ΔE 16 (CIEDE2000) from OpenBridge's reserved alert colours (plan v3.1 §2.7).
 */
export const einsatzColors = {
  unit: '#0a7daf',
  task: '#b46e50',
  identified: '#6937ff',
  contact: '#6b7280',
} as const
