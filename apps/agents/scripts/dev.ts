// Dev orchestrator — watches the server, browser bundle, and Tailwind output,
// and forwards signals so Ctrl-C cleans up every child.
//
// CSS startup is no longer this script's concern: src/bootstrap.ts calls
// ensureCssBuilt() before the server starts listening, so dist.css always
// exists at boot regardless of how the server was launched. This script
// just adds the watch loops on top. The package dev command creates the first
// complete build before this script starts.
//
// If either child crashes independently (non-zero exit without our sibling
// cleanup firing), we log loudly so the developer doesn't end up with a
// stale dist.css or a dead server and no clue why.

let shuttingDown = false

const spawnChild = (cmd: string[], label: string): Bun.Subprocess => {
  const child = Bun.spawn(cmd, {
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  })
  child.exited.then((code) => {
    if (shuttingDown) return
    if (code === 0) {
      // tailwind --watch can exit 0 without doing anything when stdin
      // isn't a tty (some launchers close stdin). The server's
      // ensureCssBuilt covers the dist.css build itself; without the
      // watcher you just lose hot rebuild on input.css edits.
      const detail = label === 'tailwind'
        ? 'styles will not auto-rebuild — restart with: bun run dev'
        : label === 'ui'
          ? 'the browser bundle will not auto-rebuild — restart with: bun run dev'
          : 'restart with: bun run dev'
      console.error(`[dev] ${label} exited cleanly (code 0). ${detail}`)
    } else {
      const detail = label === 'tailwind'
        ? 'styles are now stale — restart dev after fixing the error.'
        : label === 'ui'
          ? 'the browser bundle is now stale — restart dev after fixing the error.'
          : 'the server is down.'
      console.error(`\n[dev] ⚠  ${label} crashed with exit code ${code}. ${detail}\n[dev]   Restart with: bun run dev\n`)
    }
  })
  return child
}

const server = spawnChild(
  [process.execPath, '--watch', 'src/main.ts'],
  'server',
)

const ui = spawnChild(
  [
    process.execPath, 'build', 'src/ui/modules/app.ts',
    '--outdir', 'src/ui/dist',
    '--splitting',
    '--entry-naming', 'app.js',
    '--chunk-naming', 'chunk-[hash].js',
    '--asset-naming', 'asset-[name]-[hash].[ext]',
    '--target', 'browser',
    '--format', 'esm',
    '--minify',
    '--watch',
  ],
  'ui',
)

const css = spawnChild(
  [
    process.execPath, 'run', 'tailwindcss',
    '-i', 'src/ui/input.css',
    '-o', 'src/ui/dist.css',
    '--watch',
  ],
  'tailwind',
)

const cleanup = (): void => {
  shuttingDown = true
  for (const child of [server, ui, css]) {
    try { child.kill() } catch { /* already exited */ }
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

// Stay alive until both children exit.
await Promise.all([server.exited, ui.exited, css.exited])
