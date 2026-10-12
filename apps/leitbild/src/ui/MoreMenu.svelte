<script lang="ts" module>
  import type { IconName } from './icons.ts'

  export interface MoreMenuItem {
    readonly label: string
    /** A link item; otherwise `onselect` runs. */
    readonly href?: string
    readonly icon?: IconName
    readonly danger?: boolean
    readonly disabled?: boolean
    readonly onselect?: () => void
  }
</script>

<script lang="ts">
  // A disclosure (a11y review M7, option a): a button with aria-expanded and
  // plain buttons or links inside, no menu roles. Esc closes and returns focus
  // to the button; leaving it with Tab or a click elsewhere closes it.
  import { tick, type Snippet } from 'svelte'
  import Icon from './Icon.svelte'

  let {
    label,
    items,
    tone = 'light',
    align = 'end',
    trigger,
    triggerClass = 'lb-btn lb-btn-sm',
  }: {
    /** Accessible name of the button, e.g. "More actions for Supply run". */
    label: string
    items: ReadonlyArray<MoreMenuItem>
    tone?: 'light' | 'dark'
    align?: 'start' | 'end'
    /** Visible button content; defaults to the ⋯ icon. */
    trigger?: Snippet
    triggerClass?: string
  } = $props()

  const id = `more-${Math.random().toString(36).slice(2, 8)}`
  let open = $state(false)
  // Opens towards the start edge when the end-aligned panel would leave the screen (a ⋯ near the left on a phone).
  let flipped = $state(false)
  let wrap = $state<HTMLElement | null>(null)
  let button = $state<HTMLButtonElement | null>(null)

  /** Returns focus to the ⋯ button, e.g. after an inline rename ends. */
  export function focus(): void { button?.focus() }

  const toggle = async (): Promise<void> => {
    open = !open
    if (!open) return
    flipped = false
    await tick()
    const panel = wrap?.querySelector<HTMLElement>('.more-panel')
    const box = panel?.getBoundingClientRect()
    if (box && (align === 'end' ? box.left < 8 : box.right > innerWidth - 8)) flipped = true
    wrap?.querySelector<HTMLElement>('.more-panel button:not([disabled]), .more-panel a')?.focus()
  }
  const close = (returnFocus: boolean): void => {
    if (!open) return
    open = false
    if (returnFocus) button?.focus()
  }
  const select = (item: MoreMenuItem): void => {
    open = false
    item.onselect?.()
  }
  const onkeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    event.stopPropagation()
    close(true)
  }
  // Safari does not focus a clicked button, so a null relatedTarget is not "left".
  const onfocusout = (event: FocusEvent): void => {
    const next = event.relatedTarget
    if (next instanceof Node && wrap && !wrap.contains(next)) close(false)
  }
  const onpointerdown = (event: PointerEvent): void => {
    if (open && wrap && event.target instanceof Node && !wrap.contains(event.target)) close(false)
  }
</script>

<svelte:document onpointerdown={onpointerdown} />

<!-- Esc and focus leaving are handled for the whole disclosure, button and panel. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="more {tone}" bind:this={wrap} {onkeydown} {onfocusout}>
  <button bind:this={button} class={triggerClass} type="button" aria-expanded={open} aria-controls={id} aria-label={trigger ? undefined : label}
    title={trigger ? undefined : label} onclick={() => void toggle()}
  >{#if trigger}{@render trigger()}{:else}<Icon name="dots" />{/if}</button>
  <div class="more-panel" class:start={(align === 'start') !== flipped} {id} hidden={!open}>
    {#each items as item (item.label)}
      {#if item.href}
        <a class:danger={item.danger} href={item.href} onclick={() => { open = false }}>{#if item.icon}<Icon name={item.icon} size={17} />{/if}{item.label}</a>
      {:else}
        <button type="button" class:danger={item.danger} disabled={item.disabled} onclick={() => select(item)}>{#if item.icon}<Icon name={item.icon} size={17} />{/if}{item.label}</button>
      {/if}
    {/each}
  </div>
</div>

<style>
  .more { position: relative; display: inline-flex; }
  .more-panel {
    position: absolute; z-index: 30; top: calc(100% + 6px); right: 0; min-width: 196px; max-width: calc(100vw - 16px); padding: 6px;
    display: grid; gap: 2px; border: 1px solid var(--lb-line); border-radius: var(--lb-r-md);
    background: var(--lb-surface); box-shadow: var(--lb-shadow-pop);
  }
  .more-panel.start { right: auto; left: 0; }
  .more-panel[hidden] { display: none; }
  .more-panel button, .more-panel a {
    display: flex; align-items: center; justify-content: flex-start; gap: .55rem; width: 100%; min-height: 40px; padding: 0 .75rem;
    border: 0; border-radius: var(--lb-r-sm); background: transparent; color: var(--lb-ink);
    font-size: .875rem; font-weight: 550; text-align: left; text-decoration: none; cursor: pointer;
  }
  .more-panel button:hover, .more-panel a:hover { background: var(--lb-surface-2); }
  .more-panel button:focus-visible, .more-panel a:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: -2px; }
  .more-panel .danger { color: var(--lb-danger); }
  .more-panel button[disabled] { opacity: .55; cursor: not-allowed; }
  .dark .more-panel { border-color: #0d150f; background: var(--lb-brand-900); }
  .dark .more-panel button, .dark .more-panel a { min-height: 44px; color: var(--lb-on-dark); }
  .dark .more-panel button:hover, .dark .more-panel a:hover { background: rgba(255, 255, 255, .08); }
  .dark .more-panel button:focus-visible, .dark .more-panel a:focus-visible { outline-color: var(--lb-focus-on-dark); }
  @media (pointer: coarse) { .more-panel button, .more-panel a { min-height: 44px; } }
</style>
