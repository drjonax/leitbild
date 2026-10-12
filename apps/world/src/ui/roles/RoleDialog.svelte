<script lang="ts">
  import type { RunRoles } from '../../core/model/index.ts'
  import ModalShell from '../components/ModalShell.svelte'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import type { RoleCommandsDescriber } from './role-controller.ts'
  import {
    chooseSide,
    openRoleDialog,
    roleDialogModel,
    roleDialogResult,
    toggleControl,
    togglePreset,
    toggleSee,
    type RoleDialogDraft,
    type RoleDialogResult,
  } from './role-dialog.ts'

  /**
   * The role dialog: what this screen controls and what it sees. It opens when
   * a screen joins a Run that declares roles (`join`), and from the role bar
   * (`switch`). Presets and roles without a category are one-tap rows above a
   * tree of category, then role, with a See and a Control box per role. Every
   * row is a tap target of at least 44 px and nothing depends on hover.
   */
  interface Props {
    readonly mode: 'join' | 'switch'
    readonly runTitle: string
    readonly declaration: RunRoles
    /** The roles the screen holds now; none when joining. */
    readonly held: ReadonlyArray<string>
    /** This tab's unseen roles. */
    readonly hidden: ReadonlyArray<string>
    /** Screens holding each role, when already known; the dialog reads the presence again while open. */
    readonly initialHolders: Readonly<Record<string, number>> | null
    readonly loadHolders: () => Promise<Readonly<Record<string, number>>>
    /** A role-aware Pack's line saying what a role commands, once its Pack is loaded. */
    readonly describeCommands: RoleCommandsDescriber | undefined
    readonly apply: (result: RoleDialogResult) => void
    /** Closes without a change; absent when joining, where a role must be chosen. */
    readonly cancel: (() => void) | undefined
  }

  const { mode, runTitle, declaration, held, hidden, initialHolders, loadHolders, describeCommands, apply, cancel }: Props = $props()

  const opened = (): RoleDialogDraft => openRoleDialog(declaration, held, hidden)
  let draft = $state.raw<RoleDialogDraft>(opened())
  let polledHolders = $state<Readonly<Record<string, number>> | null>(null)
  let presenceError = $state<string | null>(null)
  const holders = $derived(polledHolders ?? initialHolders)
  const model = $derived(roleDialogModel(declaration, draft, { mode, held, holders }))
  const sideLabels = (sides: ReadonlyArray<{ readonly label: string }>): string => sides.map(side => side.label).join(' and ')
  const screens = (count: number | null): string => count === null ? '' : `${count} ${count === 1 ? 'screen' : 'screens'}`

  runOnMount(() => {
    let active = true
    const read = async (): Promise<void> => {
      try {
        const next = await loadHolders()
        if (active) { polledHolders = next; presenceError = null }
      } catch (error) {
        if (active) presenceError = error instanceof Error ? error.message : String(error)
      }
    }
    if (initialHolders === null) void read()
    const poll = window.setInterval(() => { void read() }, 2_000)
    return () => { active = false; window.clearInterval(poll) }
  })
</script>

<ModalShell
  title="Roles"
  description={mode === 'join'
    ? `${runTitle} declares roles. Control a role to play it; See shows its objects on this screen only. Anyone may pick any role.`
    : 'Control a role to play it; See shows its objects on this screen only. Control includes See; an unseen role\'s objects stay hidden even where another held role commands them.'}
  size="large"
  close={cancel ?? (() => {})}
  closeOnBackdrop={false}
  closeOnEscape={cancel !== undefined}
  showClose={cancel !== undefined}
