<script lang="ts">
  // Native modal <dialog> for the Host pages (VISUAL-SPEC §3.6, a11y M2).
  // - Opening records the opener and focuses the H2 (the dialog's name).
  // - Esc, ×, the backdrop or `open = false` close it; focus returns to the
  //   opener, or to `fallbackFocus()` when there is none (deep link, Back).
  // - The page behind does not scroll; below 640 px it is a full-screen sheet.
  // - Body and footer are rendered only while open.
  // It never refuses to close: a busy caller aborts its work in `onclose`.
  import { tick, type Snippet } from 'svelte'
  import Icon from './Icon.svelte'
  import type { ModalCloseReason } from './modal-url.ts'

  interface Props {
    open: boolean
    /** The H2 text and the dialog's accessible name. */
    title: string
    /** Rich H2 content (e.g. with the Wordmark); must read the same as `title`. */
    titleContent?: Snippet
    /** Mixed case in the DOM; shown uppercase. */
    eyebrow?: string
    /** Desktop width cap, a CSS length (default 720px). */
    width?: string
    /** 'content' hugs the content; a CSS length fixes the height cap (the body scrolls). */
    height?: 'content' | string
    /** false when the caller lays out and scrolls its own body (the guide's rail + pages). */
    scrollBody?: boolean
    /** Extra class on <dialog>, for :global() styling by the caller. */
    class?: string
    /** Between the titles and ×, e.g. the guide's Contents button. */
    headerExtra?: Snippet
    children: Snippet
    footer?: Snippet | undefined
    onclose?: ((reason: ModalCloseReason) => void) | undefined
    /** Focus target when the opener is gone or there was none: the matching hero CTA. */
    fallbackFocus?: (() => HTMLElement | null) | undefined
    closeLabel?: string
  }

  let {
    open = $bindable(), title, titleContent, eyebrow, width = '720px', height = 'content', scrollBody = true,
    class: className = '', headerExtra, children, footer, onclose, fallbackFocus, closeLabel = 'Close',
  }: Props = $props()

  const uid = `modal-${Math.random().toString(36).slice(2, 8)}`
  let dialog = $state<HTMLDialogElement | null>(null)
  let heading = $state<HTMLElement | null>(null)
  let opener: HTMLElement | null = null
  let pendingReason: ModalCloseReason = 'programmatic'

  /** Move focus to the dialog's heading (after a page change, an error being cleared…). */
  export function focusTitle(): void { heading?.focus() }
  export function element(): HTMLDialogElement | null { return dialog }

  const restoreFocus = (): void => {
    const target = opener?.isConnected ? opener : fallbackFocus?.() ?? null
    opener = null
    target?.focus()
  }

  $effect(() => {
    if (!dialog) return
    if (open && !dialog.open) {
      const active = document.activeElement
      opener = active instanceof HTMLElement && active !== document.body && !dialog.contains(active) ? active : null
      dialog.showModal()
      void tick().then(() => heading?.focus())
    }
    if (!open && dialog.open) {
      pendingReason = 'programmatic'
      dialog.close()
    }
  })

  const onClose = (): void => {
    const reason = pendingReason
    pendingReason = 'programmatic'
    if (open) open = false
    onclose?.(reason)
    restoreFocus()
  }
  const onCancel = (): void => { pendingReason = 'escape' }
  const closeWith = (reason: ModalCloseReason): void => {
    pendingReason = reason
    dialog?.close()
  }
  // A press that starts inside the dialog and ends on the backdrop is not a backdrop click.
  let pressStartedOnBackdrop = false
  const onPointerDown = (event: PointerEvent): void => { pressStartedOnBackdrop = event.target === dialog }
  const onClick = (event: MouseEvent): void => {
    if (event.target === dialog && pressStartedOnBackdrop) closeWith('backdrop')
    pressStartedOnBackdrop = false
  }
</script>

<dialog bind:this={dialog} class="lb-modal {className}" class:hug={height === 'content'} aria-labelledby={`${uid}-title`}
  style:--modal-w={width} style:--modal-h={height === 'content' ? 'none' : height}
  onclose={onClose} oncancel={onCancel} onpointerdown={onPointerDown} onclick={onClick}
