import type { OperationalObject } from '../../core/model/index.ts'
import type { PackObjectField, PackObjectPresentation } from '../../core/packs/protocol.ts'

const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const fieldLines = (fields: ReadonlyArray<PackObjectField>): string => fields
  .map(field => `<div>${escapeHtml(field.label)}: ${escapeHtml(field.value)}</div>`)
  .join('')

export const objectHoverCardHtml = (config: {
  readonly object: OperationalObject
  readonly presentation: PackObjectPresentation
  readonly hasNewInfo: boolean
}): string => {
  const newInfo = config.hasNewInfo ? '<div class="hover-new-info">New information</div>' : ''
  return `<strong>${escapeHtml(config.object.label)}</strong>${newInfo}${fieldLines(config.presentation.fields)}`
}

/** A hover card for a map feature that is not an operational object, such as a live Pack layer feature. */
export const featureHoverCardHtml = (card: { readonly title: string; readonly fields: ReadonlyArray<PackObjectField> }): string =>
  `<strong>${escapeHtml(card.title)}</strong>${fieldLines(card.fields)}`
