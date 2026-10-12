<script lang="ts">
  import type { RunRoles } from '../../core/model/index.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import {
    dropRole,
    idleRoleKeys,
    roleBarModel,
    roleKeyStep,
    roleSetText,
    type RoleKeyState,
    type RoleSetChange,
  } from './role-controller.ts'

  /**
   * The roles this screen holds, in the World header. A tap on a role, on
   * "+N" (the held roles past the first few) or on Roles opens the role
   * dialog, where roles and presets are added or dropped and what the screen
   * sees is chosen; × drops one role at once. No single tap switches the
   * screen to one role, so a stray tap never drops the others. P then a digit
   * stays a hidden desktop accelerator. Every change applies in place.
   */
  interface Props {
    readonly declaration: RunRoles
    /** The set this screen plays now; it stays until the Run answers a switch. */
    readonly held: ReadonlyArray<string>
    /** The set a switch asked for, while its fresh snapshot has not arrived. */
    readonly switchingTo: ReadonlyArray<string> | null
    readonly request: (change: RoleSetChange) => void
    readonly openDialog: () => void
  }

  const { declaration, held, switchingTo, request, openDialog }: Props = $props()

  const model = $derived(roleBarModel(declaration, held))
  const switching = $derived(switchingTo !== null)
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
      if (step.change) request(step.change)
    }
    const onBlur = (): void => { keyState = idleRoleKeys }
    // Capture phase: the role keys run before any bubble-phase listener, such as the panel key router, which then sees them defaultPrevented.
    window.addEventListener('keydown', onKeydown, { capture: true })
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeydown, { capture: true })
      window.removeEventListener('blur', onBlur)
    }
  })
</script>

<div class="role-bar" class:switching role="toolbar" aria-label="Roles held by this screen">
  {#each model.chips as chip (chip.id)}
    <span class="role-chip" data-class={chip.roleClass}>
      {#each chip.sides as side (side.id)}<span class="role-chip__side" style:background={side.colour} title={`Sees ${side.label}`}></span>{/each}
      <button type="button" class="role-chip__label" aria-haspopup="dialog" title={`${chip.label}: open the role dialog`} aria-label={`${chip.label}: open the role dialog`} disabled={switching} onclick={openDialog}>{chip.label}</button>
      {#if chip.droppable}
        <button type="button" class="role-chip__drop" aria-label={`Drop ${chip.label}`} title={`Drop ${chip.label}`} disabled={switching} onclick={() => request(dropRole(declaration, held, chip.id))}>×</button>
      {/if}
    </span>
  {/each}
  {#if model.more > 0}
    <button type="button" class="role-bar__more" aria-haspopup="dialog" aria-label={`${model.more} more held: ${model.moreLabels.join(', ')}`} title={model.moreLabels.join(', ')} disabled={switching} onclick={openDialog}>+{model.more}</button>
  {/if}
  <button type="button" class="role-bar__dialog" aria-haspopup="dialog" disabled={switching} onclick={openDialog}>Roles</button>
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
  .role-bar__more,
  .role-bar__dialog {
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
  .role-bar__more,
  .role-bar__dialog {
    min-height: 44px;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .role-bar__more,
  .role-bar__dialog {
    padding: 0 14px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--panel) 94%, transparent);
    font-weight: 700;
  }

  .role-bar__more {
    min-width: 44px;
    justify-content: center;
  }

  .role-chip button:disabled,
  .role-bar__more:disabled,
  .role-bar__dialog:disabled {
    cursor: default;
  }

  .role-chip__label {
    max-width: 132px;
    overflow: hidden;
    padding: 0 6px 0 12px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    padding-right: 14px;
  }

  .role-chip__drop {
    min-width: 44px;
    padding: 0 12px 0 6px;
    color: var(--muted);
  }

  .role-bar__switching {
    color: var(--muted);
  }

  .role-bar.switching .role-chip {
    opacity: .6;
  }

  .role-chip button:focus-visible,
  .role-bar__more:focus-visible,
  .role-bar__dialog:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
