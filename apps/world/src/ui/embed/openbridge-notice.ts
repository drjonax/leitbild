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
  readonly fileName: string
  code: string
  readonly moduleIds: ReadonlyArray<string>
  readonly viteMetadata?: { readonly importedCss: Set<string> }
}

interface NoticeAsset {
  readonly type: 'asset'
  readonly names: ReadonlyArray<string>
  readonly originalFileNames: ReadonlyArray<string>
  readonly source: string | Uint8Array
}

/** The chunks with OpenBridge code. */
const openBridgeChunks = (bundle: Readonly<Record<string, NoticeChunk | NoticeAsset | { readonly type: string }>>): ReadonlyArray<NoticeChunk> =>
  Object.values(bundle).flatMap(output => output.type === 'chunk' && (output as NoticeChunk).moduleIds.some(fromOpenBridge) ? [output as NoticeChunk] : [])

/**
 * Adds the notice to every emitted script with OpenBridge code (as its
 * post-minification banner, kept its first bytes) and to the stylesheets
 * those scripts import.
 *
 * World serves its built files immutable, so each one's name must follow its
 * final bytes. A script's hash takes the notice in (augmentChunkHash). A
 * stylesheet is named by its hash before the notice heads it, so it is emitted
 * again, headed, under the name its final bytes hash to, and its chunk names
 * that one: the page that links it and the chunks that preload it are written
 * after this, and every chunk that preloads it imports the OpenBridge chunk,
 * whose hash the notice is in.
 */
export const openBridgeLicenceNotice = (packages: ReadonlyArray<OpenBridgePackage>): Plugin[] => {
  const notice = openBridgeNotice(packages)
  return [{
    name: 'leitbild:openbridge-licence-notice',
    outputOptions: options => ({
      ...options,
      postBanner: chunk => (chunk.moduleIds.some(fromOpenBridge) ? notice : ''),
    }),
    augmentChunkHash: chunk => (chunk.moduleIds.some(fromOpenBridge) ? notice : undefined),
    generateBundle(_options, bundle) {
      const renamed = new Map<string, string>()
      for (const chunk of openBridgeChunks(bundle as never)) {
        const importedCss = chunk.viteMetadata?.importedCss
        if (importedCss === undefined) continue
        for (const fileName of [...importedCss]) {
          const named = renamed.get(fileName) ?? (() => {
            const asset = bundle[fileName] as NoticeAsset | NoticeChunk | undefined
            if (asset?.type !== 'asset') throw new Error(`OpenBridge stylesheet ${fileName} is not in the bundle`)
            const source = typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source)
            delete bundle[fileName]
            const headed = this.getFileName(this.emitFile({
              type: 'asset',
              ...(asset.names[0] === undefined ? {} : { name: asset.names[0] }),
              ...(asset.originalFileNames[0] === undefined ? {} : { originalFileName: asset.originalFileNames[0] }),
              source: `${notice}\n${source}`,
            }))
            renamed.set(fileName, headed)
            return headed
          })()
          importedCss.delete(fileName)
          importedCss.add(named)
        }
      }
    },
  }, {
    // Vite writes its dynamic-import dependency map (`__vite__mapDeps`) at the top of a chunk that imports one
    // lazily, after every banner (vite:build-import-analysis, generateBundle): the notice then moves back to the
    // chunk's first bytes. The chunk's name already follows the notice (augmentChunkHash above).
    name: 'leitbild:openbridge-licence-notice-first',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        for (const chunk of openBridgeChunks(bundle as never)) {
          if (chunk.code.startsWith(notice)) continue
          const at = chunk.code.indexOf(`${notice}\n`)
          if (at < 0) throw new Error(`${chunk.fileName} carries OpenBridge code without its notice`)
          chunk.code = `${notice}\n${chunk.code.slice(0, at)}${chunk.code.slice(at + notice.length + 1)}`
        }
      },
    },
  }]
}
