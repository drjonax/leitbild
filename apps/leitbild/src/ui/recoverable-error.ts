/**
 * An error a repeating read reports to the page while it fails, and takes
 * back once the read succeeds again: the page's banner never keeps saying
 * "Lost the connection" after the connection is back. Taking it back clears
 * the banner only while it still shows that same message, never another
 * error reported since.
 */
export const createRecoverableError = (ports: {
  readonly report: (message: string) => void
  readonly retract: (message: string) => void
}) => {
  let reported: string | null = null
  return {
    failed: (message: string): void => {
      reported = message
      ports.report(message)
    },
    recovered: (): void => {
      if (reported === null) return
      const message = reported
      reported = null
      ports.retract(message)
    },
  }
}

/** The page's banner after an error is taken back: cleared only where it still shows that error. */
export const bannerAfterRetract = (shown: string | null, retracted: string): string | null => shown === retracted ? null : shown
