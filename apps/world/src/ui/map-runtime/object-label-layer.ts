import { CompositeLayer, type Layer, type UpdateParameters } from '@deck.gl/core'
import { TextLayer } from '@deck.gl/layers'
import { labelFontPx, labelPaddingPx, mercatorPixels, placeLabels, slotAnchor, type LabelSlot } from './label-placement.ts'
import type { ColorRgba, OperationalPointFeature } from './types.ts'

/**
 * Object labels, drawn natively, placed so they never overlap
 * (`label-placement.ts`). The placement is redone when the labelled points
 * change or the zoom crosses an eighth step; panning keeps it. Each step is
 * placed at its lowest zoom, where icons lie closest, so no label overlaps
 * anywhere within it. Picking a label picks its object.
 */

export interface ObjectLabelLayerProps {
  /** The points that carry a label. */
  readonly data: ReadonlyArray<OperationalPointFeature>
  /** Every drawn point: labels keep clear of their icons. */
  readonly obstacles: ReadonlyArray<OperationalPointFeature>
  readonly getColor: (point: OperationalPointFeature) => ColorRgba
  readonly backgroundColor: ColorRgba
}

type LabelState = {
  readonly zoomKey: number
  readonly slots: ReadonlyMap<string, LabelSlot>
  readonly placed: ReadonlyArray<OperationalPointFeature>
  readonly placement: number
}

const zoomSteps = 8
const zoomKeyOf = (zoom: number): number => Math.floor(zoom * zoomSteps)

export class ObjectLabelLayer extends CompositeLayer<ObjectLabelLayerProps> {
  static override layerName = 'ObjectLabelLayer'
  declare state: LabelState

  override shouldUpdateState(params: UpdateParameters<this>): boolean {
    return params.changeFlags.propsOrDataChanged
      || (params.changeFlags.viewportChanged && zoomKeyOf(this.context.viewport.zoom) !== this.state.zoomKey)
  }

  override updateState(): void {
    const zoomKey = zoomKeyOf(this.context.viewport.zoom)
    const zoom = zoomKey / zoomSteps
    const at = (point: OperationalPointFeature) => mercatorPixels(point.position[0], point.position[1], zoom)
    const slots = placeLabels(
      this.props.data.map(point => ({
        ...at(point),
        id: point.id,
        text: point.label ?? '',
        iconSizePx: point.sizePx,
        selected: point.selected,
        highlighted: point.highlighted,
        priority: point.priority,
      })),
      this.props.obstacles.map(point => ({ ...at(point), id: point.id, iconSizePx: point.sizePx })),
    )
    this.setState({
      zoomKey,
      slots,
      placed: this.props.data.filter(point => slots.has(point.id)),
      placement: (this.state?.placement ?? 0) + 1,
    } satisfies LabelState)
  }

  override renderLayers(): Layer {
    const { slots, placed, placement } = this.state
    const anchorOf = (point: OperationalPointFeature) => {
      const slot = slots.get(point.id)
      if (slot === undefined) throw new Error(`Map label ${point.id} was drawn without a place`)
      return slotAnchor(slot, point.sizePx)
    }
    return new TextLayer<OperationalPointFeature>(this.getSubLayerProps({
      id: 'text',
      data: placed,
      characterSet: 'auto',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontWeight: 600,
      sizeUnits: 'pixels',
      getText: (point: OperationalPointFeature) => point.label ?? '',
      getPosition: (point: OperationalPointFeature) => point.position,
      getSize: labelFontPx,
      getColor: this.props.getColor,
      getTextAnchor: (point: OperationalPointFeature) => anchorOf(point).textAnchor,
      getAlignmentBaseline: (point: OperationalPointFeature) => anchorOf(point).baseline,
      getPixelOffset: (point: OperationalPointFeature) => anchorOf(point).offset,
      background: true,
      getBackgroundColor: this.props.backgroundColor,
      backgroundPadding: labelPaddingPx,
      updateTriggers: {
        getText: placement,
        getPosition: placement,
        getColor: placement,
        getTextAnchor: placement,
        getAlignmentBaseline: placement,
        getPixelOffset: placement,
      },
    }))
  }
}
