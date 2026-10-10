<script lang="ts">
  import type {
    ModuleCapabilityDescriptor,
    ModuleResourceDescriptor,
    WorkspaceResourceReference,
    WorkspaceRoomScope,
  } from '@leitbild/contracts'
  import { jsonRequest, request } from './api.ts'
  import { roomScopeKind } from './run-room-scope.ts'

  interface InvocationResponse {
    readonly result: { readonly resource: WorkspaceResourceReference }
  }

  interface Props {
    readonly workspaceId: string
    readonly family: ModuleResourceDescriptor
    readonly currentRun: ModuleResourceDescriptor
    /** The family's Rooms that serve this Run. */
    readonly rooms: ReadonlyArray<ModuleResourceDescriptor>
    readonly activeRoomId: string | null
    /** The open Room, which may be scoped to the Workspace or to this Run rather than to the family. */
    readonly activeRoom: ModuleResourceDescriptor | undefined
    readonly capabilities: ReadonlyArray<ModuleCapabilityDescriptor>
    readonly onRoomSelected: (roomId: string) => void
    readonly onChanged: (roomId: string) => Promise<void>
  }

  const scopeLabels: Readonly<Record<WorkspaceRoomScope['kind'], { readonly label: string; readonly title: string }>> = {
    workspace: { label: 'Whole Workspace', title: 'Agents in this Room may use every Resource in the Workspace' },
    resource: { label: 'This Run', title: 'Agents in this Room may use only this Run' },
    // A collection Room outside this list does not contain this Run (any that did would be listed).
    collection: { label: 'Other Runs', title: 'This Room\'s scope does not include this Run' },
  }

  let { workspaceId, family, currentRun, rooms, activeRoomId, activeRoom, capabilities, onRoomSelected, onChanged }: Props = $props()
  let dialog = $state<HTMLDialogElement | null>(null)
  let mode = $state<'edit' | 'create'>('edit')
  let name = $state('')
  let includeFuture = $state(true)
  let selectedIds = $state<Set<string>>(new Set())
  let busy = $state(false)
  let error = $state('')

  const members = $derived(family.links.filter(link => link.rel === 'contains').map(link => link.ref))
  const familyRoom = $derived(rooms.find(room => room.ref.id === activeRoomId))
  // A Room scoped to the whole Workspace or to this Run also serves it. It stays
  // open and listed beside the family's Rooms; only family scopes are edited here.
  const otherRoom = $derived(familyRoom === undefined && activeRoom?.ref.id === activeRoomId ? activeRoom : undefined)
  const choices = $derived(otherRoom === undefined ? rooms : [otherRoom, ...rooms])
  const otherScope = $derived(otherRoom === undefined ? undefined : scopeLabels[roomScopeKind(otherRoom)])
  const revision = $derived(Number(familyRoom?.summary.find(item => item.key === 'scope-revision')?.value ?? 0))
  const roomSelectedCount = $derived.by(() => {
    if (!familyRoom) return 0
    const explicit = familyRoom.links.filter(link => link.rel === 'scope-member')
    if (explicit.length > 0) return explicit.length
    const excluded = new Set(familyRoom.links.filter(link => link.rel === 'scope-excluded').map(link => link.ref.id))
    return members.filter(member => !excluded.has(member.id)).length
  })

  const initialSelection = (room: ModuleResourceDescriptor | undefined): void => {
    const explicit = new Set(room?.links.filter(link => link.rel === 'scope-member').map(link => link.ref.id) ?? [])
    const excluded = new Set(room?.links.filter(link => link.rel === 'scope-excluded').map(link => link.ref.id) ?? [])
    includeFuture = explicit.size === 0
    selectedIds = new Set(includeFuture
      ? members.filter(member => !excluded.has(member.id)).map(member => member.id)
      : explicit)
  }

  const openEdit = (): void => {
    if (!familyRoom) return
    mode = 'edit'
    name = familyRoom.title
    error = ''
    initialSelection(familyRoom)
    dialog?.showModal()
  }

  const openCreate = (): void => {
    mode = 'create'
    name = currentRun.title.slice(0, 128)
    error = ''
    includeFuture = true
    selectedIds = new Set(members.map(member => member.id))
    dialog?.showModal()
  }

  const toggleMember = (id: string): void => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selectedIds = next
  }

  const scope = (): WorkspaceRoomScope => ({
    kind: 'collection',
    collection: family.ref,
    members: includeFuture
      ? { mode: 'all', except: members.filter(member => !selectedIds.has(member.id)) }
      : { mode: 'selected', only: members.filter(member => selectedIds.has(member.id)) },
  })

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    if (busy || selectedIds.size === 0) return
    busy = true
    error = ''
    try {
      const capabilityId = mode === 'create' ? 'agents.assistance.create' : 'agents.room.scope.set'
      if (!capabilities.some(capability => capability.id === capabilityId)) throw new Error('Room scope controls are unavailable')
      const response = await request<InvocationResponse>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/${encodeURIComponent(capabilityId)}/invoke`,
        jsonRequest('POST', mode === 'create'
          ? { input: { scope: scope(), title: name.trim() }, actor: { kind: 'human' } }
          : { resource: familyRoom!.ref, input: { scope: scope(), expectedRevision: revision }, actor: { kind: 'human' } }),
      )
      const roomId = mode === 'create' ? response.result.resource.id : familyRoom!.ref.id
      await onChanged(roomId)
      dialog?.close()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally { busy = false }
  }
</script>

<div class="run-room-controls">
  {#if choices.length > 1}
    <select aria-label="Run Assistant room" value={activeRoomId ?? ''} onchange={event => onRoomSelected(event.currentTarget.value)}>
      {#each choices as room (room.ref.id)}<option value={room.ref.id}>{room.title}</option>{/each}
    </select>
  {/if}
  {#if familyRoom}
    <button type="button" title="Choose Runs available in this Room" onclick={openEdit}>{roomSelectedCount}/{members.length} Runs</button>
  {:else if otherRoom && otherScope}
    <span class="room-scope" title={`${otherRoom.title}: ${otherScope.title}`}>{otherScope.label}</span>
  {/if}
  <button type="button" class="icon-control" title="Create another Run Assistant Room" aria-label="Create another Run Assistant Room" onclick={openCreate}>+</button>
</div>

<dialog class="run-room-dialog" bind:this={dialog}>
  <form onsubmit={submit}>
    <header><div><span>Run Assistant</span><h2>{mode === 'create' ? 'Create a Room' : 'Choose Room scope'}</h2></div><button type="button" aria-label="Close" onclick={() => dialog?.close()}>×</button></header>
    {#if mode === 'create'}<label>Room name<input bind:value={name} required maxlength="128" /></label>{/if}
    <fieldset>
      <legend>Runs available to this Room</legend>
      {#each members as member (member.id)}
        {@const run = family.links.find(link => link.rel === 'contains' && link.ref.id === member.id)}
        <label class="run-choice"><input type="checkbox" checked={selectedIds.has(member.id)} onchange={() => toggleMember(member.id)} /><span>{run?.title ?? member.id}</span></label>
      {/each}
    </fieldset>
    <label class="future-choice"><input type="checkbox" bind:checked={includeFuture} /><span>Include future copies automatically</span></label>
    <p class="scope-note">Resources inside this Room Scope are open to its Agents. Individual Runs may apply narrower restrictions.</p>
    {#if error}<p class="assistant-error" role="alert">{error}</p>{/if}
    <footer><button type="button" onclick={() => dialog?.close()}>Cancel</button><button class="primary" type="submit" disabled={busy || selectedIds.size === 0 || (mode === 'create' && name.trim().length === 0)}>{busy ? 'Saving…' : mode === 'create' ? 'Create Room' : 'Save scope'}</button></footer>
  </form>
</dialog>
