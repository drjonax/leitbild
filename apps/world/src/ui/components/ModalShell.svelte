<script lang="ts">
  import type { Snippet } from 'svelte'
  import { X } from 'lucide-svelte'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import StatusDot, { type StatusTone } from './StatusDot.svelte'

  interface Props {
    readonly title: string
    readonly close: () => void
    readonly closeOnBackdrop?: boolean
    readonly closeOnEscape?: boolean
    readonly showClose?: boolean
    readonly size?: 'small' | 'medium' | 'large'
    /** Where the dialog stands: centred, or pinned near the top, for a dialog whose height changes while it is in use and must not move under the finger. */
    readonly placement?: 'center' | 'top'
    readonly description?: string | null
    readonly titleTone?: StatusTone | null
    readonly children?: Snippet
    readonly footer?: Snippet
  }

  let {
    title,
    close,
    closeOnBackdrop = true,
    closeOnEscape = true,
    showClose = true,
    size = 'medium',
    placement = 'center',
    description = null,
    titleTone = null,
    children,
    footer,
  }: Props = $props()

  const closeFromBackdrop = (): void => {
    if (closeOnBackdrop) close()
  }

  const handleKeydown = (event: KeyboardEvent): void => {
    if (!closeOnEscape || event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  runOnMount(() => {
    window.addEventListener('keydown', handleKeydown)
    return () => {
      window.removeEventListener('keydown', handleKeydown)
    }
  })
</script>

<div class="modal-backdrop" class:top={placement === 'top'} role="presentation" onmousedown={closeFromBackdrop}>
  <dialog class="modal-shell {size}" open aria-modal="true" aria-label={title} onmousedown={(event) => event.stopPropagation()}>
    <header class="modal-header">
      <div>
        <h2>
          {#if titleTone}
            <StatusDot tone={titleTone} label={title} />
          {/if}
          <span>{title}</span>
        </h2>
        {#if description}
          <p>{description}</p>
        {/if}
      </div>
      {#if showClose}
        <button class="icon-button" type="button" aria-label="Close" title="Close" onclick={(event) => { event.stopPropagation(); close() }}>
          <X size={16} strokeWidth={1.8} />
        </button>
      {/if}
    </header>
    <div class="modal-body">
      {#if children}
        {@render children()}
      {/if}
    </div>
    <footer class="modal-footer">
      {#if footer}
        {@render footer()}
      {/if}
    </footer>
  </dialog>
</div>
