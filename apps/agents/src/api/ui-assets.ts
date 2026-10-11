export const agentsUiAssetPath = (asset: 'app.js' | 'styles.css'): string =>
  `/assets/agents/${asset}`

export const agentsUiAssetFromPath = (pathname: string): string | null => {
  if (pathname === agentsUiAssetPath('app.js')) return 'app.js'
  if (pathname === agentsUiAssetPath('styles.css')) return 'styles.css'
  const chunk = pathname.match(/^\/assets\/agents\/(chunk-[a-zA-Z0-9_-]+\.js)$/)
  if (chunk) return chunk[1]!
  return null
}

export const serveAgentsUiAsset = async (pathname: string, uiPath: string): Promise<Response | null> => {
  const asset = agentsUiAssetFromPath(pathname)
  if (asset === null) return null
  const file = Bun.file(asset === 'styles.css' ? `${uiPath}/dist.css` : `${uiPath}/dist/${asset}`)
  if (!(await file.exists())) return null
  return new Response(file, {
    headers: {
      'Content-Type': asset.endsWith('.css') ? 'text/css' : 'application/javascript',
      // Stable names make development and release assembly one simple path.
      // Revalidation prevents an old bundle surviving a release switch.
      'Cache-Control': 'no-cache',
    },
  })
}
