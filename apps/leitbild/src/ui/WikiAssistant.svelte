<script lang="ts">
  import type { Workspace } from '@leitbild/contracts'
  import AssistantLauncher from './AssistantLauncher.svelte'
  import { openAssistantConversation, type WikiAssistantPage } from './assistant-handoff.ts'
  import { errorDiagnostic, plainErrorText } from './error-text.ts'
  import { createWorkspaceApi, workspaceLabel } from './launch-workspace.ts'
  import { browserWorkspaceMemory } from './workspace-memory.ts'

  let { page }: { page: WikiAssistantPage | null } = $props()
  const api = createWorkspaceApi()
  const memory = browserWorkspaceMemory()
  // '' = a new Workspace is created for this conversation.
  let workspaces = $state<ReadonlyArray<Workspace>>([])
  let workspaceId = $state('')
  let loaded = $state(false)

  // The launcher shows a thrown message as is: give it plain text, keep the code for the console.
  const plainly = async (action: () => Promise<void>): Promise<void> => {
    try { await action() }
    catch (cause) {
      console.error(errorDiagnostic(cause))
      throw new Error(plainErrorText(cause))
    }
  }

  const prepare = (): Promise<void> => plainly(async () => {
    loaded = false
    workspaces = await api.list()
    if (!workspaces.some(item => item.id === workspaceId)) {
      const remembered = memory.remembered()
      workspaceId = workspaces.some(item => item.id === remembered) ? remembered! : ''
    }
    loaded = true
  })

  const ask = (prompt: string): Promise<void> => plainly(async () => {
    const handoff = await openAssistantConversation({
      text: prompt, origin: { kind: 'wiki', page }, conversation: 'reuse', workspaceId: workspaceId || null,
    }, { api, memory, now: () => new Date(), fetch: (input, init) => fetch(input, init) })
    location.assign(handoff.destination)
  })
</script>

<AssistantLauncher onOpen={prepare} submit={loaded ? ask : undefined}>
  {#snippet details(busy)}
    {#if loaded}
      <label>Conversation Workspace
        <select bind:value={workspaceId} disabled={busy} aria-label="Conversation Workspace">
          <option value="">A new Workspace</option>
          {#each workspaces as item (item.id)}<option value={item.id}>{workspaceLabel(item)}</option>{/each}
        </select>
      </label>
      <p class="page-reference">Workspaces are public: anyone can see, open, change or delete them.</p>
    {/if}
    {#if page}
      <p class="page-reference">Includes a reference to <strong>{page.title}</strong>, at revision <code title={page.revision}>{page.revision.slice(0, 12)}</code>. The Assistant can read this page and follow links as needed. Your conversation opens in Agents.</p>
    {/if}
  {/snippet}
</AssistantLauncher>

<style>
  select { width: 100%; padding: .6rem; border: 1px solid #bfc9bd; border-radius: 8px; color: #172019; background: white; font: inherit; }
  .page-reference { margin: 0; color: #5e695f; font-size: .8rem; line-height: 1.45; }
</style>
