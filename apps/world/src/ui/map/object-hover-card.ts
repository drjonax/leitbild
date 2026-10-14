import type { OperationalObject } from '../../core/model/index.ts'
import type { PackObjectField, PackObjectPresentation, PackTargetPreview } from '../../core/packs/protocol.ts'

const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const fieldLines = (fields: ReadonlyArray<PackObjectField>): string => fields
  .map(field => `<div>${escapeHtml(field.label)}: ${escapeHtml(field.value)}</div>`)
  .join('')

export const objectHoverCardHtml = (config: {
  readonly object: OperationalObject
  readonly presentation: PackObjectPresentation
  readonly hasNewInfo: boolean
  /** What a click on this object would order the selected controller to do, when its Pack describes targets. */
  readonly targetPreview: PackTargetPreview | null
}): string => {
  const newInfo = config.hasNewInfo ? '<div class="hover-new-info">New information</div>' : ''
  const preview = config.targetPreview
    ? `<div class="hover-target-preview${config.targetPreview.refused ? ' refused' : ''}">${escapeHtml(config.targetPreview.text)}</div>`
    : ''
  // An object with a card shows its glance, the card's own first lines; the card has the rest.
  const lines = config.presentation.glance === undefined
    ? fieldLines(config.presentation.fields)
    : config.presentation.glance.map(line => `<div>${escapeHtml(line)}</div>`).join('')
  return `<strong>${escapeHtml(config.object.label)}</strong>${newInfo}${preview}${lines}`
}

/** A hover card for a map feature that is not an operational object, such as a live Pack layer feature. */
export const featureHoverCardHtml = (card: { readonly title: string; readonly fields: ReadonlyArray<PackObjectField> }): string =>
  `<strong>${escapeHtml(card.title)}</strong>${fieldLines(card.fields)}`
