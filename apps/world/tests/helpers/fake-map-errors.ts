import { createMapErrorRouter } from '../../src/ui/map-runtime/map-error-router.ts'
import type { MapErrorClaim } from '../../src/ui/map-runtime/types.ts'

/**
 * The map runtime's error routing on a fake map, wired as `createMapRuntime` wires it to
 * MapLibre; records the reference warnings and runtime errors it would raise.
 */
export const routeMapErrors = (map: { on(type: 'error', listener: (event: unknown) => void): void }) => {
  const warnings: string[] = []
  const runtimeErrors: string[] = []
  const router = createMapErrorRouter({
    onReferenceWarning: message => warnings.push(message),
    onRuntimeError: details => runtimeErrors.push(details.message),
  })
  map.on('error', router.route)
  let claims = 0
  const claimErrors = (claim: MapErrorClaim): (() => void) => {
    const release = router.claim(claim)
    claims += 1
    let released = false
    return () => {
      if (released) return
      released = true
      claims -= 1
      release()
    }
  }
  return { warnings, runtimeErrors, claimErrors, claimCount: () => claims }
}
