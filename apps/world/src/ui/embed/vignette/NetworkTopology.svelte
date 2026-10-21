<script lang="ts">
  import type { Segment } from '@oicl/connector-diagram'
  import type { Observation } from '../../../core/observation/model.ts'
  import type { Palette } from '../../displays/severity.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { embeddedDisplayFrame } from '../view-host.ts'
  import { paintLines } from './lines.ts'
  import type { VignetteSection } from '../../../features/displays/compose/model.ts'
  import { networkDrawing } from './network.ts'
  import type { AlertTone } from './readout.ts'
  import './openbridge.ts'

  // A network topology (architecture B2) in OpenBridge: lines, crossings and
  // end caps through connector-diagram on a canvas; obc-bus, obc-switch,
  // obc-transformer and obc-source over it; names and readings as text. At
  // one grid unit a row, scrolled sideways where it is wider than its frame,
  // never scaled below its 12 px text. Its attribution closes it.
  let { section, observations, palette }: { section: Extract<VignetteSection, { kind: 'topology' }>; observations: ReadonlyArray<Observation>; palette: Palette } = $props()

  const drawing = $derived(networkDrawing(section, observations))
  let zoom = $state(1)
  runOnMount(() => embeddedDisplayFrame().subscribe(presentation => { zoom = presentation.zoom }))

  /** OpenBridge's alert type for each priority drawn in colour; emergency is its critical level. */
  const ALERT_TYPE: Readonly<Record<AlertTone, string>> = { caution: 'caution', warning: 'warning', alarm: 'alarm', critical: 'level-critical' }

  type Paint = { readonly segments: ReadonlyArray<Segment>; readonly width: number; readonly height: number; readonly palette: Palette; readonly zoom: number }
  const lines = (canvas: HTMLCanvasElement, params: Paint) => {
    const paint = (next: Paint): void => paintLines(canvas, next, next.segments, next.zoom)
    paint(params)
    return { update: paint }
  }
</script>

<div class="network">
  <div class="drawing" style:width={`${drawing.width}px`} style:height={`${drawing.height}px`} role="img" aria-label="Network topology">
    {#each drawing.groups as group (group.id)}
      <div class="group" style:left={`${group.x}px`} style:top={`${group.y}px`} style:width={`${group.width}px`} style:height={`${group.height}px`}><span>{group.label}</span></div>
    {/each}
    <canvas use:lines={{ segments: drawing.segments, width: drawing.width, height: drawing.height, palette, zoom }}></canvas>
    {#each drawing.buses as bus (bus.id)}
      <obc-bus class="placed" size="small" vertical={bus.vertical} label={bus.label} title={bus.title} style:left={`${bus.x}px`} style:top={`${bus.y}px`} style:width={`${bus.width}px`} style:height={`${bus.height}px`}></obc-bus>
    {/each}
    {#each drawing.devices as device (device.id)}
      <div class="placed" style:left={`${device.x}px`} style:top={`${device.y}px`} title={device.title}>
        {#if device.element === 'obc-switch'}
          <obc-switch positioning="point" showReadoutStack={false} turnedOn={device.on} alert={device.tone !== null} alertFrameStatus={device.tone === null ? 'caution' : ALERT_TYPE[device.tone]} alertFrameMode="acked-active" alertFrameThickness="small"></obc-switch>
        {:else if device.element === 'obc-transformer'}
          <obc-transformer positioning="point" showReadoutStack={false} turnedOn={device.on} alert={device.tone !== null} alertFrameStatus={device.tone === null ? 'caution' : ALERT_TYPE[device.tone]} alertFrameMode="acked-active" alertFrameThickness="small"></obc-transformer>
        {:else}
          <obc-source positioning="point" showReadoutStack={false} turnedOn={device.on} alert={device.tone !== null} alertFrameStatus={device.tone === null ? 'caution' : ALERT_TYPE[device.tone]} alertFrameMode="acked-active" alertFrameThickness="small"></obc-source>
        {/if}
      </div>
    {/each}
    {#each drawing.texts as text (text.id)}
      <div class={`text ${text.tone ?? ''}`} class:below={text.below} style:left={`${text.x}px`} style:top={`${text.y}px`} style:width={`${text.width}px`} title={text.title}>
        <span class="name">{text.name}</span>{#if text.reading !== null}<span class="reading">{text.below ? '' : ' · '}{text.reading}</span>{/if}
      </div>
    {/each}
  </div>
</div>
{#if section.attribution !== undefined}<p class="attribution">{section.attribution}</p>{/if}

<style>
  .network { overflow-x: auto; overflow-y: hidden; }
  .drawing { position: relative; }
  canvas { position: absolute; left: 0; top: 0; }
  .placed { position: absolute; }
  .group { position: absolute; border: 1px solid var(--border-divider-color); border-radius: 4px; }
  .group span { position: absolute; left: 4px; top: 2px; font-size: 12px; color: var(--element-neutral-color); white-space: nowrap; }
  .text { position: absolute; height: var(--row); line-height: 20px; font-size: 12px; white-space: nowrap; overflow: hidden; }
  .text.below { height: calc(2 * var(--row)); display: flex; flex-direction: column; justify-content: space-between; line-height: 18px; }
  .reading { color: var(--element-neutral-color); font-variant-numeric: tabular-nums; }
  .text.caution .name, .text.warning .name, .text.alarm .name, .text.critical .name { font-weight: 700; text-decoration: underline 2px; text-underline-offset: 2px; }
  .text.caution .name { text-decoration-color: var(--display-caution-mark); }
  .text.warning .name { text-decoration-color: var(--display-warning-mark); }
  .text.alarm .name { text-decoration-color: var(--display-alarm-mark); }
  .text.critical .name { text-decoration-color: var(--display-critical-mark); }
  .attribution { margin: 0; height: var(--row); line-height: var(--row); font-size: 12px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