>
  <header class="head">
    <div class="titles">
      {#if eyebrow}<span class="lb-eyebrow">{eyebrow}</span>{/if}
      <h2 bind:this={heading} id={`${uid}-title`} tabindex="-1">{#if titleContent}{@render titleContent()}{:else}{title}{/if}</h2>
    </div>
    {#if headerExtra}{@render headerExtra()}{/if}
    <button class="close" type="button" aria-label={closeLabel} onclick={() => closeWith('close-button')}><Icon name="close" size={20} /></button>
  </header>
  <!-- Content exists only while open: images load and carousels start (stopped or not) when the user opens it. -->
  {#if open}
    <div class="body" class:scroll={scrollBody}>{@render children()}</div>
    {#if footer}<footer class="foot">{@render footer()}</footer>{/if}
  {/if}
</dialog>

<style>
  .lb-modal { width: min(var(--modal-w), calc(100vw - 32px)); height: min(var(--modal-h), calc(100dvh - 32px)); max-width: none; max-height: calc(100dvh - 32px);
    padding: 0; border: 1px solid var(--lb-line-strong); border-radius: var(--lb-r-xl); background: var(--lb-surface); color: var(--lb-ink);
    box-shadow: var(--lb-shadow-lg); overflow: hidden; }
  /* A modal <dialog> is inset 0, so height: auto would stretch it to the viewport; fit-content hugs the content. */
  .lb-modal.hug { height: fit-content; }
  /* One column no wider than the dialog: wide nowrap content scrolls or ellipsises inside it, never widens it. */
  .lb-modal[open] { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; animation: modal-in var(--lb-t-base) var(--lb-ease); }
  .lb-modal::backdrop { background: rgba(10, 16, 12, .56); backdrop-filter: blur(3px); }
  @keyframes modal-in { from { opacity: 0; transform: translateY(8px) scale(.985); } }

  .head { display: flex; align-items: center; gap: 16px; min-height: 64px; padding: 12px 16px 12px 24px; border-bottom: 1px solid var(--lb-line); background: var(--lb-surface); }
  .titles { flex: 1; min-width: 0; }
  .titles .lb-eyebrow { display: block; margin-bottom: 4px; }
  /* 4 px of inline padding (cancelled by the margin) keep the focus ring off the first and last letter. */
  h2 { width: fit-content; margin: 0 -4px; padding: 0 4px; font-size: 1.125rem; line-height: 1.25; font-weight: 700; letter-spacing: -.01em; }
  h2:focus { outline: none; }
  /* A deep link focuses the title by script, so Chrome shows this ring: it stays clear of the eyebrow above. */
  h2:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 0; border-radius: 4px; }
  .close { display: inline-grid; place-items: center; flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0;
    border: 1px solid transparent; border-radius: var(--lb-r-md); background: transparent; color: var(--lb-ink-2); cursor: pointer; }
  .close:hover { color: var(--lb-ink); background: rgba(23, 32, 25, .06); border-color: transparent; }
  .close:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .body { min-height: 0; }
  .body.scroll { overflow-y: auto; overscroll-behavior: contain; }
  .foot { display: flex; align-items: center; gap: 12px; min-height: 68px; padding: 12px 16px; border-top: 1px solid var(--lb-line); background: var(--lb-surface-2); }

  /* Phones: a full-screen sheet. */
  @media (max-width: 639px) {
    .lb-modal, .lb-modal.hug { width: 100vw; height: 100dvh; max-height: none; border: 0; border-radius: 0; }
    .head { min-height: 56px; padding: 8px 8px 8px 16px; }
    .foot { padding: 10px 12px; }
  }
  /* Short viewports (400 % zoom): compact header, footer scrolls with the body. */
  @media (max-height: 500px) {
    .lb-modal[open] { display: block; overflow-y: auto; }
    .head { min-height: 0; padding-block: 4px; }
    .body.scroll { overflow: visible; }
  }
  @media (prefers-reduced-motion: reduce) { .lb-modal[open] { animation: none; } }
</style>
