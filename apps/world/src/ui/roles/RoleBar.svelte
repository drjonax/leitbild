<script lang="ts">
  import type { RunRoles } from '../../core/model/index.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import {
    addEntry,
    dropRole,
    idleRoleKeys,
    roleBarModel,
    roleKeyStep,
    roleSetText,
    switchToEntry,
    type RoleCommandsDescriber,
    type RoleKeyState,
    type RoleSetChange,
  } from './role-controller.ts'

  /**
   * The roles this screen holds, in the World header. A chip click plays only
   * that role, × drops it, + adds a role or preset, and P then a digit switches
   * to the numbered role or preset. Every change applies in place.
   */
  interface Props {
    readonly declaration: RunRoles
    /** The set this screen plays now; it stays until the Run answers a switch. */
    readonly held: ReadonlyArray<string>
    /** The set a switch asked for, while its fresh snapshot has not arrived. */
    readonly switchingTo: ReadonlyArray<string> | null
    /** A role-aware Pack's line saying what a role commands, when one supplies it. */
    readonly describeCommands: RoleCommandsDescriber | undefined
    readonly request: (change: RoleSetChange) => void
  }

  const { declaration, held, switchingTo, describeCommands, request }: Props = $props()

  const model = $derived(roleBarModel(declaration, held))
  const switching = $derived(switchingTo !== null)
  let menuOpen = $state(false)
  let keyState: RoleKeyState = idleRoleKeys

  const editableTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement
    && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

  runOnMount(() => {
    const onKeydown = (event: KeyboardEvent): void => {
      const step = roleKeyStep(keyState, {
        key: event.key,
        repeat: event.repeat,
        modified: event.ctrlKey || event.metaKey || event.altKey,
        inert: editableTarget(event.target) || document.querySelector('dialog[aria-modal="true"]') !== null,
        now: performance.now(),
      }, declaration, held)
      keyState = step.state
      if (!step.handled) return
      event.preventDefault()
      menuOpen = false
      if (step.change) request(step.change)
    }
    const onBlur = (): void => { keyState = idleRoleKeys }
    window.addEventListener('keydown', onKeydown)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('blur', onBlur)
    }
  })
</script>

<div class="role-bar" class:switching role="toolbar" aria-label="Roles held by this screen" title="P then 1–9 switches role">
  {#each model.chips as chip (chip.id)}
    <span class="role-chip" data-class={chip.roleClass}>
      {#each chip.sides as side (side.id)}<span class="role-chip__side" style:background={side.colour} title={`Sees ${side.label}`}></span>{/each}
      <button type="button" class="role-chip__label" title={`Play only ${chip.label}`} disabled={switching} onclick={() => request(switchToEntry(declaration, held, chip.id))}>{chip.label}</button>
      {#if chip.droppable}
        <button type="button" class="role-chip__drop" aria-label={`Drop ${chip.label}`} title={`Drop ${chip.label}`} disabled={switching} onclick={() => request(dropRole(declaration, held, chip.id))}>×</button>
      {/if}
    </span>
  {/each}
  {#if model.addable.length > 0}
    <span class="role-add">
      <button type="button" class="role-add__open" aria-label="Add a role" aria-expanded={menuOpen} title="Add a role or preset" disabled={switching} onclick={() => { menuOpen = !menuOpen }}>+</button>
      {#if menuOpen && !switching}
        <ul class="role-add__menu">
          {#each model.addable as entry (entry.id)}
            <li>
              <button type="button" onclick={() => { menuOpen = false; request(addEntry(declaration, held, entry.id)) }}>
                {#if entry.key}<kbd>{entry.key}</kbd>{/if}
                <span>{entry.label}</span>
                {#if entry.kind === 'preset'}<small>preset</small>{:else if describeCommands?.(entry.id)}<small>{describeCommands(entry.id)}</small>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </span>
  {/if}
  {#if switchingTo}<span class="role-bar__switching" role="status">Switching to {roleSetText(declaration, switchingTo)}…</span>{/if}
  {#if model.sidesWarning}<span class="role-bar__warning" role="note">{model.sidesWarning}</span>{/if}
</div>

<style>
  .role-bar {
    position: fixed;
    z-index: 16;
    top: 12px;
    left: calc(var(--rail-width, 0px) + 12px);
    max-width: min(720px, calc(100vw - var(--rail-width, 0px) - 84px));
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text);
  }

  .role-chip,
  .role-add__open {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: color-mix(in srgb, var(--panel) 94%, transparent);
    box-shadow: 0 4px 14px rgba(16, 24, 40, 0.16);
  }

  .role-chip[data-class='controller'] {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  }

  .role-chip button,
  .role-add__open,
  .role-add__menu button {
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .role-chip button:disabled,
  .role-add__open:disabled {
    cursor: default;
  }

  .role-chip__label {
    padding: 4px 4px 4px 10px;
    font-weight: 650;
  }

  .role-chip__side {
    width: 8px;
    height: 8px;
    margin-left: 8px;
    border-radius: 50%;
  }

  .role-chip__side + .role-chip__side {
    margin-left: 3px;
  }

  .role-chip__side + .role-chip__label {
    padding-left: 6px;
  }

  .role-bar__warning {
    flex-basis: 100%;
    padding: 4px 10px;
    border: 1px solid color-mix(in srgb, var(--warning) 60%, var(--border));
    border-radius: 6px;
    background: color-mix(in srgb, var(--warning) 14%, var(--panel));
    font-weight: 600;
  }

  .role-chip__label:last-child {
    padding-right: 10px;
  }

  .role-chip__drop {
    padding: 4px 9px 4px 4px;
    color: var(--muted);
  }

  .role-add {
    position: relative;
  }

  .role-add__open {
    padding: 3px 10px;
    font-weight: 700;
  }

  .role-add__menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 200px;
    margin: 0;
    padding: 4px;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    box-shadow: 0 6px 18px rgba(16, 24, 40, 0.2);
  }

  .role-add__menu button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-radius: 4px;
    text-align: left;
  }

  .role-add__menu button:hover,
  .role-add__menu button:focus-visible {
    background: var(--panel-strong);
  }

  .role-add__menu small,
  .role-bar__switching {
    color: var(--muted);
  }

  .role-add__menu kbd {
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 11px;
    color: var(--muted);
  }

  .role-bar.switching .role-chip {
    opacity: .6;
  }

  .role-chip button:focus-visible,
  .role-add__open:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
