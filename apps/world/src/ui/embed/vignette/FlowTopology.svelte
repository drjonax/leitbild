<script lang="ts">
  import type { Segment } from '@oicl/connector-diagram'
  import type { SimulationRunId } from '../../../core/model/index.ts'
  import type { Observation } from '../../../core/observation/model.ts'
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import type { VignetteSection } from '../../../features/displays/compose/model.ts'
  import type { Palette } from '../../displays/severity.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { embeddedDisplayFrame } from '../view-host.ts'
  import ElementPopover from './ElementPopover.svelte'
  import { FLOW_LINE_PX, flowDrawing } from './flow-symbols.ts'
  import { drawingScale } from './network.ts'
  import { paintLines } from './lines.ts'
  import { nextPopover, POPOVER_CLOSED, type OpenedFrom, type PopoverState } from './popover.ts'
  import type { AlertTone } from './readout.ts'
  import { VIGNETTE_ROW_PX } from './grid.ts'
  import Vessel from './Vessel.svelte'
  import './openbridge.ts'

  // A flow topology (architecture B3) in OpenBridge (flow-symbols.ts): pipes,
  // header bars and end caps through connector-diagram on a canvas; devices,
  // tanks, heat exchangers and buses as OpenBridge's own elements over it, the
  // lanes' hub as the registered vessel; names and readings as text where the
  // layout kept room for them. At one grid unit a row, scrolled sideways where
  // it is wider than its frame, and scaled as the composer scaled it where its
  // rows are fewer than its height (a chat column). Each item is a button: a
  // press (or Enter or Space) opens its pop-over (ElementPopover.svelte); a
  // second press, Esc or a press outside closes it.
  let { section, observations, alerts, palette, frozen, runId, from }: {
    section: Extract<VignetteSection, { kind: 'topology' }>
    observations: ReadonlyArray<Observation>
    alerts: ReadonlyArray<AlertRow>
    palette: Palette
    /** The sample is frozen: everything reads as unknown. */
    frozen: boolean
    runId: SimulationRunId
    /** The display this drawing stands in (ElementPopover.svelte). */
    from: OpenedFrom
  } = $props()

  const drawing = $derived(flowDrawing(section, observations, alerts, frozen))
  const scale = $derived(drawingScale(section))
  let zoom = $state(1)
  runOnMount(() => embeddedDisplayFrame().subscribe(presentation => { zoom = presentation.zoom }))

  /** A device symbol's two grid cells. */
  const SYMBOL_PX = 2 * VIGNETTE_ROW_PX
  /** OpenBridge's alert type for each priority drawn in colour; emergency is its critical level. */
  const ALERT_TYPE: Readonly<Record<AlertTone, string>> = { caution: 'caution', warning: 'warning', alarm: 'alarm', critical: 'level-critical' }

  type Paint = { readonly segments: ReadonlyArray<Segment>; readonly width: number; readonly height: number; readonly palette: Palette; readonly zoom: number }
  const lines = (canvas: HTMLCanvasElement, params: Paint) => {
    const paint = (next: Paint): void => paintLines(canvas, next, next.segments, next.zoom)
    paint(params)
    return { update: paint }
  }

  let popover = $state<PopoverState>(POPOVER_CLOSED)
  let opener = $state<HTMLElement | null>(null)
  let drawingElement: HTMLElement | undefined = $state()
  const press = (id: string, target: EventTarget | null): void => {
    opener = target instanceof HTMLElement ? target : null
    popover = nextPopover(popover, { kind: 'pressed', item: id })
  }
  const key = (id: string) => (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    press(id, event.currentTarget)
  }
  const close = (returnFocus: boolean): void => {
    popover = nextPopover(popover, { kind: 'dismissed' })
    if (returnFocus) opener?.focus()
  }
  const items = $derived(new Map([...drawing.devices, ...drawing.vessels].map(item => [item.id, item])))
  const open = $derived(popover.kind === 'open' ? items.get(popover.item) : undefined)
  const texts = $derived(new Map(drawing.texts.map(text => [text.id, text])))
</script>

