import { createWorldApplicationAssembly } from './app-assembly.ts'
import { createServer } from './core/api/server.ts'
import { scenarioAuthoringCatalogFor } from './core/scenarios/authoring.ts'
import { compileScenarioDefinition } from './core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from './core/scenarios/runtime-resolver.ts'
import { createWorldModuleState } from './core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from './core/workspaces/runtime-registry.ts'
import { createConfiguredProcedureSourceService } from './procedure-sources.ts'
import { createRoutingAdapterFromEnv } from './routing/config.ts'
import { builtinScenarioDefinitions } from './scenarios/definitions.ts'
import { builtinFeaturedScenarioDefinitions } from './scenarios/featured.ts'

const routing = createRoutingAdapterFromEnv()
const assembly = createWorldApplicationAssembly({ routing })
const worldPacks = assembly.packs
const scenarioRuntimeResolver = createScenarioRuntimeResolver({ packs: worldPacks })

const dataDir = process.env.LEITBILD_DATA_DIR ?? 'data'
const workspaceHostUrl = process.env.WORKSPACE_HOST_URL
if (workspaceHostUrl === undefined) {
  throw new Error('WORKSPACE_HOST_URL is required: World is entered through the Workspace Host')
}
const moduleState = createWorldModuleState({ dataDir })
const workspaces = createWorldWorkspaceRuntimeRegistry({
  dataDir,
  moduleState,
  scenarioRuntimeResolver,
  scenarioDefinitions: builtinScenarioDefinitions,
  compileScenarioDefinition: source => compileScenarioDefinition(source, worldPacks, { routing }),
  scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(worldPacks),
  runtimeAdapters: assembly.runtimeAdapters,
  procedureSourceService: createConfiguredProcedureSourceService({ dataDir }),
})

const server = createServer({ workspaces, featuredDefinitions: builtinFeaturedScenarioDefinitions, workspaceHostUrl })

let shuttingDown = false
const shutdown = (): void => {
  if (shuttingDown) return
  shuttingDown = true
  void server.stop().then(() => process.exit(0), error => {
    console.error('World shutdown failed:', error)
    process.exit(1)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

console.log(`Leitbild running at http://localhost:${server.port}`)
