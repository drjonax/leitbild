<script lang="ts">
  import type { ScenarioGuidance as ScenarioGuidanceModel } from '../core/model/index.ts'

  interface Props {
    readonly guidance: ScenarioGuidanceModel
    readonly close: () => void
    /** The card's bottom edge in the viewport, measured whenever its size changes: the alarm strip starts below it. */
    bottom?: number
  }

  let { guidance, close, bottom = $bindable(0) }: Props = $props()
  // Laid-out offsets, not the drawn rectangle: the card is fixed, and a startup screen may still hold it off screen.
  const measure = (card: HTMLElement) => {
    const observer = new ResizeObserver(() => { bottom = card.offsetTop + card.offsetHeight })
    observer.observe(card)
    return () => observer.disconnect()
  }
</script>

<aside class="scenario-guidance" aria-live="polite" {@attach measure}>
  <div>
    <strong class:update-title={guidance.tone === 'update'}>{guidance.title}</strong>
    <p>{guidance.message}</p>
  </div>
  {#if guidance.dismissible}
    <button type="button" aria-label="Dismiss guidance" onclick={close}>×</button>
  {/if}
</aside>
