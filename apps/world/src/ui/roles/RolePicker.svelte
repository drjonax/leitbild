<script lang="ts">
  import type { RunRoles } from '../../core/model/index.ts'
  import ModalShell from '../components/ModalShell.svelte'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import { pickerCards, roleSetText, togglePickerEntry } from './role-controller.ts'

  /**
   * Shown when a screen opens a Run that declares roles without holding one.
   * One card per role and preset; the ticked roles are joined as one set.
   * The screen has not joined yet, so no Pack is loaded to say what a role
   * commands; the role bar's add menu carries that line once one does.
   */
  interface Props {
    readonly runTitle: string
    readonly declaration: RunRoles
    readonly initialHolders: Readonly<Record<string, number>>
    /** Reads the public presence again, so the counts stay current while the picker is open. */
    readonly loadHolders: () => Promise<Readonly<Record<string, number>>>
    readonly join: (roleIds: ReadonlyArray<string>) => void
  }

  const { runTitle, declaration, initialHolders, loadHolders, join }: Props = $props()

  let ticked = $state<ReadonlyArray<string>>([])
  let polledHolders = $state<Readonly<Record<string, number>> | null>(null)
  let presenceError = $state<string | null>(null)
  const holders = $derived(polledHolders ?? initialHolders)
  const cards = $derived(pickerCards(declaration, { ticked, holders }))

  runOnMount(() => {
    let active = true
    const poll = window.setInterval(() => {
      void (async () => {
        try {
          const next = await loadHolders()
          if (active) { polledHolders = next; presenceError = null }
        } catch (error) {
          if (active) presenceError = error instanceof Error ? error.message : String(error)
        }
      })()
    }, 2_000)
    return () => { active = false; window.clearInterval(poll) }
  })
</script>

<ModalShell
  title="Choose your roles"
  description={`${runTitle} declares roles. Tick one or more: you play their union. Anyone may pick any role.`}
  close={() => {}}
  closeOnBackdrop={false}
  closeOnEscape={false}
  showClose={false}
>
  <div class="role-cards">
    {#each cards as card (card.id)}
      <label class="role-card" class:ticked={card.ticked}>
        <input type="checkbox" checked={card.ticked} onchange={() => { ticked = togglePickerEntry(declaration, ticked, card.id) }} />
        {#if card.sideColour}<span class="role-card__side" style:background={card.sideColour}></span>{/if}
        <span class="role-card__text">
          <strong>{card.label}</strong>
          <small>{card.kind === 'preset' ? `Preset · ${roleSetText(declaration, card.roleIds)}` : card.roleClass === 'controller' ? 'Controller · sees and commands everything' : 'Operator'}</small>
        </span>
        {#if card.key}<kbd title={`P then ${card.key} switches to this later`}>{card.key}</kbd>{/if}
        {#if card.holders !== null}<span class="role-card__holders" title="Screens holding this role now">{card.holders} {card.holders === 1 ? 'screen' : 'screens'}</span>{/if}
      </label>
    {/each}
  </div>
  {#if presenceError}<p class="role-picker__error">Presence unavailable: {presenceError}</p>{/if}
  {#snippet footer()}
    <button type="button" class="role-picker__join" disabled={ticked.length === 0} onclick={() => join(ticked)}>
      {ticked.length === 0 ? 'Tick a role to join' : `Join as ${roleSetText(declaration, ticked)}`}
    </button>
  {/snippet}
</ModalShell>

<style>
  .role-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 8px;
  }

  .role-card {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 9px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    cursor: pointer;
  }

  .role-card.ticked {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 7%, var(--panel));
  }

  .role-card input {
    margin: 2px 0 0;
  }

  .role-card__side {
    flex: 0 0 auto;
    width: 6px;
    align-self: stretch;
    border-radius: 3px;
  }

  .role-card__text {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .role-card__text small,
  .role-card__holders {
    color: var(--muted);
    font-size: 11px;
  }

  .role-card kbd {
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 11px;
    color: var(--muted);
  }

  .role-picker__error {
    margin: 8px 0 0;
    color: var(--warning);
    font-size: 12px;
  }

  .role-picker__join {
    padding: 6px 14px;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: var(--accent);
    color: #fff;
    font: inherit;
    font-weight: 650;
    cursor: pointer;
  }

  .role-picker__join:disabled {
    border-color: var(--border);
    background: var(--panel-strong);
    color: var(--muted);
    cursor: default;
  }
</style>
