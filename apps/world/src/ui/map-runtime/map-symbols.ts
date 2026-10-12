import { invokeWorld } from '../workspace-capability-client.ts'
import common from '../../core/map-symbols/common.json'

export const svgForSymbolBody = (body: string, color = 'white', size = 48): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const artwork = new Map<string, string>(Object.entries(common).map(([id, body]) => [id, svgForSymbolBody(body)]))
export const loadMapSymbols = async (ids: ReadonlyArray<string>): Promise<ReadonlyMap<string, string>> => {
  const missing = [...new Set(ids)].filter(id => !artwork.has(id))
  for (let start = 0; start < missing.length; start += 32) {
    const result = await invokeWorld<{ icons: { id: string; svg: string }[] }>('world.map.symbols', { ids: missing.slice(start, start + 32), artwork: true, limit: 32 })
    for (const icon of result.icons) artwork.set(icon.id, icon.svg)
  }
  // Bound session cache; MapLibre retains only glyphs used by its current layers.
  while (artwork.size > 256) artwork.delete(artwork.keys().next().value!)
  return artwork
}
export const rasterizeSymbol = async (svg: string): Promise<ImageData> => {
  const image = new Image()
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await image.decode()
  const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 48
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Map icon rasterization requires a 2D canvas')
  context.drawImage(image, 0, 0, 48, 48)
  return context.getImageData(0, 0, 48, 48)
}
/** Packs rasterized artwork into one PNG atlas image for the deck icon layers. */
export const composeSymbolAtlas = (cells: ReadonlyArray<{ readonly image: ImageData; readonly x: number; readonly y: number }>, size: { readonly width: number; readonly height: number }): string => {
  const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Map icon atlas requires a 2D canvas')
  for (const cell of cells) context.putImageData(cell.image, cell.x, cell.y)
  return canvas.toDataURL('image/png')
}
