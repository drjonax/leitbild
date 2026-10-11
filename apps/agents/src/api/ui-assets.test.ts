import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentsUiAssetFromPath, agentsUiAssetPath, serveAgentsUiAsset } from './ui-assets.ts'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Agents UI asset namespace', () => {
  test('uses one explicit, collision-free public namespace', () => {
    expect(agentsUiAssetPath('app.js')).toBe('/assets/agents/app.js')
    expect(agentsUiAssetPath('styles.css')).toBe('/assets/agents/styles.css')
  })

  test('does not expose arbitrary files from the UI tree', () => {
    expect(agentsUiAssetFromPath('/assets/agents/app.js')).toBe('app.js')
    expect(agentsUiAssetFromPath('/assets/agents/styles.css')).toBe('styles.css')
    expect(agentsUiAssetFromPath('/assets/agents/chunk-aB12_cd3.js')).toBe('chunk-aB12_cd3.js')
    expect(agentsUiAssetFromPath('/assets/agents/../modules/app.ts')).toBeNull()
    expect(agentsUiAssetFromPath('/assets/agents/%2e%2e/app.js')).toBeNull()
    expect(agentsUiAssetFromPath('/assets/agents/chunk-abc.js%2f..%2fsecrets.json')).toBeNull()
    expect(agentsUiAssetFromPath('/assets/agents/chunk-abc.js/../app.js')).toBeNull()
    expect(agentsUiAssetFromPath('/assets/agents/secrets.js')).toBeNull()
    expect(agentsUiAssetFromPath('/dist/app.js')).toBeNull()
  })

  test('serves the built application, stylesheet and release chunks', async () => {
    const uiPath = await mkdtemp(join(tmpdir(), 'leitbild-agents-ui-'))
    temporaryDirectories.push(uiPath)
    await mkdir(join(uiPath, 'dist'))
    await writeFile(join(uiPath, 'dist', 'app.js'), 'globalThis.booted = true')
    await writeFile(join(uiPath, 'dist', 'chunk-aB12_cd3.js'), 'export const diagram = true')
    await writeFile(join(uiPath, 'dist.css'), 'body { color: black }')

    const script = await serveAgentsUiAsset('/assets/agents/app.js', uiPath)
    expect(script?.headers.get('content-type')).toBe('application/javascript')
    expect(script?.headers.get('cache-control')).toBe('no-cache')
    expect(await script?.text()).toBe('globalThis.booted = true')

    const stylesheet = await serveAgentsUiAsset('/assets/agents/styles.css', uiPath)
    expect(stylesheet?.headers.get('content-type')).toBe('text/css')
    expect(await stylesheet?.text()).toBe('body { color: black }')
    const chunk = await serveAgentsUiAsset('/assets/agents/chunk-aB12_cd3.js', uiPath)
    expect(chunk?.headers.get('content-type')).toBe('application/javascript')
    expect(chunk?.headers.get('cache-control')).toBe('no-cache')
    expect(await chunk?.text()).toBe('export const diagram = true')
    expect(await serveAgentsUiAsset('/assets/agents/chunk-missing.js', uiPath)).toBeNull()
    expect(await serveAgentsUiAsset('/assets/agents/secrets.json', uiPath)).toBeNull()
  })
})
