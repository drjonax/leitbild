import { Popup, type Map as MapLibreMap } from 'maplibre-gl'
import type { MapPrompt } from '../surface-panel-interaction.ts'

/**
 * The map's one panel prompt: a button anchored at a point, drawn as a
 * MapLibre popup so it stays on its point while the map moves. A tap on the
 * button confirms; the button is a real control, so it never also counts as
 * a click on the ground beneath it.
 */

export interface MapPromptController {
  /** Shows the prompt, replacing any other, or clears it with null. */
  readonly show: (prompt: MapPrompt | null) => void
  readonly destroy: () => void
}

export const createMapPromptController = (config: { readonly getMap: () => MapLibreMap | null }): MapPromptController => {
  let popup: Popup | null = null
  let shown: MapPrompt | null = null

  const clear = (): void => {
    popup?.remove()
    popup = null
    shown = null
  }

  return {
    show: prompt => {
      if (prompt === shown && popup !== null) return
      clear()
      const map = config.getMap()
      if (prompt === null || map === null) return
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'map-prompt-button'
      button.textContent = prompt.label
      button.addEventListener('click', event => {
        event.stopPropagation()
        prompt.onConfirm()
      })
      const [lon, lat] = prompt.point.coordinates
      popup = new Popup({ closeButton: false, closeOnClick: false, anchor: 'bottom', offset: 10, className: 'map-prompt' })
        .setLngLat([lon, lat])
        .setDOMContent(button)
        .addTo(map)
      shown = prompt
    },
    destroy: clear,
  }
}
