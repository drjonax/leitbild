<script lang="ts">
  import { tick } from 'svelte'
  import { composingKeystroke } from './ime.ts'
  let { value, fallback, label, onsave, pencil = true, onclose }: {
    value: string
    fallback: string
    label: string
    onsave: (name: string, original: string) => Promise<void>
    /** Show the pencil button; without it a caller starts editing with `edit()` (e.g. from a ⋯ menu). */
    pencil?: boolean
    /** Editing ended; after 'saved' or 'cancelled' the caller can put focus back where it came from. */
    onclose?: (reason: 'saved' | 'cancelled' | 'blurred') => void
  } = $props()
  let editing = $state(false)
  let draft = $state('')
  let original = ''
  let saving = $state(false)
  let error = $state<string | null>(null)
  let input = $state<HTMLInputElement | null>(null)

  export async function edit(): Promise<void> {
    draft = value
    original = value
    error = null
    editing = true
    await tick()
    input?.focus()
    input?.select()
  }
  const save = async (): Promise<void> => {
    if (saving) return
    saving = true
    error = null
    try {
      if (draft.trim() !== original) await onsave(draft.trim(), original)
      editing = false
      onclose?.('saved')
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally { saving = false }
  }
</script>

<span class="inline-name" class:editing>
  {#if editing}
    <input bind:this={input} bind:value={draft} aria-label={label} placeholder={fallback} maxlength="256" disabled={saving}
      onkeydown={event => {
        if (composingKeystroke(event)) return
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void save() }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editing = false; onclose?.('cancelled') }
      }}
      onblur={() => { if (!saving && !error) { editing = false; onclose?.('blurred') } }} />
    {#if error}<small class="inline-error" role="alert">{error}</small>{/if}
  {:else}
    <span class="name-text">{value || fallback}</span>
    {#if pencil}<button class="name-edit card-control" type="button" title="Rename" aria-label={label} onclick={() => void edit()}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5M3 21l5-1L21 7a3.5 3.5 0 0 0-5-5L3 15z" /></svg>
    </button>{/if}
  {/if}
</span>
