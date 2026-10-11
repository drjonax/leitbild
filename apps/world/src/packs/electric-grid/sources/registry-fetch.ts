import { createHash } from 'node:crypto'
import type { z } from 'zod'

// Shared trust-boundary plumbing for the registry and measurement sources (NVE, Elhub, Kartverket):
// one descriptive User-Agent, explicit HTTP failure, sha256 snapshot descriptors and zod validation
// that reports the first issues instead of returning partially parsed data.

export type RegistryLicenceId = 'nlod-2.0' | 'cc-by-4.0'

export interface RegistryLicence {
  readonly id: RegistryLicenceId
  readonly name: string
  readonly url: string
}

export const registryLicences: Readonly<Record<RegistryLicenceId, RegistryLicence>> = {
  'nlod-2.0': { id: 'nlod-2.0', name: 'Norwegian Licence for Open Government Data 2.0', url: 'https://data.norge.no/nlod/en/2.0' },
  'cc-by-4.0': { id: 'cc-by-4.0', name: 'Creative Commons Attribution 4.0 International', url: 'https://creativecommons.org/licenses/by/4.0/' },
}

export interface SourceSnapshot {
  readonly sourceId: string
  readonly url: string
  readonly retrievedAt: string
  readonly sha256: string
  readonly bytes: number
  readonly licence: RegistryLicenceId
  readonly attribution: string
}

export interface RawDocument {
  readonly snapshot: SourceSnapshot
  readonly body: string
}

export type HttpFetch = (url: string, init: { readonly headers: Readonly<Record<string, string>> }) => Promise<Response>

export interface FetchContext {
  readonly fetchFn: HttpFetch
  readonly now: () => Date
}

export const registryUserAgent = 'Leitbild-grid-registry-snapshot/1.0 (+https://leitbild.app; electric-grid model build)'

export const defaultFetchContext = (): FetchContext => ({
  fetchFn: (url, init) => globalThis.fetch(url, { headers: { ...init.headers } }),
  now: () => new Date(),
})

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export const fetchRegistryDocument = async (
  context: FetchContext,
  request: {
    readonly sourceId: string
    readonly url: string
    readonly accept: string
    readonly licence: RegistryLicenceId
    readonly attribution: string
  },
): Promise<RawDocument> => {
  const response = await context.fetchFn(request.url, {
    headers: { 'user-agent': registryUserAgent, accept: request.accept },
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${request.sourceId}: HTTP ${response.status} for ${request.url}: ${body.slice(0, 300)}`)
  }
  return {
    body,
    snapshot: {
      sourceId: request.sourceId,
      url: request.url,
      retrievedAt: context.now().toISOString(),
      sha256: sha256Hex(body),
      bytes: new TextEncoder().encode(body).byteLength,
      licence: request.licence,
      attribution: request.attribution,
    },
  }
}

const describeIssues = (error: z.ZodError): string =>
  error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')

export const parseDocument = <S extends z.ZodType>(label: string, schema: S, body: string): z.infer<S> => {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch (error) {
    throw new Error(`${label}: response is not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new Error(`${label}: response failed validation: ${describeIssues(parsed.error)}`)
  return parsed.data
}

export const arcGisQueryUrl = (config: {
  readonly layerUrl: string
  readonly outFields: ReadonlyArray<string>
  readonly where: string
  readonly offset: number
  readonly pageSize: number
}): string => {
  const url = new URL(`${config.layerUrl}/query`)
  url.searchParams.set('where', config.where)
  url.searchParams.set('outFields', config.outFields.join(','))
  url.searchParams.set('returnGeometry', 'true')
  url.searchParams.set('outSR', '4326')
  url.searchParams.set('orderByFields', 'objectid')
  url.searchParams.set('resultOffset', String(config.offset))
  url.searchParams.set('resultRecordCount', String(config.pageSize))
  url.searchParams.set('f', 'geojson')
  return url.toString()
}

// ArcGIS MapServer layers page at maxRecordCount (2000 on kart.nve.no) and flag a truncated page
// with `exceededTransferLimit`; more than `maximumPages` pages is treated as a runaway query.
export const fetchArcGisPages = async (
  context: FetchContext,
  request: {
    readonly sourceId: string
    readonly layerUrl: string
    readonly outFields: ReadonlyArray<string>
    readonly where: string
    readonly pageSize: number
    readonly maximumPages: number
    readonly licence: RegistryLicenceId
    readonly attribution: string
    readonly hasMore: (body: string) => boolean
  },
): Promise<ReadonlyArray<RawDocument>> => {
  const pages: RawDocument[] = []
  for (let page = 0; page < request.maximumPages; page += 1) {
    const document = await fetchRegistryDocument(context, {
      sourceId: request.sourceId,
      url: arcGisQueryUrl({ ...request, offset: page * request.pageSize }),
      accept: 'application/geo+json, application/json',
      licence: request.licence,
      attribution: request.attribution,
    })
    pages.push(document)
    if (!request.hasMore(document.body)) return pages
  }
  throw new Error(`${request.sourceId}: more than ${request.maximumPages} pages of ${request.pageSize} features at ${request.layerUrl}`)
}

export type LonLat = readonly [lon: number, lat: number]

export const haversineKm = (a: LonLat, b: LonLat): number => {
  const rad = Math.PI / 180
  const dLat = (b[1] - a[1]) * rad
  const dLon = (b[0] - a[0]) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2
  // Mean Earth radius 6371 km (IUGG).
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

export type PriceArea = 'NO1' | 'NO2' | 'NO3' | 'NO4' | 'NO5'
export const priceAreas: ReadonlyArray<PriceArea> = ['NO1', 'NO2', 'NO3', 'NO4', 'NO5']
