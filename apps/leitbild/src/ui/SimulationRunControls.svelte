<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { ModuleCapabilityDescriptor, ModuleResourceDescriptor } from '@leitbild/contracts'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import Icon from './Icon.svelte'
  import { jsonRequest, request } from './api.ts'
  import { createResourceRemover, resourceDeleteBody, resourceDeleteItem, resourceNoun, type ResourceDeleteItem } from './resource-delete.ts'
  import { simulationTimeLabel } from './simulation-time.ts'

  interface AccelerationState {
    readonly kind: 'continuous' | 'timed'
    readonly status: 'running' | 'paused' | 'stopped' | 'completed' | 'failed'
    readonly startedSimulationTime: string
    readonly targetSimulationTime?: string
    readonly currentSimulationTime: string
    readonly onComplete: 'pause' | 'play-realtime'
    readonly startedAt: string
    readonly updatedAt: string
    readonly activeWallMs: number
    readonly simulatedMs: number
    readonly measuredSpeed: number
    readonly error?: string
  }
  interface ExecutionState {
    readonly playback: 'playing' | 'paused'
    readonly pace: 'realtime' | 'maximum'
    readonly currentSimulationTime: string
    readonly updatedAt: string
    readonly maximumPace: { readonly available: boolean; readonly reason?: string }
    readonly acceleration: AccelerationState | null
  }
  interface InvocationResponse<T> {
    readonly result: T
    readonly createdResources?: ReadonlyArray<ModuleResourceDescriptor['ref']>
  }
  interface AgentRestrictionsState {
    readonly operationIds: ReadonlyArray<string>
    readonly objects: ReadonlyArray<{ readonly objectId: string; readonly deny: ReadonlyArray<'inspect' | 'change'> }>
    readonly revision: number
  }
  interface ObjectSearchResult {
    readonly objects: ReadonlyArray<{ readonly id: string; readonly label: string; readonly kind: string; readonly packId: string }>
  }

  interface Props {
    readonly workspaceId: string
    readonly resource: ModuleResourceDescriptor
    readonly resources: ReadonlyArray<ModuleResourceDescriptor>
    readonly capabilities: ReadonlyArray<ModuleCapabilityDescriptor>
    readonly onSwitch: (runId: string) => void
    readonly onClose: () => void
    readonly refreshResources: () => Promise<void>
    readonly reportError: (message: string) => void
  }

  let { workspaceId, resource, resources, capabilities, onSwitch, onClose, refreshResources, reportError }: Props = $props()
  let execution = $state<ExecutionState | null>(null)
  let actionBusy = $state(false)
  let actionError = $state('')
  /** What the duration dialog offers first: a few minutes, not past a short exercise's end. */
  let minutes = $state(5)
  /** One-tap durations, so a touch screen needs no keyboard. */
  const quickMinutes = [1, 2, 5] as const
  let onComplete = $state<'pause' | 'play-realtime'>('pause')
  let copyName = $state('')
  let wallNow = $state(Date.now())
  let copyDialog = $state<HTMLDialogElement | null>(null)
  let timerDialog = $state<HTMLDialogElement | null>(null)
  let paceDialog = $state<HTMLDialogElement | null>(null)
  let restrictionsDialog = $state<HTMLDialogElement | null>(null)
  let restrictions = $state<AgentRestrictionsState | null>(null)
  let restrictionObjects = $state<ReadonlyArray<ObjectSearchResult['objects'][number]>>([])
  let restrictedOperationIds = $state('')
  let restrictionBusy = $state(false)
  let restrictionError = $state('')
  let familyOpen = $state(false)
  let editingRunId = $state<string | null>(null)
  let editingName = $state('')
  let renameInput = $state<HTMLInputElement | null>(null)
  let notice = $state('')
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  let refreshToken = 0
  let deleteTargets = $state<ReadonlyArray<ResourceDeleteItem>>([])
  let confirmingDelete = $state(false)
  let deleteButton = $state<HTMLButtonElement | null>(null)
  /** A 404 asked the Workspace's list once whether this Run still exists; a second one is reported. */
  let goneChecked = false

  const capabilityAvailableFor = (candidate: ModuleResourceDescriptor, id: string): boolean =>
    candidate.capabilityIds.includes(id) && capabilities.some(capability => capability.id === id)
  const capabilityAvailable = (id: string): boolean => capabilityAvailableFor(resource, id)
  const invoke = async <T>(target: ModuleResourceDescriptor['ref'], capabilityId: string, input: unknown): Promise<InvocationResponse<T>> =>
    await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/${encodeURIComponent(capabilityId)}/invoke`,
      jsonRequest('POST', { resource: target, input, actor: { kind: 'human' } }))
  const familyId = (candidate: ModuleResourceDescriptor): string =>
    candidate.links.find(link => link.rel === 'member-of' && link.ref.type === 'world.run-family')?.ref.id ?? candidate.ref.id
  const family = $derived(resources
    .filter(candidate => candidate.ref.type === 'world.simulation-run' && familyId(candidate) === familyId(resource))
    .sort((left, right) => {
      const rootId = familyId(resource)
      if (left.ref.id === rootId) return -1
      if (right.ref.id === rootId) return 1
      return left.title.localeCompare(right.title)
    }))

  const nextCopyName = (): string => {
    let number = Math.max(1, family.length)
    let candidate = `${resource.title} - copy ${number}`
    const names = new Set(family.map(member => member.title))
    while (names.has(candidate)) { number += 1; candidate = `${resource.title} - copy ${number}` }
    return candidate
  }
  const refresh = async (): Promise<void> => {
    const token = ++refreshToken
    try {
      const nextExecution = await invoke<ExecutionState>(resource.ref, 'world.simulation-run.execution.read', {})
      if (token !== refreshToken) return
      execution = nextExecution.result
      goneChecked = false
    } catch (cause) {
      // While a delete runs, its dialog reports the outcome.
      if (token !== refreshToken || confirmingDelete) return
      // A Run deleted elsewhere answers 404: reading the Workspace's Resources again closes it on this page.
      if ((cause as { status?: unknown }).status === 404 && !goneChecked) {
        goneChecked = true
        void refreshResources().catch(refreshCause => reportError(refreshCause instanceof Error ? refreshCause.message : String(refreshCause)))
        return
      }
      reportError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const runAction = async (action: () => Promise<void>): Promise<void> => {
    if (actionBusy) return
    actionBusy = true
    actionError = ''
    try { await action() }
    catch (cause) {
      actionError = cause instanceof Error ? cause.message : String(cause)
      reportError(actionError)
    } finally {
      actionBusy = false
    }
  }
  const showNotice = (message: string): void => {
    if (noticeTimer !== null) clearTimeout(noticeTimer)
    notice = message
    noticeTimer = setTimeout(() => { notice = ''; noticeTimer = null }, 2_000)
  }
  const openCopyDialog = (): void => {
    copyName = nextCopyName()
    copyDialog?.showModal()
  }
  const createCopy = (): void => {
    void runAction(async () => {
      const response = await invoke<{ readonly id: string; readonly title: string }>(resource.ref, 'world.simulation-run.copy', copyName.trim() === '' ? {} : { name: copyName.trim() })
      await refreshResources()
      copyDialog?.close()
      onSwitch(response.result.id)
      showNotice(`You are now in ${response.result.title}`)
    })
  }
  const setExecution = (input: { readonly playback?: ExecutionState['playback']; readonly pace?: ExecutionState['pace'] }): void => {
    void runAction(async () => {
      refreshToken += 1
      execution = (await invoke<ExecutionState>(resource.ref, 'world.simulation-run.execution.set', input)).result
    })
  }
  const togglePlayback = (): void => setExecution({ playback: execution?.playback === 'playing' ? 'paused' : 'playing' })
  /**
   * Maximum pace runs the Run as fast as it can until it is switched back,
   * with no end: one stray tap could carry an exercise far past its end. So
   * arming it asks first, and offers a fixed duration instead; switching
   * back to realtime never asks.
   */
  const togglePace = (): void => {
    if (execution?.pace === 'maximum') return setExecution({ pace: 'realtime' })
    paceDialog?.showModal()
  }
  const armMaximumPace = (): void => {
    paceDialog?.close()
    setExecution({ pace: 'maximum' })
  }
  const chooseDuration = (): void => {
    paceDialog?.close()
    timerDialog?.showModal()
  }
  const advanceBy = (duration: number): void => {
    if (!Number.isFinite(duration) || duration <= 0) return
    void runAction(async () => {
      refreshToken += 1
      execution = (await invoke<ExecutionState>(resource.ref, 'world.simulation-run.execution.advance', { minutes: duration, onComplete })).result
      timerDialog?.close()
    })
  }
  const advanceByDuration = (): void => advanceBy(minutes)
  const openRestrictions = (): void => {
    if (restrictionBusy) return
    restrictionBusy = true
    restrictionError = ''
    void Promise.all([
      invoke<AgentRestrictionsState>(resource.ref, 'world.simulation-run.agent-restrictions.read', {}),
      invoke<ObjectSearchResult>(resource.ref, 'world.simulation-run.objects.search', { offset: 0, limit: 200 }),
    ]).then(([policy, objects]) => {
      restrictions = policy.result
      restrictedOperationIds = policy.result.operationIds.join('\n')
      restrictionObjects = objects.result.objects
      restrictionsDialog?.showModal()
    }).catch(cause => {
      restrictionError = cause instanceof Error ? cause.message : String(cause)
      reportError(restrictionError)
    }).finally(() => { restrictionBusy = false })
  }
  const objectDenies = (objectId: string): ReadonlyArray<'inspect' | 'change'> =>
    restrictions?.objects.find(entry => entry.objectId === objectId)?.deny ?? []
  const setObjectRestriction = (objectId: string, effect: 'inspect' | 'change', denied: boolean): void => {
    if (!restrictions) return
    const current = objectDenies(objectId)
    const deny = denied ? [...new Set([...current, effect])] : current.filter(value => value !== effect)
    restrictions = {
      ...restrictions,
      objects: deny.length === 0
        ? restrictions.objects.filter(entry => entry.objectId !== objectId)
        : [...restrictions.objects.filter(entry => entry.objectId !== objectId), { objectId, deny }],
    }
  }
  const saveRestrictions = (): void => {
    if (!restrictions || restrictionBusy) return
    restrictionBusy = true
    restrictionError = ''
    const operationIds = [...new Set(restrictedOperationIds.split('\n').map(value => value.trim()).filter(Boolean))]
    void invoke<AgentRestrictionsState>(resource.ref, 'world.simulation-run.agent-restrictions.set', {
      restrictions: { operationIds, objects: restrictions.objects },
      expectedRevision: restrictions.revision,
    }).then(response => {
      restrictions = response.result
      restrictionsDialog?.close()
    }).catch(cause => {
      restrictionError = cause instanceof Error ? cause.message : String(cause)
    }).finally(() => { restrictionBusy = false })
  }
  const switchRun = (id: string): void => {
    familyOpen = false
    editingRunId = null
    if (id !== resource.ref.id) onSwitch(id)
  }
  const startRename = async (member: ModuleResourceDescriptor): Promise<void> => {
    editingRunId = member.ref.id
    editingName = member.title
    await tick()
    renameInput?.focus()
    renameInput?.select()
  }
  const cancelRename = (): void => {
    editingRunId = null
    editingName = ''
  }
  const toggleFamily = (): void => {
    familyOpen = !familyOpen
    if (!familyOpen) cancelRename()
  }
  const saveRename = (member: ModuleResourceDescriptor): void => {
    const name = editingName.trim()
    void runAction(async () => {
      await invoke(member.ref, 'world.simulation-run.rename', { name: name === '' ? null : name, expectedTitle: member.title })
      await refreshResources()
      cancelRename()
    })
  }
  const handleRenameKey = (event: KeyboardEvent, member: ModuleResourceDescriptor): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      saveRename(member)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancelRename()
    }
  }
  // Each Run is deleted through the delete Capability its own descriptor names.
  const removeRun = $derived(createResourceRemover(workspaceId))
  const deletableRun = (member: ModuleResourceDescriptor): ResourceDeleteItem | null => resourceDeleteItem(member, capabilities)
  const askDelete = (member: ModuleResourceDescriptor): void => {
    const item = deletableRun(member)
    if (!item) return
    familyOpen = false
    cancelRename()
    deleteTargets = [item]
    confirmingDelete = true
  }
  /** Deleting the open Run moves to a remaining copy, or back to the Workspace page. */
  const runsDeleted = (removed: ReadonlyArray<ResourceDeleteItem>): void => {
    if (removed.length === 0) return
    const gone = new Set(removed.map(item => item.resource.ref.id))
    if (!gone.has(resource.ref.id)) {
      void refreshResources().catch(cause => reportError(cause instanceof Error ? cause.message : String(cause)))
      return
    }
    const next = family.find(candidate => !gone.has(candidate.ref.id))
    if (next === undefined) return onClose()
    onSwitch(next.ref.id)
    showNotice(`You are now in ${next.title}`)
    void refreshResources().catch(cause => reportError(cause instanceof Error ? cause.message : String(cause)))
  }
  const displayTime = $derived(simulationTimeLabel(execution, wallNow))

  $effect(() => {
    resource.ref.id
    familyOpen = false
    editingRunId = null
    void refresh()
  })
  onMount(() => {
    const clockTicker = setInterval(() => { wallNow = Date.now() }, 250)
    const poll = setInterval(() => { void refresh() }, 1_000)
    const closeFamily = (event: PointerEvent): void => {
      if (!(event.target instanceof Element) || !event.target.closest('.family-control')) {
        familyOpen = false
        cancelRename()
      }
    }
    window.addEventListener('pointerdown', closeFamily)
    return () => {
      clearInterval(clockTicker)
      clearInterval(poll)
      if (noticeTimer !== null) clearTimeout(noticeTimer)
      window.removeEventListener('pointerdown', closeFamily)
    }
  })
</script>

<div class="run-controls" aria-label="Simulation controls">
  {#if family.length > 1}<div class="family-control">
    <button class="family-trigger" type="button" aria-haspopup="true" aria-expanded={familyOpen} onclick={toggleFamily} title={resource.title}>
      <span class="family-label">{resource.title}</span><span aria-hidden="true">⌄</span>
    </button>
    {#if familyOpen}
      <div class="family-menu" role="group" aria-label="Run copies">
        {#each family as member (member.ref.id)}
          <div class:current={member.ref.id === resource.ref.id}>
            {#if editingRunId === member.ref.id}
              <input class="family-name-input" maxlength="120" aria-label={`Name for ${member.title}`} bind:this={renameInput} bind:value={editingName} onkeydown={(event) => handleRenameKey(event, member)} />
            {:else}
              <button class="family-member" type="button" aria-current={member.ref.id === resource.ref.id ? 'true' : undefined} title={member.title} onclick={() => switchRun(member.ref.id)}>{member.title}</button>
            {/if}
            <button class="family-rename" type="button" disabled={actionBusy || !capabilityAvailableFor(member, 'world.simulation-run.rename')} aria-label={`Rename ${member.title}`} title={`Rename ${member.title}`} onclick={() => void startRename(member)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></button>
            <button class="family-delete" type="button" disabled={deletableRun(member) === null} aria-label={`Delete ${member.title}`} title={`Delete ${member.title}`} onclick={() => askDelete(member)}><Icon name="trash" size={15} /></button>
          </div>
        {/each}
      </div>
    {/if}
  </div>{:else}<span class="run-title" title={resource.title}>{resource.title}</span>{/if}
  <button type="button" disabled={actionBusy || !capabilityAvailable('world.simulation-run.copy')} onclick={openCopyDialog} title="Copy this Run" aria-label="Copy this Run"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
  <button class:active={execution?.playback === 'playing'} type="button" disabled={!execution || actionBusy || !capabilityAvailable('world.simulation-run.execution.set')} onclick={togglePlayback} title={execution?.playback === 'playing' ? 'Playing — click to pause' : 'Paused — click to play'} aria-label={execution?.playback === 'playing' ? 'Pause simulation' : 'Play simulation'}>{#if execution?.playback === 'playing'}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>{:else}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 4 13 8-13 8z"/></svg>{/if}</button>
  <button class:active={execution?.pace === 'maximum'} type="button" aria-pressed={execution?.pace === 'maximum'} disabled={!execution || actionBusy || !capabilityAvailable('world.simulation-run.execution.set') || (!execution.maximumPace.available && execution.pace !== 'maximum')} onclick={togglePace} title={execution?.maximumPace.available ? execution?.pace === 'maximum' ? 'Maximum pace armed — click for realtime' : 'Realtime pace — click for maximum' : execution?.maximumPace.reason ?? 'Maximum pace unavailable'} aria-label={execution?.pace === 'maximum' ? 'Maximum pace armed; switch to realtime' : 'Realtime pace; switch to maximum'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 5 9 7-9 7zM12 5l9 7-9 7z"/></svg></button>
  <span class:fast={execution?.pace === 'maximum'} class="clock" title={execution?.playback === 'playing' && execution?.pace === 'maximum' ? `Playing at ${execution.acceleration?.measuredSpeed.toFixed(1) ?? '0.0'}× measured` : execution?.pace === 'maximum' ? 'Paused with maximum pace armed' : execution?.playback === 'paused' ? 'Simulation paused' : 'Simulation playing in realtime'}>{displayTime}{#if execution?.pace === 'maximum'}<small>{execution.playback === 'playing' ? `${execution.acceleration?.measuredSpeed.toFixed(1) ?? '0.0'}×` : 'MAX armed'}</small>{/if}</span>
  <button class:active={execution?.acceleration?.kind === 'timed' && ['running', 'paused'].includes(execution.acceleration.status)} type="button" disabled={actionBusy || !capabilityAvailable('world.simulation-run.execution.advance') || execution?.maximumPace.available === false} onclick={() => timerDialog?.showModal()} title="Run at maximum pace for a fixed duration" aria-label="Run at maximum pace for a fixed duration"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2h6M12 14l3-3M12 6a8 8 0 1 0 8 8 8 8 0 0 0-8-8z"/></svg></button>
  <button type="button" disabled={restrictionBusy || !capabilityAvailable('world.simulation-run.agent-restrictions.read') || !capabilityAvailable('world.simulation-run.agent-restrictions.set')} onclick={openRestrictions} title="AI restrictions for this Run" aria-label="AI restrictions for this Run"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg></button>
  <button bind:this={deleteButton} class="run-delete" type="button" disabled={deletableRun(resource) === null} onclick={() => askDelete(resource)} title="Delete this simulation" aria-label={`Delete this simulation: ${resource.title}`}><Icon name="trash" size={16} /></button>
</div>
{#if actionError}<div class="control-error" role="alert">{actionError}</div>{/if}
<ConfirmDialog bind:open={confirmingDelete} items={deleteTargets} noun={resourceNoun(deleteTargets)} body={resourceDeleteBody(deleteTargets)}
  remove={removeRun} onfinished={runsDeleted} returnFocus={() => deleteButton?.focus()} />
{#if notice}<div class="switch-notice" role="status">{notice}</div>{/if}

<dialog class="control-dialog" bind:this={copyDialog}>
  <header><div><small>Independent Run</small><h2>Copy {resource.title}</h2></div><button class="close" type="button" onclick={() => copyDialog?.close()} aria-label="Close">×</button></header>
  <label>Copy name <span>(optional)</span><input maxlength="120" bind:value={copyName} /></label>
  <div class="actions"><button class="primary" type="button" disabled={actionBusy} onclick={createCopy}>{actionBusy ? 'Copying…' : 'Create copy'}</button></div>
  <p class="hint">The copy starts paused at the current simulation boundary. It can then run or fast-forward independently.</p>
</dialog>

<dialog class="control-dialog" bind:this={timerDialog}>
  <header><div><small>Simulation time</small><h2>Fast-forward by duration</h2></div><button class="close" type="button" onclick={() => timerDialog?.close()} aria-label="Close">×</button></header>
  {#if execution?.acceleration?.kind === 'timed' && ['running', 'paused'].includes(execution.acceleration.status)}
    <section class="progress"><strong>{execution.acceleration.status === 'running' ? `Maximum pace · ${execution.acceleration.measuredSpeed.toFixed(1)}×` : 'Paused · target retained'}</strong><span>{new Date(execution.acceleration.currentSimulationTime).toLocaleString()} → {execution.acceleration.targetSimulationTime ? new Date(execution.acceleration.targetSimulationTime).toLocaleString() : ''}</span></section>
    <div class="actions"><button class="primary" type="button" disabled={actionBusy} onclick={() => setExecution({ playback: execution?.playback === 'playing' ? 'paused' : 'playing' })}>{execution.acceleration.status === 'running' ? 'Pause' : 'Resume'}</button></div>
  {:else}
    <fieldset><legend>When the target is reached</legend><label class="choice"><input type="radio" value="pause" bind:group={onComplete} /> Pause</label><label class="choice"><input type="radio" value="play-realtime" bind:group={onComplete} /> Play in realtime</label></fieldset>
    <div class="quick" role="group" aria-label="Fast-forward by">
      {#each quickMinutes as quick (quick)}<button type="button" disabled={actionBusy} onclick={() => advanceBy(quick)}>+{quick} min</button>{/each}
    </div>
    <label>Or simulated minutes<input type="number" min="0.01" max="10080" step="1" bind:value={minutes} /></label>
    <div class="actions"><button class="primary" type="button" disabled={actionBusy} onclick={advanceByDuration}>{actionBusy ? 'Starting…' : 'Start fast-forward'}</button></div>
  {/if}
  <p class="hint">Live external feeds cannot invent future observations and will reject fast-forward.</p>
</dialog>

<dialog class="control-dialog" bind:this={paceDialog}>
  <header><div><small>Simulation time</small><h2>Run at maximum pace?</h2></div><button class="close" type="button" onclick={() => paceDialog?.close()} aria-label="Close">×</button></header>
  <p class="hint">Maximum pace runs the simulation as fast as it can, without stopping, until you switch it back to realtime. It does not stop at the end of an exercise, and the Run cannot be wound back. To skip a few minutes, fast-forward by a duration instead.</p>
  <div class="actions"><button type="button" disabled={actionBusy} onclick={armMaximumPace}>Run at maximum pace</button><button class="primary" type="button" onclick={chooseDuration}>Fast-forward by a duration</button></div>
</dialog>

<dialog class="control-dialog restrictions-dialog" bind:this={restrictionsDialog}>
  <header><div><small>Current Run</small><h2>AI restrictions</h2></div><button class="close" type="button" onclick={() => restrictionsDialog?.close()} aria-label="Close">×</button></header>
  <p class="hint">Agents can use every operation in their Room Scope except what is listed here. Object limits block targeted detailed reads and changes; catalogs and aggregate results may still reveal that an object exists. This replaces the current Run policy and does not edit the source scenario.</p>
  <label>Blocked operation IDs <span>(one per line)</span><textarea rows="4" bind:value={restrictedOperationIds} placeholder="world.simulation-run.scenario-source"></textarea></label>
  <fieldset class="object-restrictions"><legend>Object restrictions</legend>
    {#if restrictionObjects.length === 0}<p>No operational objects found.</p>{/if}
    {#each restrictionObjects as object (object.id)}
      <div><span title={object.id}><strong>{object.label}</strong><small>{object.packId} · {object.kind}</small></span>
        <label><input type="checkbox" checked={objectDenies(object.id).includes('inspect')} onchange={event => setObjectRestriction(object.id, 'inspect', event.currentTarget.checked)} /> Details</label>
        <label><input type="checkbox" checked={objectDenies(object.id).includes('change')} onchange={event => setObjectRestriction(object.id, 'change', event.currentTarget.checked)} /> Change</label>
      </div>
    {/each}
  </fieldset>
  {#if restrictionError}<p class="restriction-error" role="alert">{restrictionError}</p>{/if}
  <div class="actions"><button type="button" onclick={() => restrictionsDialog?.close()}>Cancel</button><button class="primary" type="button" disabled={restrictionBusy} onclick={saveRestrictions}>{restrictionBusy ? 'Saving…' : 'Save restrictions'}</button></div>
</dialog>

<style>
  .run-controls { min-width: 0; margin-left: auto; display: flex; align-items: center; gap: .35rem; color: #dfe8dc; }
  button { min-width: 30px; min-height: 28px; padding: 0 .45rem; border: 1px solid #536157; border-radius: 6px; color: inherit; background: #243128; font: inherit; cursor: pointer; }
  button:hover { border-color: #87958a; background: #314037; } button:disabled { opacity: .45; cursor: wait; } button.active { border-color: #65a9ea; color: #b9dcff; background: #1c4261; }
  button svg { width: 16px; height: 16px; display: block; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .clock { min-width: 112px; padding: 0 .25rem; color: #cbd6cc; font: 600 .74rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; white-space: nowrap; } .clock small { margin-left: .28rem; color: #8ec6ff; font-size: .64rem; } .clock.fast { color: #d8ecff; }
  .family-control { position: relative; min-width: 0; display: flex; } .family-trigger { max-width: min(250px, 24vw); display: flex; align-items: center; gap: .35rem; font-size: .7rem; } .family-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-title { max-width: min(250px, 24vw); overflow: hidden; color: #dfe8dc; font-size: .7rem; text-overflow: ellipsis; white-space: nowrap; }
  .family-menu { position: absolute; z-index: 80; top: calc(100% + .4rem); right: 0; width: min(360px, calc(100vw - 2rem)); padding: .35rem; border: 1px solid #647168; border-radius: 9px; background: #18231c; box-shadow: 0 14px 38px #0008; }
  .family-menu > div { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; border-radius: 6px; } .family-menu > div.current { background: #2a3d30; }
  .family-member { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; background: transparent; text-align: left; }
  .family-delete { min-width: 30px; padding: 0 .4rem; border: 0; color: #f0b4ad; background: transparent; } .family-delete:hover:not(:disabled) { color: #ffd9d4; background: #5a2622; }
  .run-delete { color: #f0b4ad; } .run-delete:hover:not(:disabled) { border-color: #b8645c; color: #ffe1dc; background: #5a2622; }
  .family-delete :global(svg), .run-delete :global(svg) { display: block; }
  .family-rename { min-width: 28px; padding: 0 .35rem; border: 0; color: #b9c6bc; background: transparent; } .family-rename svg { width: 14px; height: 14px; }
  .family-name-input { min-width: 0; margin: .2rem .35rem; padding: .38rem .45rem; border: 1px solid #7f9d87; border-radius: 5px; color: #f4faf5; background: #111a14; font: inherit; outline: none; } .family-name-input:focus { border-color: #a6c5ad; box-shadow: 0 0 0 2px #5d8f6a55; }
  .control-error { position: fixed; z-index: 120; top: 3rem; right: 1rem; max-width: min(440px, calc(100vw - 2rem)); padding: .65rem .8rem; border-radius: 8px; color: #fff; background: #8e302b; box-shadow: 0 8px 24px #0005; font-size: .78rem; }
  .switch-notice { position: fixed; z-index: 140; top: 50%; left: 50%; translate: -50% -50%; max-width: min(520px, calc(100vw - 2rem)); padding: 1.1rem 1.4rem; border: 1px solid #8da596; border-radius: 12px; color: #f5fff6; background: #15241ddb; box-shadow: 0 20px 60px #0007; backdrop-filter: blur(8px); font-size: 1rem; font-weight: 700; text-align: center; pointer-events: none; }
  .control-dialog { width: min(500px, calc(100vw - 2rem)); padding: 0; border: 1px solid #aeb9ad; border-radius: 14px; color: #172019; background: #f6f8f4; box-shadow: 0 24px 70px #0006; } .control-dialog::backdrop { background: #0a100b99; backdrop-filter: blur(2px); }
  .control-dialog > header { padding: 1rem 1.1rem; display: flex; align-items: start; justify-content: space-between; gap: 1rem; border-bottom: 1px solid #d5ddd3; } .control-dialog h2 { margin: .1rem 0 0; font-size: 1.05rem; }
  .control-dialog header small, .hint, .progress span, .control-dialog label span { color: #687269; } .control-dialog > :not(header) { margin-left: 1.1rem; margin-right: 1.1rem; } .control-dialog > :last-child { margin-bottom: 1.1rem; }
  .control-dialog .close { min-width: 32px; min-height: 32px; padding: 0; border-color: #b8c1b6; color: #334139; background: #fff; font-size: 1.2rem; }
  .control-dialog > label { margin-top: 1rem; display: grid; gap: .35rem; color: #4c584e; font-size: .82rem; font-weight: 650; } .control-dialog > label input { width: 100%; min-height: 38px; padding: .55rem .65rem; border: 1px solid #bdc7bb; border-radius: 7px; background: #fff; font: inherit; }
  .control-dialog textarea { width: 100%; padding: .55rem .65rem; resize: vertical; border: 1px solid #bdc7bb; border-radius: 7px; background: #fff; font: .72rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  fieldset { margin-top: 1rem !important; padding: .7rem .8rem; display: flex; gap: 1rem; border: 1px solid #cbd5c9; border-radius: 8px; } fieldset legend { padding: 0 .25rem; color: #4c584e; font-size: .78rem; font-weight: 650; } label.choice { display: flex; align-items: center; gap: .35rem; font-size: .8rem; }
  .progress { margin-top: 1rem; padding: .8rem; display: grid; gap: .25rem; border: 1px solid #65a9ea; border-radius: 8px; background: #fff; box-shadow: inset 3px 0 #3988d1; font-size: .8rem; }
  .actions { margin-top: .85rem; display: flex; justify-content: flex-end; gap: .5rem; } .control-dialog .actions button { min-height: 38px; padding: .5rem .8rem; border-color: #aeb9ad; color: #213026; background: #fff; } .control-dialog .actions button.primary { border-color: #263c2b; color: #f5fff2; background: #263c2b; }
  .quick { margin-top: 1rem; display: flex; gap: .5rem; } .control-dialog .quick button { flex: 1; min-height: 44px; border-color: #263c2b; color: #213026; background: #fff; font-weight: 700; }
  .hint { font-size: .72rem; line-height: 1.4; } @media (max-width: 760px) { .family-control, .run-title { display: none; } .clock { min-width: 96px; } }
  /* In a crowded Run bar only the title gives way; the buttons and the clock keep their size. */
  .run-controls > :not(.run-title, .family-control) { flex-shrink: 0; }
  /* At 760 px and below, without a title to give way, the controls the Run bar cannot hold
     scroll sideways in their own strip instead of overlapping the buttons beside them. Its
     edges fade, so a control cut off there reads as "more this way"; the padding the fades
     lie on keeps the first and last controls clear of them, and focus rings unclipped. */
  @media (max-width: 760px) {
    .run-controls { overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; padding: 4px 10px; scroll-padding-inline: 10px;
      mask-image: linear-gradient(to right, transparent, #000 min(10px, 20%), #000 max(calc(100% - 10px), 80%), transparent); }
    .run-controls::-webkit-scrollbar { display: none; }
    .run-controls > * { flex: none; }
  }
  .restrictions-dialog { width: min(680px, calc(100vw - 2rem)); } .object-restrictions { max-height: min(42vh, 420px); overflow: auto; display: grid; gap: .25rem; }
  .object-restrictions > div { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: .8rem; padding: .4rem 0; border-bottom: 1px solid #e1e7df; }
  .object-restrictions > div > span { min-width: 0; display: grid; } .object-restrictions strong, .object-restrictions small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .object-restrictions small { color: #6b746c; }
  .object-restrictions label { display: flex; align-items: center; gap: .3rem; font-size: .75rem; } .restriction-error { color: #9b2f2a; font-size: .78rem; }
</style>
