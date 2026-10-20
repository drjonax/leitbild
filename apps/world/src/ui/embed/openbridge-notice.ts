import type { Plugin } from 'vite'

// World's embedded views bundle OpenBridge (AGPL-3.0-only; NOTICE.md). Every
// emitted script and stylesheet that contains OpenBridge code says so at its
// top, with where its corresponding source is: the build adds the notice after
// minification (a script's `postBanner`, a stylesheet in generateBundle), so
// no minifier can drop it. Chunks without OpenBridge code carry none.

/** The public repository whose commit a deployment's World bundle is built from. */
export const LEITBILD_SOURCE_URL = 'https://github.com/michaelhil/leitbild'

export interface OpenBridgePackage {
  readonly name: string
  readonly version: string
}

/** A module from one of the OpenBridge packages, as the bundler names it. */
export const fromOpenBridge = (moduleId: string): boolean => moduleId.includes('/node_modules/@oicl/')

/** The licence notice, as a comment a script and a stylesheet both accept and minifiers keep. */
export const openBridgeNotice = (packages: ReadonlyArray<OpenBridgePackage>): string => {
  if (packages.length === 0) throw new Error('the OpenBridge notice names no package')
  const named = packages.map(entry => `${entry.name} ${entry.version}`).join(', ')
  return `/*! This file contains OpenBridge web components (${named}; © OpenBridge Components AS), licensed AGPL-3.0-only, and is distributed under the terms of the GNU Affero General Public License 3.0. Corresponding source: ${LEITBILD_SOURCE_URL} at the deployed commit, with the unmodified upstream packages at these versions. See NOTICE.md. */`
}

interface NoticeChunk {
  readonly type: 'chunk'
  readonly moduleIds: ReadonlyArray<string>
  readonly viteMetadata?: { readonly importedCss: ReadonlySet<string> }
}

interface NoticeAsset {
  readonly type: 'asset'
  source: string | Uint8Array
}

/** The stylesheets Vite emitted for chunks with OpenBridge code. */
const openBridgeStylesheets = (bundle: Readonly<Record<string, NoticeChunk | NoticeAsset | { readonly type: string }>>): ReadonlySet<string> =>
  new Set(Object.values(bundle).flatMap(output => output.type === 'chunk' && (output as NoticeChunk).moduleIds.some(fromOpenBridge)
    ? [...((output as NoticeChunk).viteMetadata?.importedCss ?? [])]
    : []))

/**
 * Adds the notice to every emitted script with OpenBridge code (as its
 * post-minification banner) and to the stylesheets those scripts import.
 */
export const openBridgeLicenceNotice = (packages: ReadonlyArray<OpenBridgePackage>): Plugin => {
  const notice = openBridgeNotice(packages)
  return {
    name: 'leitbild:openbridge-licence-notice',
    outputOptions: options => ({
      ...options,
      postBanner: chunk => (chunk.moduleIds.some(fromOpenBridge) ? notice : ''),
    }),
    generateBundle(_options, bundle) {
      for (const fileName of openBridgeStylesheets(bundle as never)) {
        const asset = bundle[fileName]
        if (asset?.type !== 'asset') throw new Error(`OpenBridge stylesheet ${fileName} is not in the bundle`)
        const source = typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source)
        asset.source = `${notice}\n${source}`
      }
    },
  }
}
