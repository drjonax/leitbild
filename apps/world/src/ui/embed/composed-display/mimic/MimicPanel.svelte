<script lang="ts">
  import { onMount } from 'svelte'
  import type { Segment } from '@oicl/connector-diagram'
  import type { CompiledMimic, MimicDrawnItem, MimicPipeState } from '../../../../packs/process-plant/displays/mimic/mimic-model.ts'
  import { indexSample, type ItemLook, type SampleIndex } from '../../../../packs/process-plant/displays/mimic/evaluate.ts'
  import { drawnLook, flapPlaces, flapTexts, itemTreatment, pipeStatesLook, powerStateWord, rowText, shutdownDemanded, valueRowReading, WIDER_RANGE } from '../../../../packs/process-plant/displays/mimic/rows.ts'
  import type { MimicFrame } from '../../../../packs/process-plant/displays/mimic/bindings.ts'
  import { displayValue, formatQuantity, readingValueText, unitLabel, valueDigits } from '../../../../packs/process-plant/displays/display-text.ts'
  import type { ComposedDisplayAlarm, ComposedDisplaySample } from '../composed-display-client.ts'
  import { alertTypeOf, expectedAfter } from '../panel-presenters.ts'
  import type { DisplayAnnunciation } from '../../../../packs/process-plant/displays/annunciators.ts'
  import { limitInForce } from '../../../../packs/process-plant/displays/trend-reading.ts'
  import { chevronSegment, pipeSegments, pipeValue, stubEndSegment } from './pipe-segments.ts'
  import { mimicLegend } from './mimic-legend.ts'
  import { openBridgeDevice, textWidth } from '../../../../packs/process-plant/displays/mimic/text-metrics.ts'
  import type * as OpenBridgeMimic from './openbridge-mimic.ts'
  import { embeddedDisplayFrame } from '../../view-host.ts'

  // A generated equipment mimic drawn with OpenBridge: pipes on a canvas by
  // connector-diagram, equipment as positioned OpenBridge elements. The
  // geometry is fixed by the server; a sample restyles it and never moves it.
  // A stale view draws every state as unknown and says so.
  // A generated display opens what an item stands for; an agent's advice is read-only.
  // Narrowed to an annunciator system, the items its rules frame stand out and
  // the rest dim, except any item with an active alarm of its own.
  let { mimic, latest, stale, open, highlight = null, annunciation }: {
    mimic: CompiledMimic
    latest: ComposedDisplaySample | undefined
    stale: boolean
    /** What the I&C declares of its alarms: which are expected after a first-out group's actuation. */
    annunciation: DisplayAnnunciation
    open?: ((item: MimicDrawnItem) => void) | undefined
    highlight?: ReadonlySet<string> | null
  } = $props()

  let openBridge = $state<typeof OpenBridgeMimic | null>(null)
  let columnWidth = $state(0)
  // A column narrower than the drawing shrinks it down to the scale its profile allows (chat: smallest text 11 px; the overview: none); then it scrolls.
  const scale = $derived(columnWidth === 0 ? 1 : Math.min(1, Math.max(mimic.minScale, columnWidth / mimic.width)))
  let theme = $state(document.documentElement.dataset.obcTheme ?? '')
  let canvas = $state<HTMLCanvasElement | undefined>(undefined)
  // The display window may paint the view magnified; canvases are drawn for the zoom it is painted at.
  const displayFrame = embeddedDisplayFrame()

  onMount(() => {
    let alive = true
    void import('./openbridge-mimic.ts').then(async loaded => {
      await loaded.loadMimicFont()
      if (alive) openBridge = loaded
    })
    // The pipe palette follows the OpenBridge theme.
    const observer = new MutationObserver(() => { theme = document.documentElement.dataset.obcTheme ?? '' })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-obc-theme'] })
    return () => {
      alive = false
      observer.disconnect()
    }
  })

  const index = $derived<SampleIndex>(indexSample(stale ? undefined : latest?.values))
  // A cleared alarm awaiting acknowledgement is listed, not framed.
  const alarms = $derived<ReadonlyArray<ComposedDisplayAlarm>>(stale ? [] : (latest?.alarms ?? []).filter(alarm => alarm.active))
  // A grouped symbol reads as its members together ("1/2 RUN").
  const looks = $derived(new Map(mimic.items.map(item => [item.id, drawnLook(item.binding, item.rows, index)])))

  const severityRank = { critical: 0, warning: 1, notice: 2, info: 3 } as const

  /**
   * The most severe active alarm framing an item, trips first, with the flap
   * text that says what it watches and does: as the trend chip of its signal
   * picks it, among the rules that act in the Plant's current mode (a reactor
   * trip latched at power frames nothing in hot standby; the banner and the
   * alarm list keep it). An alarm the I&C declares expected after a
   * first-out it followed (expectedAfter) yields to any other; where every
   * one framing the item is so (steam generator low-low levels from the
   * shrink after a reactor trip), the frame is faded, never removed, and
   * says what they are expected after, while the initiator stands out.
   */
  const alertOf = (item: MimicDrawnItem): { readonly status: 'alarm' | 'warning' | 'caution'; readonly label: MimicFrame; readonly others: number; readonly expected: string | null } | null => {
    const inForce = item.binding.frames.filter(frame => latest?.mode === undefined || limitInForce(frame, latest.mode))
    const flaps = new Map(inForce.map(frame => [frame.ruleId, frame]))
    const active = alarms
      .filter(alarm => flaps.has(alarm.ruleId))
      .map(alarm => ({ alarm, expected: expectedAfter(alarm, latest?.alarms ?? [], annunciation) }))
      .sort((left, right) => Number(left.expected !== null) - Number(right.expected !== null)
        || Number(right.alarm.kind === 'trip') - Number(left.alarm.kind === 'trip') || severityRank[left.alarm.severity] - severityRank[right.alarm.severity])
    const first = active[0]
    if (first === undefined) return null
    return { status: alertTypeOf(first.alarm.severity), label: flaps.get(first.alarm.ruleId)!, others: active.length - 1, expected: first.expected }
  }
  const expectedGroups = $derived([...new Set(mimic.items.flatMap(item => alertOf(item)?.expected ?? []))])

  const dimmed = (item: MimicDrawnItem): boolean => highlight !== null
    && !item.binding.frames.some(frame => highlight.has(frame.ruleId))
    && alertOf(item) === null

  const format = (value: number, unit: string): string => formatQuantity(value, unit)
  const flapHeight = openBridgeDevice.flapHeight

  // Device rows as OpenBridge readout rows: integers with units (a valve's opening, a generator's MW) and state words.
  const deviceRows = (item: MimicDrawnItem, look: ItemLook): OpenBridgeMimic.DeviceRows['rows'] => item.rows.flatMap((row): OpenBridgeMimic.DeviceRows['rows'] => {
    if (row.kind === 'position' && look.state.kind === 'position' && look.state.fraction >= 0.05 && look.state.fraction <= 0.95) {
      return [{ type: 'value' as const, value: Math.round(look.state.fraction * 100), unit: '%' }]
    }
    // A key value reads as a whole number within its instrument's span; at an end of it, or without a reading, in words (rowText).
    const reading = row.kind === 'value' ? valueRowReading(row, index) : null
    if (row.kind === 'value' && reading !== null && reading.end === null && !reading.wider) {
      return [{ type: 'value' as const, value: Math.round(displayValue(reading.value, row.unit)), unit: unitLabel(row.unit) }]
    }
    const text = rowText(row, look, index, format)
    // Every state word reads at one weight, RUN as STOP, OPEN as SHUT, LIVE as DEAD (HMI review of run 23: RUN was the faintest
    // text on the drawing, though the answer's key fact); what departs from what is commanded is outlined, never told by weight.
    return text === '' ? [] : [{ type: 'state' as const, text, emphasis: true }]
  })


  // A pipe drawn for grouped equipment's parallel pipes carries flow while any
  // of them does; a stub reads as every line it stands for.
  const stubOf = (pipeId: string) => mimic.stubs.find(stub => pipeId.startsWith(`${stub.id}.`))
  const pipeLook = (pipe: { readonly id: string; readonly state: MimicPipeState }) => pipeStatesLook(stubOf(pipe.id)?.states ?? [pipe.state], index)

  // Headers carry flow while any pipe that tees into them does, so a header never contradicts its branches.
  const barValue = (item: MimicDrawnItem) => {
    const touching = mimic.pipes.filter(pipe => pipe.points.some(([x, y]) => x >= item.box.x && x <= item.box.x + item.box.width && y >= item.box.y && y <= item.box.y + item.box.height))
    const values = touching.map(pipe => pipeValue(pipeLook(pipe)))
    return values.includes('open-flow') ? 'open-flow' : values.length > 0 && values.every(value => value === 'empty') ? 'empty' : 'closed-dash'
  }

  const segments = $derived.by((): Segment[] => {
    const pipes = mimic.pipes.flatMap(pipe => {
      const look = pipeLook(pipe)
      const value = pipeValue(look)
      const size = pipe.carrier === 'electricalPower' ? 'small' : 'medium'
      const chevron = look === 'forward' || look === 'reverse' ? chevronSegment(pipe.id, pipe.points, pipe.gaps, value, size, look === 'reverse') : null
      return [...pipeSegments(pipe.id, pipe.points, pipe.gaps, value, size), ...(chevron === null ? [] : [chevron])]
    })
    const bars = mimic.items.filter(item => item.presentation.element === 'bar').map((item): Segment => {
      const horizontal = item.box.width >= item.box.height
      const x = item.box.x + item.box.width / 2
      const y = item.box.y + item.box.height / 2
      return horizontal
        ? { kind: 'straight', connectionId: item.id, value: barValue(item), size: 'large', x1: item.box.x, y1: y, x2: item.box.x + item.box.width, y2: y }
        : { kind: 'straight', connectionId: item.id, value: barValue(item), size: 'large', x1: x, y1: item.box.y, x2: x, y2: item.box.y + item.box.height }
    })
    const ends = mimic.stubs.map(stub => {
      const pipe = mimic.pipes.find(candidate => candidate.id.startsWith(`${stub.id}.`))!
      const look = pipeStatesLook(stub.states, index)
      return stubEndSegment(pipe.id, pipe.points, stub.direction, pipeValue(look), pipe.carrier === 'electricalPower' ? 'small' : 'medium', look === 'forward')
    })
    return [...pipes, ...bars, ...ends]
  })

  $effect(() => {
    void theme
    if (openBridge !== null && canvas !== undefined) openBridge.drawPipes(canvas, mimic.width, mimic.height, segments, $displayFrame.zoom)
  })

  type Ob = typeof OpenBridgeMimic
  type Element = HTMLElement & Record<string, unknown>

  // Each OpenBridge element is created once and restyled by every sample.
  const device = (host: HTMLElement, params: { ob: Ob; item: MimicDrawnItem; look: ItemLook; rows: ReturnType<typeof deviceRows>; alert: ReturnType<typeof alertOf> }) => {
    const element = params.ob.createDevice(mimic.readoutSize)
    host.append(element)
    const apply = (next: typeof params) => {
      if (next.item.presentation.element !== 'device') return
      next.ob.updateDevice(element, next.item.presentation.icon, next.look, {
        tag: next.item.binding.label,
        orientation: next.item.orientation,
        textSide: next.item.text?.side === 'bottom' ? 'bottom' : 'right',
        rows: next.rows,
        // The frame is drawn around the room the server reserved, so a long flap label is never cut.
        alert: null,
      })
    }
    apply(params)
    return { update: apply, destroy: () => element.remove() }
  }

  const vessel = (host: HTMLElement, params: { ob: Ob; item: MimicDrawnItem; look: ItemLook }) => {
    const presentation = params.item.presentation
    const element: Element = presentation.element === 'heat-exchanger' ? params.ob.createHeatExchanger() : params.ob.createTank(presentation.element === 'tank' ? presentation.tank : 'pressurized')
    element.style.width = '100%'
    element.style.height = '100%'
    host.append(element)
    const apply = (next: typeof params) => {
      if (next.item.presentation.element === 'tank') next.ob.updateTank(element, next.look.state.kind === 'level' ? next.look.state.percent : null)
    }
    apply(params)
    return { update: apply, destroy: () => element.remove() }
  }

  // A value row's readout block, before its unit (and after WR where the row reads its wider instrument); at an
  // end of the span it reads, "<0" in low-integrity style, as a readout shows a reading off its span.
  const readout = (host: HTMLElement, params: { ob: Ob; reading: ReturnType<typeof valueRowReading>; unit: string }) => {
    const element = params.ob.createReadoutBlock()
    host.insertBefore(element, host.lastElementChild)
    const apply = (next: typeof params) => {
      const reading = next.reading
      const value = reading === null ? null : displayValue(reading.value, next.unit)
      // The wider instrument in whole units (compile-mimic.ts valueRowSize).
      next.ob.updateReadoutBlock(element, value, value === null ? 1 : reading?.wider === true ? 0 : valueDigits(value), 3, reading === null || reading.end === null ? null : readingValueText(reading.value, next.unit, null, reading.span))
    }
    apply(params)
    return { update: apply, destroy: () => element.remove() }
  }

  // The flap names the most severe active alarm whole, what it watches and what the I&C does there ("LO-LO · AFW
  // START"), where its frame is wide enough, else what it watches with the action on its next line; the item
  // counts its other alarms ("+2 alarms"), a vessel in its stack, a device on its flap's next line. So one item
  // reads alike on every display that draws it. The alarms panel lists every one.
  const flapOf = (item: MimicDrawnItem, alert: NonNullable<ReturnType<typeof alertOf>>) =>
    flapTexts(alert.label, alert.others, text => item.frame !== null && textWidth('alertLabel', text) + openBridgeDevice.flapLabelInset <= item.frame.width, flapPlaces(item))
  const frame = (host: HTMLElement, params: { ob: Ob; alert: NonNullable<ReturnType<typeof alertOf>>; flap: string }) => {
    const element = params.ob.createAlertFrame()
    element.style.width = '100%'
    element.style.height = '100%'
    host.append(element)
    const apply = (next: typeof params) => next.ob.updateAlertFrame(element, next.alert.status, next.flap)
    apply(params)
    return { update: apply, destroy: () => element.remove() }
  }

  const keyGlyph = (host: HTMLCanvasElement, params: { ob: Ob; value: 'open-flow' | 'empty' | 'closed-dash'; chevron: boolean; theme: string; zoom: number }) => {
    const draw = (next: typeof params) => next.ob.drawPipes(host, 24, 10, [
      ...pipeSegments('key', [[0, 5], [24, 5]], [], next.value, 'medium'),
      ...(next.chevron ? [chevronSegment('key', [[0, 5], [24, 5]], [], next.value, 'medium', false)!] : []),
    ], next.zoom)
    draw(params)
    return { update: draw }
  }

  const equipmentWords = $derived(mimic.items
    .filter(item => item.presentation.element !== 'bar')
    .map(item => `${item.binding.label}: ${looks.get(item.id)?.words || 'no state drawn'}`)
    .join('; '))
  const drawsRelief = $derived(mimic.items.some(item => item.binding.state?.aspect === 'position' && item.binding.state.state === undefined))

  // What a click on an item covers: its symbol and its text stack, which the layout keeps clear of every other item.
  const target = (item: MimicDrawnItem): { x: number; y: number; width: number; height: number } => {
    const boxes = [item.box, ...(item.text === null ? [] : [item.text])]
    const x = Math.min(...boxes.map(box => box.x))
    const y = Math.min(...boxes.map(box => box.y))
    return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x, height: Math.max(...boxes.map(box => box.y + box.height)) - y }
  }

  // An abnormal item is outlined just outside its symbol and text, inside the clearance the layout keeps around them.
  const abnormalInset = 2
  const abnormalBox = (item: MimicDrawnItem): string => {
    const area = target(item)
    return `left:${area.x - abnormalInset}px;top:${area.y - abnormalInset}px;width:${area.width + 2 * abnormalInset}px;height:${area.height + 2 * abnormalInset}px`
  }