>
  {#if model.sides.length > 0}
    <div class="role-dialog__sides" role="radiogroup" aria-label="Side">
      {#each model.sides as side (side.id)}
        <button type="button" role="radio" aria-checked={side.chosen} class:chosen={side.chosen} onclick={() => { draft = chooseSide(declaration, draft, side.id) }}>
          <span class="role-dialog__swatch" style:background={side.colour}></span>{side.label}
        </button>
      {/each}
    </div>
  {/if}
  {#if model.warning}<p class="role-dialog__warning" role="note">{model.warning}</p>{/if}

  {#if model.presets.length > 0}
    <ul class="role-dialog__presets" aria-label="Presets and roles">
      {#each model.presets as row (row.id)}
        <li>
          <label class="role-dialog__preset" class:ticked={row.ticked}>
            <input type="checkbox" checked={row.ticked} onchange={() => { draft = togglePreset(declaration, draft, row.id) }} />
            {#if row.sides.length > 0}
              <span class="role-dialog__sidebar" aria-label={`Sees ${sideLabels(row.sides)}`}>
                {#each row.sides as side (side.id)}<span style:background={side.colour}></span>{/each}
              </span>
            {/if}
            <span class="role-dialog__text">
              <strong>{row.label}</strong>
              <small>{row.kind === 'preset'
                ? `Preset · ${row.roleIds.map(roleId => declaration.roles.find(role => role.id === roleId)?.label ?? roleId).join(' + ')}`
                : row.roleClass === 'controller' ? 'Controller · sees and commands everything'
                : describeCommands?.(row.id) ?? (row.sides.length > 0 ? `Operator · sees ${sideLabels(row.sides)}` : 'Operator')}</small>
            </span>
            {#if row.holders !== null}<small class="role-dialog__holders">{screens(row.holders)}</small>{/if}
          </label>
        </li>
      {/each}
    </ul>
  {/if}

  {#each model.categories as category (category.label)}
    <section class="role-dialog__category" aria-label={category.label}>
      <header>
        <h3>{category.label}</h3>
        <span>See</span>
        <span>Control</span>
      </header>
      <ul>
        {#each category.rows as row (row.id)}
          <li class="role-dialog__row" class:controlled={row.control}>
            <span class="role-dialog__text">
              <strong>{row.label}</strong>
              {#if describeCommands?.(row.id) || row.holders !== null}
                <small>{[describeCommands?.(row.id) ?? '', screens(row.holders)].filter(part => part.length > 0).join(' · ')}</small>
              {/if}
            </span>
            <label class="role-dialog__box">
              <input type="checkbox" aria-label={`See ${row.label}`} checked={row.see} onchange={() => { draft = toggleSee(declaration, draft, row.id) }} />
            </label>
            <label class="role-dialog__box">
              <input type="checkbox" aria-label={`Control ${row.label}`} checked={row.control} onchange={() => { draft = toggleControl(declaration, draft, row.id) }} />
            </label>
          </li>
        {/each}
      </ul>
    </section>
  {/each}

  {#if model.alsoHeld.length > 0}<p class="role-dialog__also">Also held, on another side: {model.alsoHeld.join(', ')}</p>{/if}
  {#if presenceError}<p class="role-dialog__error">Presence unavailable: {presenceError}</p>{/if}

  {#snippet footer()}
    {#if cancel}<button type="button" class="role-dialog__cancel" onclick={cancel}>Cancel</button>{/if}
    <button type="button" class="role-dialog__apply" disabled={!model.canApply} onclick={() => apply(roleDialogResult(draft))}>{model.applyText}</button>
  {/snippet}
</ModalShell>

<style>
  .role-dialog__sides {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }

  .role-dialog__sides button,
  .role-dialog__cancel,
  .role-dialog__apply {
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    color: var(--text);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .role-dialog__sides button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .role-dialog__sides button.chosen {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--panel));
  }

  .role-dialog__swatch {
    width: 12px;
    height: 12px;
    border-radius: 50%;
  }

  .role-dialog__warning {
    margin: 0 0 10px;
    padding: 8px 12px;
    border: 1px solid color-mix(in srgb, var(--warning) 60%, var(--border));
    border-radius: 6px;
    background: color-mix(in srgb, var(--warning) 14%, var(--panel));
    font-weight: 600;
  }

  .role-dialog__presets,
  .role-dialog__category ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .role-dialog__presets {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 6px;
    margin-bottom: 14px;
  }

  .role-dialog__preset {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 52px;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    cursor: pointer;
  }

  .role-dialog__preset.ticked {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 7%, var(--panel));
  }

  .role-dialog__preset input,
  .role-dialog__box input {
    width: 22px;
    height: 22px;
    margin: 0;
    flex: 0 0 auto;
  }

  .role-dialog__sidebar {
    align-self: stretch;
    display: flex;
    gap: 2px;
  }

  .role-dialog__sidebar span {
    width: 6px;
    border-radius: 3px;
  }

  .role-dialog__text {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .role-dialog__text small,
  .role-dialog__holders,
  .role-dialog__also {
    color: var(--muted);
    font-size: 12px;
  }

  .role-dialog__category {
    margin-bottom: 12px;
  }

  .role-dialog__category header,
  .role-dialog__row {
    display: grid;
    grid-template-columns: 1fr 64px 64px;
    align-items: center;
  }

  .role-dialog__category header {
    padding: 0 0 4px;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    text-align: center;
  }

  .role-dialog__category h3 {
    margin: 0;
    color: var(--text);
    font-size: 14px;
    text-align: left;
  }

  .role-dialog__row {
    min-height: 48px;
    padding-left: 4px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  }

  .role-dialog__row.controlled {
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }

  .role-dialog__box {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 48px;
    min-height: 48px;
    cursor: pointer;
  }

  .role-dialog__error {
    margin: 8px 0 0;
    color: var(--warning);
    font-size: 12px;
  }

  .role-dialog__apply {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
  }

  .role-dialog__apply:disabled {
    border-color: var(--border);
    background: var(--panel-strong);
    color: var(--muted);
    cursor: default;
  }
</style>
