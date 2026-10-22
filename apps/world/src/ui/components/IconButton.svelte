<script lang="ts">
  import type { SvelteComponent } from 'svelte'
  import type { IconProps } from 'lucide-svelte'

  interface Props {
    readonly label: string
    /** A lucide-svelte icon; the package declares its icons as Svelte 4 class components. */
    readonly icon: typeof SvelteComponent<IconProps>
    readonly pressed?: boolean
    readonly disabled?: boolean
    readonly title?: string
    readonly size?: number
    readonly variant?: 'default' | 'bare' | 'ghost'
    readonly onClick: () => void | Promise<void>
  }

  let {
    label,
    icon: Icon,
    pressed = undefined,
    disabled = false,
    title = label,
    size = 16,
    variant = 'default',
    onClick,
  }: Props = $props()
</script>

<button
  class="icon-button {variant}"
  type="button"
  aria-label={label}
  aria-pressed={pressed}
  {title}
  {disabled}
  onclick={(event) => { event.stopPropagation(); void onClick() }}
>
  <Icon {size} strokeWidth={1.8} />
</button>
