import type { PackMapLegend, PackMapTheme, PackMapThemedColor } from '../../../core/packs/reference-style.ts'

// Reference-grid colours. Red, orange and amber are left free for live
// overload and alarm states, which a later live layer draws above this one,
// and magenta for OpenBridge's emergency level, so 220 kV is olive (plan v3.1
// D9). Pairwise CIEDE2000 distance between voltage classes is ≥ 16 in both
// themes (132/110 kV: 26 light, 31 dark), and every tagged class has ≥ 4.2:1
// contrast against the base map background. Under red-green colour blindness
// 300 and 132 kV (violet, blue) converge and 110 kV teal nears the ≤ 66 kV
// grey; line width carries voltage as well.

export type GridVoltageClassId = 'kv420' | 'kv300' | 'kv220' | 'kv132' | 'kv110' | 'kv66' | 'unknown'

export interface GridVoltageClass {
  readonly id: GridVoltageClassId
  readonly label: string
  readonly color: PackMapThemedColor
}

/** Highest first. Bounds (kV, inclusive lower) are in `gridVoltageStops`. */
export const gridVoltageClasses: ReadonlyArray<GridVoltageClass> = [
  { id: 'kv420', label: '420 kV and HVDC', color: { light: '#1b1f6b', dark: '#dbe1ff' } },
  { id: 'kv300', label: '300 kV', color: { light: '#7a2fbf', dark: '#b88cff' } },
  { id: 'kv220', label: '220 kV', color: { light: '#6a7a00', dark: '#a3b84a' } },
  { id: 'kv132', label: '132 kV', color: { light: '#1f6fc2', dark: '#4f9cf0' } },
  { id: 'kv110', label: '110 kV', color: { light: '#0b7b7b', dark: '#2fc4b8' } },
  { id: 'kv66', label: '66 kV and below', color: { light: '#737373', dark: '#8f8f8f' } },
  { id: 'unknown', label: 'Voltage not tagged', color: { light: '#a3a3a3', dark: '#5f6670' } },
]

/** Lower class bounds in kV for MapLibre `step`: ≥ 380 kV covers 400/420 kV AC and the 450–600 kV HVDC links. */
export const gridVoltageStops = { kv110: 100, kv132: 132, kv220: 200, kv300: 300, kv420: 380 } as const

export const gridGenerationColor: PackMapThemedColor = { light: '#2e8540', dark: '#6fd36f' }

export interface GridMapPalette {
  readonly voltage: Readonly<Record<GridVoltageClassId, string>>
  readonly generation: string
  readonly text: string
  readonly halo: string
  readonly siteFillOpacity: number
}

// Text and halo match the base map's label colours for each theme.
const themeText: Readonly<Record<PackMapTheme, { readonly text: string; readonly halo: string; readonly siteFillOpacity: number }>> = {
  light: { text: '#1f2937', halo: '#ffffff', siteFillOpacity: 0.18 },
  dark: { text: '#e2e8f0', halo: '#0e1521', siteFillOpacity: 0.26 },
}

export const gridMapPalette = (theme: PackMapTheme): GridMapPalette => ({
  voltage: Object.fromEntries(gridVoltageClasses.map(entry => [entry.id, entry.color[theme]])) as Record<GridVoltageClassId, string>,
  generation: gridGenerationColor[theme],
  ...themeText[theme],
})

export const neutralSwatchColor: PackMapThemedColor = { light: themeText.light.text, dark: themeText.dark.text }

export const gridVoltageLegend: PackMapLegend = {
  id: 'electric-grid:voltage',
  title: 'Grid voltage',
  entries: gridVoltageClasses.map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    symbol: 'line',
    color: entry.color,
    sizePx: Math.max(1.5, 4 - index * 0.5),
  })),
}
