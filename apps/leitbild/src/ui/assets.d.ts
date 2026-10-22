declare module '*.css'
declare module '*.svelte'
declare module '*.webp' {
  const src: string
  export default src
}
declare module '*.svg' {
  const src: string
  export default src
}
/** Vite's import.meta.glob, which the Landing page uses for its hero images; Bun's types declare the rest of import.meta. */
interface ImportMeta {
  readonly glob: import('vite').ImportGlobFunction
}