<div class="flow">
  <div class="fit" style:width={`${drawing.width * scale}px`} style:height={`${drawing.height * scale}px`}>
  <div class="drawing" bind:this={drawingElement} style:width={`${drawing.width}px`} style:height={`${drawing.height}px`} style:transform={scale < 1 ? `scale(${scale})` : undefined} role="group" aria-label="Flow topology">
    <canvas use:lines={{ segments: drawing.segments, width: drawing.width, height: drawing.height, palette, zoom }}></canvas>
    {#each drawing.buses as bus (bus.id)}
      <obc-bus class="placed" size="small" vertical={bus.vertical} label="" title={bus.title} style:left={`${bus.x}px`} style:top={`${bus.y}px`} style:width={`${bus.width}px`} style:height={`${bus.height}px`}></obc-bus>
    {/each}
    {#each drawing.vessels as item (item.id)}
      <div class="placed box" role="button" tabindex="0" aria-label={item.title} title={item.title} style:left={`${item.x}px`} style:top={`${item.y}px`} style:width={`${item.width}px`} style:height={`${item.height}px`} onclick={event => press(item.id, event.currentTarget)} onkeydown={key(item.id)}>
        {#if item.kind === 'tank'}
          <obc-automation-tank type="generic" orientation="vertical" positioning="button" compact medium="normal" max={100} value={item.level ?? 0} static={item.unknown || item.level === null} showTrendSymbol={false} clickable={false} tag="" alert={item.tone !== null} alertFrameStatus={item.tone === null ? 'caution' : ALERT_TYPE[item.tone]} alertFrameThickness="small" alertFrameType="regular" showAlertCategoryIcon={false} showAlertIcon={false} style:width="100%" style:height="100%"><span slot="readout"></span></obc-automation-tank>
        {:else if item.kind === 'exchanger'}
          <obc-heat-exchanger positioning="button" medium="graphic" static={item.unknown} clickable={false} showIcon tag="" alert={item.tone !== null} alertFrameStatus={item.tone === null ? 'caution' : ALERT_TYPE[item.tone]} alertFrameThickness="small" alertFrameType="regular" showAlertCategoryIcon={false} showAlertIcon={false} style:width="100%" style:height="100%"></obc-heat-exchanger>
        {:else if item.drawing !== undefined}
          <Vessel id={item.id} width={item.width} height={item.height} origin={{ x: item.x, y: item.y }} drawing={item.drawing} level={item.level} parts={item.parts ?? []} />
        {/if}
      </div>
    {/each}
    {#each drawing.devices as device (device.id)}
      <div class="placed device" role="button" tabindex="0" aria-label={device.title} title={device.title} style:left={`${device.x - SYMBOL_PX / 2}px`} style:top={`${device.y - SYMBOL_PX / 2}px`} onclick={event => press(device.id, event.currentTarget)} onkeydown={key(device.id)}>
        <div class="point"><obc-automation-button variant="regular" positioning="point" showReadoutStack={false} state={device.on ? 'open' : 'closed'} static={device.unknown} orientation={device.orientation} activated={popover.kind === 'open' && popover.item === device.id} progress={false} hasBadgeSpacer={false} alert={device.tone !== null} alertFrameStatus={device.tone === null ? 'caution' : ALERT_TYPE[device.tone]} alertFrameMode="acked-active" alertFrameThickness="small" alertFrameType="regular" showAlertCategoryIcon={false} showAlertIcon={false}>
          {#if device.glyph?.tag === 'obc-valve-analog-two-way-icon'}
            <obc-valve-analog-two-way-icon slot="icon" value={device.glyph.value} closed={device.glyph.value === 0} vertical={device.vertical}></obc-valve-analog-two-way-icon>
          {:else if device.glyph !== null}
            <svelte:element this={device.glyph.tag} slot="icon" usecsscolor></svelte:element>
          {/if}
        </obc-automation-button></div>
      </div>
    {/each}
    {#each drawing.texts as text (text.id)}
      <div class={`text ${text.tone ?? ''}`} data-item={text.id} style:left={`${text.x}px`} style:top={`${text.y}px`} style:width={`${text.width}px`} style:--line={`${FLOW_LINE_PX}px`} title={text.title}>
        {#each text.lines as line, at (at)}<span class={line.kind}>{line.text}</span>{/each}
      </div>
    {/each}
  </div>
  </div>
  <!-- Outside the drawing: a scaled drawing's transform would otherwise hold the pop-over's fixed place. -->
  {#if open !== undefined && opener !== null}
    <ElementPopover {runId} {from} objectId={section.objectId} packId={section.packId} elementId={open.element} name={texts.get(open.id)?.lines[0]?.text ?? open.title} anchor={opener} text={drawingElement?.querySelector<HTMLElement>(`[data-item="${CSS.escape(open.id)}"]`) ?? null} {zoom} {palette} onclose={close} />
  {/if}
</div>
{#if section.attribution !== undefined}<p class="attribution">{section.attribution}</p>{/if}

<style>
  .flow { overflow-x: auto; overflow-y: hidden; }
  .drawing { position: relative; transform-origin: 0 0; }
  canvas { position: absolute; left: 0; top: 0; }
  .placed { position: absolute; }
  /* A device's button is its symbol's two cells, so a press, a pointer and the focus ring find it; the symbol stands at its centre. */
  .device { width: calc(2 * var(--row)); height: calc(2 * var(--row)); }
  /* OpenBridge's point positioning centres the symbol on its host's origin: the host stands at the box's centre. */
  .point { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
  .box { display: block; }
  [role='button']:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 2px; }
  /* A line may run a few pixels past the width the sizing reserved (8 px a character; capitals are wider): the layout keeps text clear of other items by more. */
  .text { position: absolute; display: flex; flex-direction: column; font-size: 12px; line-height: var(--line); white-space: nowrap; pointer-events: none; }
  .text span { color: var(--element-neutral-color); font-variant-numeric: tabular-nums; }
  .text .name, .text .word { color: var(--element-active-color); }
  .text .word { font-weight: 600; }
  /* A command the item does not follow: bold, as today's display writes its CMD word. */
  .text .command { color: var(--element-active-color); font-weight: 700; }
  .text.caution .name, .text.warning .name, .text.alarm .name, .text.critical .name { font-weight: 700; text-decoration: underline 2px; text-underline-offset: 2px; }
  .text.caution .name { text-decoration-color: var(--display-caution-mark); }
  .text.warning .name { text-decoration-color: var(--display-warning-mark); }
  .text.alarm .name { text-decoration-color: var(--display-alarm-mark); }
  .text.critical .name { text-decoration-color: var(--display-critical-mark); }
  .attribution { margin: 0; height: var(--row); line-height: var(--row); font-size: 12px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
