export type TopologyOptions = {
  readonly minimumKv: number
  readonly substationBufferM: number
  readonly substationBufferReviewM: number
  readonly zeroImpedanceMaxM: number
  readonly pointStationRadiusM: number
  readonly equivalentVoltagesKv: ReadonlyArray<{ readonly fromKv: number; readonly toKv: number }>
  readonly sameNameReportKm: number
  readonly nearestStationSearchKm: number
}

export const defaultTopologyOptions: TopologyOptions = {
  // Plan decision 8: the model covers ≥132 kV nationwide.
  minimumKv: 132,
  // A way end this close to a station polygon is a terminal (mapping slack at the fence; PM 2026-10-10).
  substationBufferM: 50,
  // Buffer terminals farther than this from the polygon are ledgered separately for review (PM 2026-10-10).
  substationBufferReviewM: 30,
  // Same-level corridors shorter than this join their end buses into one bus (zero impedance; PM 2026-10-10).
  zeroImpedanceMaxM: 50,
  // Stations mapped only as a node: a way end within this radius is a terminal (DT1 brief: ≤150 m).
  pointStationRadiusM: 150,
  // Swedish/Finnish 400 kV and Norwegian 420 kV are one Nordic 400 kV system; 420 kV is the
  // highest equipment voltage (IEC 60038) and the Norwegian tagging convention.
  equivalentVoltagesKv: [{ fromKv: 400, toKv: 420 }],
  // Same-name stations closer than this are reported for curation, never merged.
  sameNameReportKm: 2,
  // Dangling corridor ends report the nearest station up to this distance.
  nearestStationSearchKm: 50,
}

export const createTopologyOptions = (overrides: Partial<TopologyOptions> = {}): TopologyOptions => {
  const options = { ...defaultTopologyOptions, ...overrides }
  const positive = (name: keyof TopologyOptions, value: number): void => {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`topology options: ${name} must be a positive number, got ${value}`)
  }
  positive('minimumKv', options.minimumKv)
  positive('substationBufferM', options.substationBufferM)
  positive('substationBufferReviewM', options.substationBufferReviewM)
  positive('zeroImpedanceMaxM', options.zeroImpedanceMaxM)
  if (options.substationBufferReviewM > options.substationBufferM) throw new Error('topology options: substationBufferReviewM exceeds substationBufferM')
  positive('pointStationRadiusM', options.pointStationRadiusM)
  positive('sameNameReportKm', options.sameNameReportKm)
  positive('nearestStationSearchKm', options.nearestStationSearchKm)
  const seen = new Set<number>()
  for (const { fromKv, toKv } of options.equivalentVoltagesKv) {
    positive('equivalentVoltagesKv', fromKv)
    positive('equivalentVoltagesKv', toKv)
    if (fromKv === toKv || seen.has(fromKv)) throw new Error(`topology options: equivalentVoltagesKv maps ${fromKv} kV twice or onto itself`)
    seen.add(fromKv)
  }
  return options
}
