<script lang="ts">
  import { einsatzColors } from '../colors.ts'
  import { svgImageSource } from './board-icons.ts'

  /** A catalogue icon on a badge in its object's map colour; the artwork's white strokes read in both themes. */
  interface Props {
    readonly svg: string | undefined
    readonly tone: keyof typeof einsatzColors | 'free' | 'muted'
  }

  const { svg, tone }: Props = $props()
  const background = $derived(tone === 'free' ? 'var(--success)' : tone === 'muted' ? 'var(--muted)' : einsatzColors[tone])
</script>

<span class="board-icon" style:background aria-hidden="true">
  {#if svg !== undefined}<img src={svgImageSource(svg)} alt="" />{/if}
</span>

<style>
  .board-icon {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    display: inline-grid;
    place-items: center;
    border-radius: 50%;
  }

  img {
    width: 15px;
    height: 15px;
  }
</style>
