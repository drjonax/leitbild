import { describe,expect,test } from 'bun:test'
import { readdirSync,readFileSync,statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const uiRoot = join(import.meta.dir, '..', 'src', 'ui')

const svelteFiles = (dir: string): readonly string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) return svelteFiles(path)
    return path.endsWith('.svelte') ? [path] : []
  })

const effectSnippets = (source: string): readonly string[] => {
  const snippets: string[] = []
  const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? ''
  const ast = ts.createSourceFile('component.ts', script, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === '$effect') snippets.push(node.getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return snippets
}

describe('Svelte lifecycle policy', () => {
  test('uses runOnMount for mount-only external lifecycle effects', () => {
    const forbiddenMountOnlyCalls = [
      'addEventListener',
      'setInterval',
      'new MapLibre',
    ]
    const violations = svelteFiles(uiRoot).flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return effectSnippets(source)
        .filter(snippet => forbiddenMountOnlyCalls.some(call => snippet.includes(call)))
        .map(snippet => `${file}: ${snippet.split('\n')[0]}`)
    })

    expect(violations).toEqual([])
  })

  test('keeps MapLibre lifecycle and resize ownership inside MapRuntime', () => {
    const operationalMap = readFileSync(join(uiRoot, 'OperationalMap.svelte'), 'utf8')
    const mapRuntime = readFileSync(join(uiRoot, 'map-runtime', 'map-runtime.ts'), 'utf8')

    expect(operationalMap).not.toContain('new MapLibre')
    expect(operationalMap).not.toContain('ResizeObserver')
    expect(operationalMap).not.toContain('PmtilesProtocol')
    expect(operationalMap).toContain('createMapRuntime')
    expect(mapRuntime).toContain('new MapLibre')
    expect(mapRuntime).toContain('ResizeObserver')
    expect(mapRuntime).not.toContain('PmtilesProtocol')
    expect(mapRuntime).toContain('maplibre-gl/dist/maplibre-gl-worker.mjs?url')
    expect(mapRuntime).toContain('setWorkerUrl')
  })

  test('process-display child modals opt back into pointer events', () => {
    const css = readFileSync(join(uiRoot, 'style.css'), 'utf8')
    const processLayer = css.match(/\.process-display-window-layer\s*\{[^}]*\}/)?.[0] ?? ''
    const artifactBackdrop = css.match(/\.process-artifact-backdrop\s*\{[^}]*\}/)?.[0] ?? ''
    const procedureBackdrop = css.match(/\.procedure-backdrop\s*\{[^}]*\}/)?.[0] ?? ''

    expect(processLayer).toContain('pointer-events: none')
    expect(artifactBackdrop).toContain('pointer-events: auto')
    expect(procedureBackdrop).toContain('pointer-events: auto')
  })

  test('process display window stays independent from live object telemetry and window geometry', () => {
    const windowSource = readFileSync(join(uiRoot, 'process-display', 'DisplayWindow.svelte'), 'utf8')
    const frameSource = readFileSync(join(uiRoot, 'process-display', 'DisplayFrame.svelte'), 'utf8')

    // A display's page is fixed for the life of its frame: live telemetry,
    // zoom and dragging resize the frame but never reload or blank it. The
    // framed views sample the Run themselves, so the window installs no poller.
    expect(frameSource).toContain('const source = untrack(() =>')
    expect(windowSource).toContain('const runId = untrack(() => simulationRunId)')
    expect(windowSource).not.toContain('setInterval(')
    expect(frameSource).not.toContain('setInterval(')
  })

  test('floating window drag guards ignore icon clicks inside buttons', () => {
    const procedureSource = readFileSync(join(uiRoot, 'procedures', 'ProcedureSystemModal.svelte'), 'utf8')
    const processDisplaySource = readFileSync(join(uiRoot, 'process-display', 'DisplayWindow.svelte'), 'utf8')

    expect(procedureSource).toContain('target instanceof Element && target.closest')
    expect(processDisplaySource).toContain('target instanceof Element && target.closest')
    expect(procedureSource).not.toContain('target instanceof HTMLElement && target.closest')
    expect(processDisplaySource).not.toContain('target instanceof HTMLElement && target.closest')
  })
})
