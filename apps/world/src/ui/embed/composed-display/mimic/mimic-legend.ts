// The words of a mimic's key. They are set in OpenBridge's Noto Sans with the
// drawing, so the font the embed ships covers them (mimic-font.ts).

export const mimicLegend = {
  stale: 'STALE',
  staleMeaning: 'not current',
  flow: 'flow',
  noFlow: 'no flow',
  unknownFlow: 'not known',
  command: 'CMD',
  commandMeaning: 'command not followed',
  notComputed: 'POS ?: not computed',
  simulator: 'simulator',
  /** Beside a faded alarm frame: what its alarms are expected after ("expected after RX TRIP"). */
  expected: 'expected after',
} as const
