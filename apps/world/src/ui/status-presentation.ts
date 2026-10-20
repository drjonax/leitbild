import type { PackObjectStatusTone } from '../core/packs/protocol.ts'

/** The Plant's map colour, grey while its runtime is pending: a status or priority is a word, never a hue (plan v3.1 §2.7, D9). */
export const statusToneColor = (tone: PackObjectStatusTone): string => tone === 'idle' ? '#6e788c' : '#0f915f'
