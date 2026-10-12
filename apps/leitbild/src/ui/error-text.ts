// Plain-language text for errors the Host UI shows. The code is kept for the
// console and for callers that branch on it; it is never the user's text.
// Nothing here retries: a lost connection says so and asks for a reload.

export const TRANSPORT_LOST_TEXT = 'Lost the connection to the simulation. Reload to reconnect.'
export const HOST_UNREACHABLE_TEXT = 'Could not reach Leitbild. Check your connection and try again.'
export const CAPACITY_TEXT = 'Leitbild is at capacity right now. Please try again in a minute.'
export const OUTCOME_UNKNOWN_TEXT = 'The connection was lost before the result arrived, so it may have completed. Check before trying again.'
export const MODULE_UNAVAILABLE_TEXT = 'Part of Leitbild is not responding right now. Try again in a moment.'
export const WORKSPACE_GONE_TEXT = 'This Workspace no longer exists.'
export const GENERIC_ERROR_TEXT = 'Something went wrong. Try again.'

/** What the user can do next; the caller renders the matching control. */
export type ErrorAction = 'try-again' | 'reload' | 'check' | 'wait'

export interface PlainError {
  readonly text: string
  readonly code: string | null
  readonly status: number | null
  readonly action: ErrorAction
}

// Bun's fetch: "The socket connection was closed unexpectedly. For more information, pass `verbose: true` …"
// Browsers: "Failed to fetch" (Chromium), "Load failed" (Safari), "NetworkError when attempting to fetch resource." (Firefox).
const serverTransport = /socket connection was closed unexpectedly|verbose: true|ECONNREFUSED|ECONNRESET|connection refused|Unable to connect/i
const browserTransport = /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/i
// Messages that are raw diagnostics rather than sentences for people.
const rawDiagnostic = /\bHTTP \d{3}\b|\bat \S+:\d+|[{}[\]]|^\w+Error:|returned HTTP|Invalid input|expected .* received/i

const fieldOf = (error: unknown, key: 'code' | 'status' | 'message'): unknown =>
  typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[key] : undefined

export const isServerTransportMessage = (message: string): boolean => serverTransport.test(message)

export const plainError = (error: unknown): PlainError => {
  const rawCode = fieldOf(error, 'code')
  const rawStatus = fieldOf(error, 'status')
  const rawMessage = fieldOf(error, 'message')
  const code = typeof rawCode === 'string' ? rawCode : null
  const status = typeof rawStatus === 'number' ? rawStatus : null
  const message = typeof rawMessage === 'string' ? rawMessage.trim() : typeof error === 'string' ? error.trim() : ''
  const result = (text: string, action: ErrorAction): PlainError => ({ text, code, status, action })

  if (message && isServerTransportMessage(message)) return result(TRANSPORT_LOST_TEXT, 'reload')
  if (code === null && status === null && browserTransport.test(message)) return result(HOST_UNREACHABLE_TEXT, 'try-again')
  if (code === 'workspace_capacity_exceeded' || status === 503) return result(CAPACITY_TEXT, 'wait')
  if (code === 'module_outcome_unknown') return result(OUTCOME_UNKNOWN_TEXT, 'check')
  if (code === 'module_unavailable' || code === 'module_contract_invalid' || status === 502 || status === 504) {
    return result(MODULE_UNAVAILABLE_TEXT, 'try-again')
  }
  if (code === 'workspace_not_found') return result(WORKSPACE_GONE_TEXT, 'check')
  // A Module's own refusal ("This Run is paused") is written for people: keep it.
  if (message && message.length <= 240 && !rawDiagnostic.test(message)) return result(message, 'try-again')
  return result(GENERIC_ERROR_TEXT, 'try-again')
}

export const plainErrorText = (error: unknown): string => plainError(error).text

/** For the console: the code and the raw message, never shown as the user's text. */
export const errorDiagnostic = (error: unknown): string => {
  const { code, status } = plainError(error)
  const message = fieldOf(error, 'message')
  return [code, status === null ? null : `HTTP ${status}`, typeof message === 'string' ? message : String(error)]
    .filter(part => part !== null).join(' · ')
}
