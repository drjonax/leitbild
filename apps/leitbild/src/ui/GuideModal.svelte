<script lang="ts">
  // TEMPORARY SHELL for lane L3's branch only: lane L4 owns GuideModal.svelte.
  // At integration take L4's file. It only honours the props Landing.svelte
  // passes (see $UX/lanes/l3.md), so the landing's ?guide links can be tested.
  import Modal from './Modal.svelte'
  import type { ModalCloseReason } from './modal-url.ts'

  let {
    open = $bindable(false), page = 'start', card = null, onroute, ontry, onclose, fallbackFocus,
  }: {
    open: boolean
    page?: string
    card?: string | null
    onroute?: (page: string, card: string | null) => void
    ontry?: (demo: string | null) => void
    onclose?: (reason: ModalCloseReason) => void
    fallbackFocus?: () => HTMLElement | null
  } = $props()
</script>

<Modal bind:open title="Getting started with Leitbild.ai" eyebrow="Leitbild.ai · Getting started" width="1120px" height="860px" {onclose} {fallbackFocus}>
  <div style="padding: 24px">
    <p>Page {page}{card ? ` · ${card}` : ''}</p>
    <button class="lb-btn" type="button" onclick={() => onroute?.('ask', null)}>Ask page</button>
    <button class="lb-btn" type="button" onclick={() => ontry?.('world:halden-offsite-power-restoration')}>Try the Halden demo</button>
  </div>
</Modal>
