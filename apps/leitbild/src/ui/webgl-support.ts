// The World map needs WebGL 2. Checked before a demo creates anything (plan v2
// §5.3 step 0), so a browser that cannot draw the map never gets a Workspace.

export const WEBGL_MISSING_TEXT = 'Your browser cannot draw the map (WebGL 2 is off). Try a current desktop browser or an iPad.'

export interface WebglProbe {
  createCanvas(): { getContext(kind: 'webgl2'): unknown } | null
}

export const browserWebglProbe: WebglProbe = {
  createCanvas: () => typeof document === 'undefined' ? null : document.createElement('canvas'),
}

let cached: boolean | null = null

/** True when a WebGL 2 context can be created. The browser answer is cached for the page. */
export const supportsWebgl2 = (probe: WebglProbe = browserWebglProbe): boolean => {
  const useCache = probe === browserWebglProbe
  if (useCache && cached !== null) return cached
  let supported = false
  try {
    const canvas = probe.createCanvas()
    const context = canvas?.getContext('webgl2') as { getExtension?: (name: string) => { loseContext?: () => void } | null } | null | undefined
    supported = context !== null && context !== undefined
    // Release the probe context; browsers cap live WebGL contexts per page.
    context?.getExtension?.('WEBGL_lose_context')?.loseContext?.()
  } catch {
    supported = false
  }
  if (useCache) cached = supported
  return supported
}
