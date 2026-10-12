<script lang="ts">
  import type { Component } from 'svelte'
  import { parseControlSurfaceRoute } from './simulation-run-route.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import { configureActiveWorkspace } from './workspace-context.ts'

  type RouteComponent = Component

  let Route = $state<RouteComponent | null>(null)
  let status = $state('Starting…')

  const loadRoute = async (): Promise<void> => {
    try {
      const route = parseControlSurfaceRoute(location.pathname)
      configureActiveWorkspace(route.workspaceId)
      if (route.mode === 'workspace-home') {
        const module = await import('./routes/WorldHomeRoute.svelte')
        Route = module.default
        return
      }
      if (route.mode === 'scenario-builder') {
        const module = await import('./routes/ScenarioBuilderRoute.svelte')
        Route = module.default
        return
      }
      const module = await import('./routes/ControlSurfaceRoute.svelte')
      Route = module.default
    } catch (err) {
      status = err instanceof Error ? err.message : 'Unable to read route'
    }
  }

  runOnMount(() => {
    void loadRoute()
  })
</script>

{#if Route}
  <Route />
{:else}
  <div class="boot-shell">{status}</div>
{/if}
