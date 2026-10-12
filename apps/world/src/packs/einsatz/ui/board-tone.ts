/**
 * The Board's tones. Browsers start audio only from an operator's gesture, so
 * the tone is created by the click that enables sound and plays from then on.
 * The panel closes it when it unmounts, a role switch included; the next
 * Board starts with sound off and asks for the gesture again.
 */

export interface BoardTone {
  readonly play: (tone: 'new-work') => void
  /** Releases the audio context; the tone plays no more. */
  readonly close: () => Promise<void>
}

/** Two short rising beeps, for new work and work returned to the queue. */
const newWork: ReadonlyArray<{ readonly hz: number; readonly atS: number }> = [{ hz: 660, atS: 0 }, { hz: 880, atS: 0.16 }]
const beepS = 0.12

export const createBoardTone = (): BoardTone => {
  const context = new AudioContext()
  return {
    play: () => {
      const start = context.currentTime
      for (const beep of newWork) {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        oscillator.frequency.value = beep.hz
        gain.gain.setValueAtTime(0.0001, start + beep.atS)
        gain.gain.exponentialRampToValueAtTime(0.2, start + beep.atS + 0.01)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + beep.atS + beepS)
        oscillator.connect(gain).connect(context.destination)
        oscillator.start(start + beep.atS)
        oscillator.stop(start + beep.atS + beepS)
      }
    },
    close: async () => { await context.close() },
  }
}
