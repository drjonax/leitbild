import { asLicenceId, type LicenceId, type LicenceRef } from './types.ts'

// Known licence registry.
// Datasets reference licences from this registry; the manifest writer rejects unknown ids.

export const nveNlod20: LicenceRef = {
  id: asLicenceId('nve-nlod-2.0'),
  name: 'Norwegian Licence for Open Government Data 2.0',
  url: 'https://data.norge.no/nlod/en/2.0',
  attribution: '© NVE · NLOD 2.0',
  commercialUseAllowed: true,
  redistributionAllowed: true,
  shareAlike: false,
}

export const osmOdbl: LicenceRef = {
  id: asLicenceId('osm-odbl-1.0'),
  name: 'Open Data Commons Open Database License 1.0',
  url: 'https://opendatacommons.org/licenses/odbl/1-0/',
  attribution: '© OpenStreetMap contributors · ODbL 1.0',
  commercialUseAllowed: true,
  redistributionAllowed: true,
  shareAlike: true,
}

// Elhub open energy data, Kartverket municipality data, Statistics Norway's statistics including
// its 1 km population grid (ssb.no/diverse/lisens: credit "Statistisk sentralbyrå" or "SSB") and
// the Energy-Charts production and exchange series (Fraunhofer ISE) are published under CC BY 4.0.
export const ccBy40: LicenceRef = {
  id: asLicenceId('cc-by-4.0'),
  name: 'Creative Commons Attribution 4.0 International',
  url: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: '© Elhub AS; © Kartverket; © Statistisk sentralbyrå (SSB); © Energy-Charts.info (Fraunhofer ISE), data: ENTSO-E · CC BY 4.0',
  commercialUseAllowed: true,
  redistributionAllowed: true,
  shareAlike: false,
}

export const repoOwned: LicenceRef = {
  id: asLicenceId('repo-owned'),
  name: 'Repository-owned content',
  url: '',
  attribution: '© Leitbild contributors',
  commercialUseAllowed: true,
  redistributionAllowed: true,
  shareAlike: false,
}

const knownLicences: ReadonlyArray<LicenceRef> = [nveNlod20, osmOdbl, ccBy40, repoOwned]

export const findLicence = (id: LicenceId): LicenceRef | null =>
  knownLicences.find(licence => licence.id === id) ?? null

export const assertKnownLicence = (licence: LicenceRef): void => {
  if (findLicence(licence.id) === null) {
    throw new Error(`unknown licence id: ${licence.id}. Register it in src/reference-data/licences.ts before referencing it from a dataset.`)
  }
}
