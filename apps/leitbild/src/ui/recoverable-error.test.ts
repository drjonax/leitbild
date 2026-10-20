import { describe, expect, test } from 'bun:test'
import { bannerAfterRetract, createRecoverableError } from './recoverable-error.ts'

const lost = 'Lost the connection to the simulation. Reload to check whether the action was applied.'

describe('an error a repeating read reports', () => {
  test('is taken back once the read succeeds again, and only once', () => {
    const banner: { shown: string | null } = { shown: null }
    const error = createRecoverableError({
      report: message => { banner.shown = message },
      retract: message => { banner.shown = bannerAfterRetract(banner.shown, message) },
    })
    error.recovered()
    expect(banner.shown).toBeNull()
    error.failed(lost)
    error.failed(lost)
    expect(banner.shown).toBe(lost)
    error.recovered()
    expect(banner.shown).toBeNull()
    // Another error shown since is not the read's to take back.
    error.failed(lost)
    banner.shown = 'Copying the Run failed'
    error.recovered()
    expect(banner.shown).toBe('Copying the Run failed')
  })
})
