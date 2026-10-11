<script lang="ts">
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'

  /**
   * Asks in place before a destructive action, instead of a browser dialog.
   * It opens with Cancel focused, so Enter or Space alone never confirms.
   * Only the confirm button acts; Cancel, Esc or a press outside it and its
   * opener cancels. Focus returns to the opener unless the press went elsewhere.
   */
  interface Props {
    readonly question: string
    readonly confirmLabel: string
    /** The element holding the control that opened this confirmation. */
    readonly opener: HTMLElement | null
    readonly confirm: () => void
    readonly cancel: () => void
  }

  const { question, confirmLabel, opener, confirm, cancel }: Props = $props()

  let root = $state<HTMLElement | null>(null)

  const focusOnMount = (element: HTMLElement): void => { element.focus() }

  const focusOpener = (): void => {
    const control = opener?.matches('button') ? opener : opener?.querySelector('button')
    control?.focus()
  }

  const confirmed = (event: MouseEvent): void => {
    event.stopPropagation()
    focusOpener()
    confirm()
  }

  const cancelled = (event: MouseEvent): void => {
    event.stopPropagation()
    focusOpener()
    cancel()
  }

  runOnMount(() => {
    const cancelOnPressElsewhere = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && (root?.contains(target) || opener?.contains(target))) return
      cancel()
    }
    const cancelOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (document.activeElement instanceof Node && root?.contains(document.activeElement)) focusOpener()
      cancel()
    }
    window.addEventListener('pointerdown', cancelOnPressElsewhere, true)
    window.addEventListener('keydown', cancelOnEscape)
    return () => {
      window.removeEventListener('pointerdown', cancelOnPressElsewhere, true)
      window.removeEventListener('keydown', cancelOnEscape)
    }
  })
</script>

<div class="inline-confirmation" role="group" aria-label={question} bind:this={root}>
  <span>{question}</span>
  <button type="button" class="inline-confirmation__confirm" onclick={confirmed}>{confirmLabel}</button>
  <button type="button" {@attach focusOnMount} onclick={cancelled}>Cancel</button>
</div>

<style>
  .inline-confirmation {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 5px 6px 5px 9px;
    border: 1px solid color-mix(in srgb, var(--critical) 45%, var(--border));
    border-radius: 6px;
    background: color-mix(in srgb, var(--critical) 7%, var(--panel));
    color: var(--text);
    cursor: default;
    font-size: 12px;
  }

  .inline-confirmation span {
    flex: 1 1 auto;
    min-width: 0;
    font-weight: 650;
    overflow-wrap: anywhere;
  }

  .inline-confirmation button {
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--panel);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }

  .inline-confirmation button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .inline-confirmation .inline-confirmation__confirm {
    border-color: var(--critical);
    background: var(--critical);
    color: #fff;
  }
</style>
