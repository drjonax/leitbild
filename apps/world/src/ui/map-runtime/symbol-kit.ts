import common from '../../core/map-symbols/common.json'

export type LeitbildSymbolId = keyof typeof common
export type LeitbildIconMapping = Record<string, { x: number; y: number; width: number; height: number; anchorX: number; anchorY: number; mask: boolean }>
const symbolIds = Object.keys(common) as LeitbildSymbolId[]
/** The size the map draws an operational icon at, unless its presentation sets another. */
export const operationalIconPx = 23
/** The radius of the coloured status disk drawn beneath an icon this large, in px: it covers the whole glyph. */
export const statusDiskRadiusPx = (iconPx: number): number => iconPx * 0.74
export const leitbildSymbolDefinitions = symbolIds.map(id => ({ id, label: id.replaceAll('-', ' '), defaultSizePx: operationalIconPx }))
export const leitbildSymbolIds = new Set<string>(symbolIds)
/**
 * Which atlas draws an icon: the compiled atlas for its ids, the on-demand
 * catalogue atlas for any other catalogue id. The UI never imports the
 * catalogue itself; an id it does not know fails when its artwork loads.
 */
export type SymbolAtlas = 'compiled' | 'catalogue'
export const symbolAtlasFor = (icon: string): SymbolAtlas => {
  if (icon.length === 0) throw new Error('Operational map icon is empty')
  return leitbildSymbolIds.has(icon) ? 'compiled' : 'catalogue'
}
export const symbolSizePx = (_symbolId: string): number => operationalIconPx
const cell = 64, columns = 8
export const leitbildSymbolAtlasUrl = (): string => {
  const body = symbolIds.map((id, index) => `<g transform="translate(${index % columns * cell + 8} ${Math.floor(index / columns) * cell + 8}) scale(2)" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${common[id]}</g>`).join('')
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${columns * cell}" height="${Math.ceil(symbolIds.length / columns) * cell}">${body}</svg>`)
}
export const leitbildSymbolIconMapping = (): LeitbildIconMapping => Object.fromEntries(symbolIds.map((id, index) => [id, { x: index % columns * cell, y: Math.floor(index / columns) * cell, width: cell, height: cell, anchorX: cell / 2, anchorY: cell / 2, mask: true }]))
