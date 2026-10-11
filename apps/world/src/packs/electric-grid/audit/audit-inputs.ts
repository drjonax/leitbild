import { z } from 'zod'
import type { LonLat } from './audit-graph.ts'
import type { NveLine } from './nve-coverage.ts'
import { createReferenceGeometry, type ReferenceGeometry } from './reference-geometry.ts'

// Validated parsing of the audit's file inputs (already read as JSON): the normalised grid
// sidecar and NVE Nettanlegg5 layer exports.

const position = z.tuple([z.number(), z.number()]).or(z.tuple([z.number(), z.number(), z.number()]))
const ring = z.array(position)

const sidecarSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.object({
    type: z.literal('Feature'),
    geometry: z.discriminatedUnion('type', [
      z.object({ type: z.literal('Point'), coordinates: position }),
      z.object({ type: z.literal('LineString'), coordinates: z.array(position) }),
      z.object({ type: z.literal('Polygon'), coordinates: z.array(ring) }),
      z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring)) }),
    ]),
    properties: z.object({
      externalId: z.string().min(1),
      tags: z.record(z.string(), z.string()),
    }).passthrough(),
  })),
})

export const referenceGeometryFromSidecar = (json: unknown): ReferenceGeometry =>
  createReferenceGeometry(sidecarSchema.parse(json).features)

const nveSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.object({
    type: z.literal('Feature'),
    geometry: z.discriminatedUnion('type', [
      z.object({ type: z.literal('LineString'), coordinates: z.array(position) }),
      z.object({ type: z.literal('MultiLineString'), coordinates: z.array(z.array(position)) }),
    ]),
    properties: z.object({
      globalid: z.string().min(1),
      navn: z.string().nullable(),
      spenning_kv: z.number().nullable(),
    }).passthrough(),
  })),
})

/** NVE line features; features without a voltage cannot be compared and are counted, not returned. */
export const nveLinesFromGeoJson = (json: unknown): { readonly lines: ReadonlyArray<NveLine>; readonly withoutVoltage: number } => {
  const features = nveSchema.parse(json).features
  const toLonLat = (coordinate: z.infer<typeof position>): LonLat => [coordinate[0], coordinate[1]]
  const lines = features.flatMap((feature): NveLine[] => {
    const voltageKv = feature.properties.spenning_kv
    if (voltageKv === null) return []
    const parts = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates
    return [{ globalId: feature.properties.globalid, name: feature.properties.navn, voltageKv, parts: parts.map(part => part.map(toLonLat)) }]
  })
  return { lines, withoutVoltage: features.length - lines.length }
}
