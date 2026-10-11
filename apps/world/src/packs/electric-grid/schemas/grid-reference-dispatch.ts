import { z } from 'zod'
import { findLicence } from '../../../reference-data/licences.ts'
import { asLicenceId } from '../../../reference-data/types.ts'

// Measured national production and cross-border exchange of Norway at the model's reference hours
// (models/norway-reference-dispatch.json), the evidence the Operating Points dispatch from. Values
// are hourly means of the published quarter-hours, in MW. Exchange is physical flow, positive into
// Norway, per neighbouring country (each HVDC country border is one or more links of the model; the
// Swedish and Finnish borders are the Nordic AC exchange).

const isoInstant = z.iso.datetime({ offset: true })
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const mw = z.number().finite()
const nonNegativeMw = z.number().finite().nonnegative()

const sourceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1),
  publisher: z.string().min(1),
  url: z.url(),
  licence: z.string().refine(id => findLicence(asLicenceId(id)) !== null, 'licence must be registered in src/reference-data/licences.ts'),
  attribution: z.string().min(1),
  retrievedAt: isoDate,
})

const hourSchema = z.strictObject({
  /** First instant of the hour; must equal the Elhub reference hour the model or Operating Point describes. */
  startUtc: isoInstant,
  /** ENTSO-E actual generation per production type for Norway (country level). */
  generationMw: z.strictObject({
    hydroRunOfRiver: nonNegativeMw,
    hydroReservoir: nonNegativeMw,
    /** Null where the source publishes no value for the hour. */
    hydroPumpedStorage: nonNegativeMw.nullable(),
    windOnshore: nonNegativeMw,
    windOffshore: nonNegativeMw,
    fossilGas: nonNegativeMw,
    /** Waste, biomass, other renewables and solar: not modelled as units; reported for the balance. */
    other: nonNegativeMw,
  }),
  /** ENTSO-E total load of Norway, including network losses (Elhub meters end use only). */
  loadMw: nonNegativeMw,
  /** Physical cross-border flow into Norway per neighbour. */
  importMw: z.strictObject({ SE: mw, FI: mw, DK: mw, DE: mw, NL: mw, GB: mw }),
  /** Exact queries the values were read from. */
  queries: z.array(z.url()).min(1),
  note: z.string().min(1),
})
export type GridReferenceHourDispatch = z.infer<typeof hourSchema>

export const referenceDispatchTableSchema = z.strictObject({
  schema: z.literal('leitbild.electric-grid.norway-reference-dispatch'),
  curatedAt: isoDate,
  sources: z.array(sourceSchema).min(1),
  hours: z.strictObject({ winterPeak: hourSchema, summerLow: hourSchema }),
}).superRefine((table, context) => {
  const licences = new Set(table.sources.map(source => source.licence))
  if (licences.size !== 1) context.addIssue({ code: 'custom', path: ['sources'], message: 'the table records one licence across its sources' })
})
export type GridReferenceDispatchTable = z.infer<typeof referenceDispatchTableSchema>
