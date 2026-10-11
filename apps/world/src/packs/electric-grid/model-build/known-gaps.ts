import type { GridModelV2 } from '../schemas/grid-model.ts'

// Equipment in service that Grid Model v2 cannot represent yet; the ledger lists each with its
// evidence so a later schema change can close it. A gap whose bus left the model fails the build.

export interface KnownGap {
  readonly id: string
  readonly elementIds: ReadonlyArray<string>
  readonly description: string
  readonly evidence: ReadonlyArray<string>
}

const gaps: ReadonlyArray<KnownGap> = [
  {
    id: 'skillemoen-statcom',
    elementIds: ['bus:osm-way-883151328@420'],
    description: 'Skillemoen 420 kV has a ±250 MVAr STATCOM (SVC Light) in service since 2021; Grid Model v2 has no controllable reactive device, so the model holds only its variable shunt reactor (curation skillemoen-variable-reactor). At both reference hours Skillemoen stays at 0.99–1.00 pu without it.',
    evidence: [
      'https://www.hitachienergy.com/news-and-events/features/2021/04/no-siste-brikke-p-plass-i-statcom-leveransen-til-skillemoen',
      'https://www.statnett.no/globalassets/her-er-vare-prosjekter/region-nord/balsfjord-skaidi/bakgrunn-for-vedtak.pdf',
    ],
  },
]

export const knownGaps = (model: GridModelV2): ReadonlyArray<KnownGap> => {
  const busIds = new Set(model.buses.map(bus => bus.id))
  for (const gap of gaps) {
    const missing = gap.elementIds.filter(id => !busIds.has(id))
    if (missing.length > 0) throw new Error(`known gap ${gap.id}: ${missing.join(', ')} not in the model`)
  }
  return gaps
}
