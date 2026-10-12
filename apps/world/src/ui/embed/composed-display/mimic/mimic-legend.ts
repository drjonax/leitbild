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
  /** A valve whose position the model does not solve, or the Plant does not publish (an ARV). */
  notMeasured: 'POS ?: not measured',
  simulator: 'simulator',
  /** Beside a faded alarm frame: what its alarms are expected after ("expected after RX TRIP"). */
  expected: 'expected after',
  /** Where vessels trace their readings: what a trace is, before its window ("fill / trace: last 10 min"). */
  trend: 'fill / trace: last',
  /** Beside each operation badge the drawing carries (OperatedMimic, openbridge-mimic.ts operationBadges). */
  aiProposal: 'AI proposal waiting',
  proposal: 'proposal waiting',
  operator: 'operator acted',
  ai: 'AI acted',
  manual: 'set under actuation',
  interlock: 'held by actuation',
  commandLocked: 'other command travelling',
} as const