</script>

<div class="mimic-panel" role={open === undefined ? 'img' : 'group'} aria-label={`Equipment mimic${stale ? ' (stale: states not current)' : ''}. ${equipmentWords}`}>
  <div class="viewport" bind:clientWidth={columnWidth} style={`height:${Math.ceil(mimic.height * scale)}px`}>
  <div class="drawing" style={`width:${mimic.width}px;height:${mimic.height}px;transform:scale(${scale})`}>
    {#each mimic.zones as zone (zone.lane)}
      <div class="zone" style={`left:${zone.x}px;top:${zone.y}px;width:${zone.width}px;height:${zone.height}px`} title={zone.label}></div>
    {/each}
    <canvas class="pipes" class:dimmed={highlight !== null} bind:this={canvas}></canvas>
    {#if openBridge !== null}
      {@const ob = openBridge}
      <!-- A read-only advisory drawing: nothing in it can be focused or clicked. -->
      <div class="symbols" inert>
        {#each mimic.items as item (item.id)}
          {@const look = looks.get(item.id)!}
          {@const alert = alertOf(item)}
          <div class="item" class:dimmed={dimmed(item)} class:expected={alert !== null && alert.expected !== null}>
          {#if alert !== null && item.frame !== null}
            {@const flap = flapOf(item, alert)}
            {@const below = item.flapLines.length}
            <!-- OpenBridge draws the flap below the framed region; the server reserved it and a device's further flap lines under it. -->
            <div class="box frame-box" style={`left:${item.frame.x}px;top:${item.frame.y}px;width:${item.frame.width}px;height:${item.frame.height - (1 + below) * flapHeight}px`} use:frame={{ ob, alert, flap: flap.flap }}></div>
            {#each item.flapLines as part, at (part)}
              {#if flap.parts[part] !== ''}
                <span class={`flap-line ${alert.status}`} style={`left:${item.frame.x}px;top:${item.frame.y + item.frame.height - (below - at) * flapHeight}px;width:${item.frame.width}px;height:${flapHeight}px;padding-left:${openBridgeDevice.flapLabelInset}px`}>{flap.parts[part]}</span>
              {/if}
            {/each}
          {:else if itemTreatment(look, alert !== null, shutdownDemanded(item.rows, index)) === 'abnormal'}
            <!-- Not following its command: abnormal, outlined in OpenBridge's enhanced colour, never an alarm colour. -->
            <div class="abnormal" style={abnormalBox(item)}></div>
          {/if}
          {#if item.presentation.element === 'device'}
            <div class="anchor" style={`left:${item.box.x + item.box.width / 2}px;top:${item.box.y + item.box.height / 2}px`} use:device={{ ob, item, look, rows: deviceRows(item, look), alert }}></div>
          {:else}
            {#if item.presentation.element === 'tank' || item.presentation.element === 'heat-exchanger'}
              <div class="box" style={`left:${item.box.x}px;top:${item.box.y}px;width:${item.box.width}px;height:${item.box.height}px`} use:vessel={{ ob, item, look }}></div>
            {/if}
            {#if item.text !== null}
              <!-- A stack over its symbol stands on it: its tag on the body, its rows above, centred (a hub's downstream end). -->
              {@const above = item.text.side === 'top' && item.presentation.element !== 'bar'}
              <div class="stack" class:below={item.text.side === 'bottom'} class:above style={`left:${item.text.x}px;top:${item.text.y}px;width:${item.text.width}px${above ? `;height:${item.text.height}px` : ''}`}>
                <span class="tag">{item.binding.label}</span>
                {#each item.rows as row, at (at)}
                  {#if row.kind === 'alarm'}
                    <!-- What the flap's alarm does where the flap is too narrow for it whole, and how many others are active. -->
                    <span class={`alarm-row ${alert?.status ?? ''}`}>{alert === null ? '' : flapOf(item, alert).parts[row.part]}</span>
                  {:else if row.kind === 'value'}
                    {@const reading = valueRowReading(row, index)}
                    <span class="value-row" use:readout={{ ob, reading, unit: row.unit }}>{#if row.letters !== undefined}<span class="unit">{row.letters}</span>{/if}{#if reading?.wider === true}<span class="unit">{WIDER_RANGE}</span>{/if}<span class="unit">{unitLabel(row.unit)}</span></span>
                  {:else if row.kind === 'shutdown'}
                    <!-- Whether it has stopped, written like its tag; a trip it does not follow in the command's colour. -->
                    <span class="shutdown-row" class:emphasis={row.part === 'command'}>{rowText(row, look, index, format)}</span>
                  {:else}
                    {@const text = rowText(row, look, index, format)}
                    {#if text !== ''}<span class="state-row" class:emphasis={row.kind === 'mismatch'}>{text}</span>{/if}
                  {/if}
                {/each}
              </div>
            {/if}
          {/if}
          </div>
        {/each}
        {#each mimic.stubs as stub (stub.id)}
          {#if stub.textBox !== null}
            <!-- A power line's far end says on a line under its name whether it is live. -->
            <span class="stub tag" style={`left:${stub.textBox.x}px;top:${stub.textBox.y}px`}>{stub.text}{#if stub.states.some(state => state.kind === 'power')}<br />{powerStateWord(pipeStatesLook(stub.states, index) as 'live' | 'dead' | 'unknown')}{/if}</span>
          {/if}
        {/each}
      </div>
      {#if open !== undefined}
        {@const opens = open}
        <div class="targets">
          {#each mimic.items as item (item.id)}
            {@const area = target(item)}
            <button type="button" class="target" style={`left:${area.x}px;top:${area.y}px;width:${area.width}px;height:${area.height}px`} title={`Open ${item.binding.label}`} aria-label={`Open ${item.binding.label}: ${looks.get(item.id)?.words || 'no state drawn'}`} onclick={() => opens(item)}></button>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
  </div>
  <!-- The key names only what this drawing can show; a stale view says so first. -->
  <p class="legend">
    {#if stale}<span class="stale-tag">{mimicLegend.stale}</span><span>{mimicLegend.staleMeaning}</span>{/if}
    {#if openBridge !== null}
      <span class="key"><canvas use:keyGlyph={{ ob: openBridge, value: 'open-flow', chevron: true, theme, zoom: $displayFrame.zoom }}></canvas>{mimicLegend.flow}</span>
      <span class="key"><canvas use:keyGlyph={{ ob: openBridge, value: 'empty', chevron: false, theme, zoom: $displayFrame.zoom }}></canvas>{mimicLegend.noFlow}</span>
      <span class="key"><canvas use:keyGlyph={{ ob: openBridge, value: 'closed-dash', chevron: false, theme, zoom: $displayFrame.zoom }}></canvas>{mimicLegend.unknownFlow}</span>
    {/if}
    <span class="key"><span class="abnormal-key">{mimicLegend.command}</span>{mimicLegend.commandMeaning}</span>
    {#if drawsRelief}<span>{mimicLegend.notComputed}</span>{/if}
    {#each expectedGroups as group (group)}<span class="key"><span class="expected-key"></span>{mimicLegend.expected} {group}</span>{/each}
    <span>{mimicLegend.simulator}</span>
  </p>
</div>

<style>
  .mimic-panel { display: flex; flex-direction: column; gap: 2px; }
  .viewport { overflow-x: auto; overflow-y: hidden; }
  .drawing { position: relative; transform-origin: 0 0; }
  .zone { position: absolute; box-sizing: border-box; border: 1px solid var(--border-divider-color, var(--element-neutral-color)); border-radius: 4px; }
  .pipes { position: absolute; left: 0; top: 0; }
  /* OpenBridge positions a point device at its symbol centre; its stack must not wrap. */
  .symbols { position: absolute; inset: 0; white-space: nowrap; --obc-can-hover: 0; }
  .anchor { position: absolute; width: 0; height: 0; }
  /* Each item's layer spans the drawing, so its parts keep their coordinates; dimming fades a whole item at once. */
  .item { position: absolute; inset: 0; }
  .dimmed { opacity: 0.4; }
  /* An alarm expected after a first-out it followed: its frame, flap and alarm rows faded, the item itself as drawn. */
  .item.expected .frame-box, .item.expected .flap-line, .item.expected .alarm-row { opacity: 0.45; }
  .expected-key { display: inline-block; width: 14px; height: 9px; box-sizing: border-box; border: 2px solid var(--alert-alarm-color); border-radius: 2px; opacity: 0.45; }
  .box { position: absolute; }
  .stack { position: absolute; display: flex; flex-direction: column; align-items: flex-start; }
  .stack.below { align-items: center; }
  .stack.above { flex-direction: column-reverse; align-items: center; }
  .tag { font: 370 12px/16px "Noto Sans", system-ui, sans-serif; color: var(--element-neutral-color); }
  .stub { position: absolute; }
  .value-row { display: inline-flex; align-items: baseline; gap: 4px; height: 20px; }
  .unit { font: 370 16px/20px "Noto Sans", system-ui, sans-serif; color: var(--element-neutral-color); }
  .state-row { font: 400 16px/20px "Noto Sans", system-ui, sans-serif; color: var(--element-neutral-color); }
  .state-row.emphasis { color: var(--element-active-color); }
  .shutdown-row { min-height: 16px; font: 370 12px/16px "Noto Sans", system-ui, sans-serif; color: var(--element-neutral-color); }
  .shutdown-row.emphasis { color: var(--element-active-color); }
  .legend { margin: 0; display: flex; align-items: center; gap: 10px; height: 14px; font: 400 11px/14px "Noto Sans", system-ui, sans-serif; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; }
  .key { display: inline-flex; align-items: center; gap: 4px; }
  .targets { position: absolute; inset: 0; pointer-events: none; }
  .target { position: absolute; padding: 0; border: none; border-radius: 4px; background: none; cursor: pointer; pointer-events: auto; }
  .target:hover { outline: 1px solid var(--border-outline-color); outline-offset: 2px; }
  .target:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 2px; }
  /* A device's further flap lines, in the flap's colours: its action where the flap is too narrow for it whole, and the count of its other alarms. */
  .flap-line { position: absolute; box-sizing: border-box; display: flex; align-items: center; border-radius: 0 0 4px 4px; font: 370 12px/16px "Noto Sans", system-ui, sans-serif; }
  .flap-line.alarm { background: var(--alert-alarm-color); color: var(--on-alarm-active-color); }
  .flap-line.warning { background: var(--alert-warning-color); color: var(--on-warning-active-color); }
  .flap-line.caution { background: var(--alert-caution-color); color: var(--on-caution-active-color); }
  /* A vessel's alarm rows, written like its tag in its alarm's colour. */
  .alarm-row { min-height: 16px; font: 370 12px/16px "Noto Sans", system-ui, sans-serif; }
  .alarm-row.alarm { color: var(--alert-alarm-color); }
  .alarm-row.warning { color: var(--alert-warning-color); }
  .alarm-row.caution { color: var(--alert-caution-color); }
  .abnormal { position: absolute; box-sizing: border-box; border: 2px solid var(--element-neutral-enhanced-color); border-radius: 4px; }
  .abnormal-key { padding: 0 3px; border: 2px solid var(--element-neutral-enhanced-color); border-radius: 3px; line-height: 10px; }
  .stale-tag { padding: 0 4px; border: 1px solid var(--element-neutral-color); border-radius: 2px; color: var(--element-active-color); font-weight: 700; line-height: 12px; }
</style>
