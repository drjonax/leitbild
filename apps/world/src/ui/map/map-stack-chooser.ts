import { Popup, type Map as MapLibreMap } from 'maplibre-gl'
import type { GeoJsonPoint } from '../../core/model/index.ts'

/** One entry of the chooser: what it says, and what choosing it does. */
export interface StackChoice {
  readonly id: string
  readonly label: string
  readonly choose: () => void
}

export interface MapStackChooser {
  /** Shows the chooser at a point, replacing any other. */
  readonly show: (point: GeoJsonPoint, choices: ReadonlyArray<StackChoice>) => void
  readonly hide: () => void
  readonly shown: () => boolean
}

/**
 * The chooser, drawn as a MapLibre popup anchored at the tap so it stays on
 * its point while the map moves: one button per object, each a tap target of
 * at least 44 px. A button is a real control, so its tap never also counts as
 * a click on the map beneath it; the map hides the chooser on its next click
 * or camera move.
 */
export const createMapStackChooser = (config: { readonly getMap: () => MapLibreMap | null }): MapStackChooser => {
  let popup: Popup | null = null
  const hide = (): void => {
    popup?.remove()
    popup = null
  }
  return {
    show: (point, choices) => {
      hide()
      const map = config.getMap()
      if (map === null) return
      const list = document.createElement('div')
      list.className = 'map-stack-list'
      list.setAttribute('role', 'menu')
      for (const choice of choices) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'map-stack-button'
        button.setAttribute('role', 'menuitem')
        button.textContent = choice.label
        button.addEventListener('click', event => {
          event.stopPropagation()
          hide()
          choice.choose()
        })
        list.append(button)
      }
      const [lon, lat] = point.coordinates
      popup = new Popup({ closeButton: false, closeOnClick: false, anchor: 'bottom', offset: 16, className: 'map-stack' })
        .setLngLat([lon, lat])
        .setDOMContent(list)
        .addTo(map)
    },
    hide,
    shown: () => popup !== null,
  }
}
