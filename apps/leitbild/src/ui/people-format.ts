// Words, initials, colours and log layout for People and direct chat (UX SPEC
// §2, §3, §6, §11). Pure functions: the session and the components share them,
// and the tests read them without a DOM.

/** Names are 1–32 code points (CONTRACT "Identity & names"). */
export const NAME_MAX = 32
/** The name counter appears near the limit, not while typing a short name. */
export const NAME_COUNTER_FROM = 26
/** Messages are 1–2000 code points (CONTRACT "Send"). */
export const MESSAGE_MAX = 2_000
/** The message counter appears near the limit only. */
export const MESSAGE_COUNTER_FROM = 1_800
/** Agents keeps the newest 200 messages per conversation. */
export const HISTORY_CAP = 200
/** Consecutive messages from one sender less than 3 min apart form one group. */
export const MESSAGE_GROUP_GAP_MS = 180_000
/** The toast's one-line preview. */
export const PREVIEW_MAX = 80
/** Badges count to nine in the bar, to 99 in rows. */
export const BADGE_MAX = 9
export const PILL_MAX = 99

export const NAME_TEXT = {
  empty: 'Enter a name.',
  tooLong: `Use ${NAME_MAX} characters or fewer.`,
  invalidCharacters: 'This name has characters that can’t be used. Try another name.',
  taken: (name: string): string => `“${isolate(name)}” is already taken in this Workspace. Try another name.`,
  rateLimited: 'Too many name changes. Try again in a minute.',
  reconnecting: 'Can’t save while reconnecting. Try again in a moment.',
  failed: 'Couldn’t save your name. Try again.',
} as const

export const SEND_REASON = {
  unreachable: 'couldn’t reach Leitbild.',
  tooLong: 'message is too long.',
  invalidCharacters: 'message has characters that can’t be sent.',
  empty: 'message is empty.',
  personGone: 'this person is no longer in this Workspace.',
  rateLimited: 'sending too fast.',
  failed: 'something went wrong.',
} as const

/** Shown for a person whose name this page never received: an explicit state, warned once in the console. */
export const UNKNOWN_PERSON_NAME = 'Unknown person'
export const SEND_NOTE = {
  rateLimited: 'Sending too fast — trying again in a moment',
} as const

export const STORAGE_BLOCKED_TEXT = 'This browser blocks site storage, so your name lasts only while this page is open.'
export const OUTBOX_UNSAVED_TEXT = 'This browser can’t keep unsent messages, so they’re lost if the page reloads.'
export const PEOPLE_FAILED_TEXT = 'People aren’t available right now.'

const codePoints = (text: string): number => [...text].length

/**
 * A name inside a sentence, isolated from the text around it (FSI … PDI, the
 * plain-text <bdi>), so a right-to-left name cannot reorder the sentence. For
 * text that is not markup: attributes, errors and toasts.
 */
export const isolate = (text: string): string => `\u2068${text}\u2069`

/** As SPEC §5 "Enter": NFC, line breaks and runs of whitespace become one space, trimmed. */
export const normaliseName = (raw: string): string => raw.normalize('NFC').replace(/\s+/gu, ' ').trim()

/** The client's own check before asking Agents, which stays authoritative. */
export const nameProblem = (name: string): string | null => {
  if (name === '') return NAME_TEXT.empty
  if (codePoints(name) > NAME_MAX) return NAME_TEXT.tooLong
  return null
}

/** The default names Agents hands out ("User1"); anything else was chosen. */
export const isDefaultName = (name: string): boolean => /^User[1-9]\d*$/.test(name)

/**
 * What is sent: NFC with trailing whitespace trimmed (CONTRACT "Send"), a lone
 * surrogate made U+FFFD first, exactly as Agents normalises it.
 */
export const messageText = (raw: string): string => raw.toWellFormed().normalize('NFC').replace(/\s+$/u, '')

export const messageLength = (raw: string): number => codePoints(messageText(raw))

export const messageSendable = (raw: string): boolean => {
  const text = messageText(raw)
  return text.trim() !== '' && codePoints(text) <= MESSAGE_MAX
}

const englishNumber = new Intl.NumberFormat('en')

/** "1,850 / 2,000", then "12 characters over the limit.", nothing below 1,800. */
export const messageCounterText = (raw: string): { readonly text: string; readonly over: boolean } | null => {
  const length = messageLength(raw)
  if (length < MESSAGE_COUNTER_FROM) return null
  const over = length - MESSAGE_MAX
  if (over > 0) return { text: `${englishNumber.format(over)} ${over === 1 ? 'character' : 'characters'} over the limit.`, over: true }
  return { text: `${englishNumber.format(length)} / ${englishNumber.format(MESSAGE_MAX)}`, over: false }
}

/** "28/32" from 26 code points. */
export const nameCounterText = (raw: string): { readonly text: string; readonly over: boolean } | null => {
  const length = codePoints(raw)
  if (length < NAME_COUNTER_FROM) return null
  return { text: `${length}/${NAME_MAX}`, over: length > NAME_MAX }
}

const firstLetter = (word: string): string => [...word][0] ?? ''

/** SPEC §2: "User12" → "U12", "Ben (turbine)" → "BT", "Dora Lindqvist" → "DL". */
export const initials = (name: string): string => {
  const words = name.trim().split(/\s+/u).map(word => word.replace(/^[^\p{L}\p{N}]+/u, '')).filter(word => word !== '')
  if (words.length === 0) return '?'
  if (words.length >= 2) return (firstLetter(words[0]!) + firstLetter(words[1]!)).toUpperCase()
  const word = words[0]!
  const numbered = word.match(/^(\D+?)(\d+)$/u)
  return numbered ? [...(firstLetter(numbered[1]!).toUpperCase() + numbered[2]!)].slice(0, 3).join('') : firstLetter(word).toUpperCase()
}

/** Six avatar tones; keyed on the id, so a rename keeps the colour. */
export const AVATAR_TONES = 6
export const avatarTone = (personId: string): number => {
  let hash = 0
  for (const character of personId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return hash % AVATAR_TONES
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

export const unreadPhrase = (count: number): string => plural(count, 'unread message', 'unread messages')

export type TriggerMode = 'loading' | 'reconnecting' | 'unavailable' | 'live'

/** The header control's accessible name, mirrored in its title (SPEC §3). */
export const triggerLabel = (mode: TriggerMode, others: number, unread: number): string => {
  const base = mode === 'loading'
    ? 'People in this simulation, loading'
    : mode === 'reconnecting'
      ? 'People in this simulation, reconnecting'
      : mode === 'unavailable'
        ? 'People in this simulation, unavailable'
        : others === 0 ? 'People in this simulation: just you' : `People in this simulation: you and ${plural(others, 'other', 'others')}`
  return unread > 0 ? `${base}, ${unreadPhrase(unread)}` : base
}

export const badgeText = (count: number): string => count > BADGE_MAX ? `${BADGE_MAX}+` : String(count)
export const pillText = (count: number): string => count > PILL_MAX ? `${PILL_MAX}+` : String(count)

/** "User3, in this simulation, 2 unread messages" (SPEC §9). */
export const rowLabel = (name: string, here: boolean, unread: number): string =>
  `${name}, ${here ? 'in this simulation' : 'not here'}${unread > 0 ? `, ${unreadPhrase(unread)}` : ''}`

/** One line of at most 80 characters, newlines as spaces. */
export const previewText = (text: string): string => {
  const line = text.replace(/\s+/gu, ' ').trim()
  const characters = [...line]
  return characters.length > PREVIEW_MAX ? `${characters.slice(0, PREVIEW_MAX - 1).join('')}…` : line
}

export const newMessagesPill = (count: number): string => `↓ ${plural(count, 'new message', 'new messages')}`

const dayStart = (time: number): number => {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}
const DAY_MS = 86_400_000

/** "Today", "Yesterday", then "12 October". */
export const dayLabel = (time: number, now: number): string => {
  const days = Math.round((dayStart(now) - dayStart(time)) / DAY_MS)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
}

export const timeLabel = (time: number): string => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
export const fullTimeLabel = (time: number): string => new Date(time).toLocaleString()

/** What the chat log shows, oldest first; the session builds it, the layout groups it. */
export type ChatItem =
  | { readonly kind: 'message'; readonly key: string; readonly seq: number; readonly mine: boolean; readonly text: string; readonly at: number }
  | {
    readonly kind: 'outgoing'; readonly key: string; readonly text: string; readonly at: number; readonly stage: 'quiet' | 'sending' | 'failed'
    readonly reason: string | null
    /** Why a message still on its way is waiting, e.g. a rate limit; shown instead of "Sending…". */
    readonly note: string | null
  }
  /** "Ben is now called Benjamin", added while the chat is open. */
  | { readonly kind: 'note'; readonly key: string; readonly oldName: string; readonly newName: string; readonly at: number }

export type ChatBubble = Extract<ChatItem, { kind: 'message' | 'outgoing' }>

export type ChatRow =
  | { readonly kind: 'day'; readonly key: string; readonly label: string }
  | { readonly kind: 'new'; readonly key: string }
  | { readonly kind: 'note'; readonly key: string; readonly oldName: string; readonly newName: string }
  | { readonly kind: 'group'; readonly key: string; readonly mine: boolean; readonly bubbles: ReadonlyArray<ChatBubble> }

const mineOf = (item: ChatBubble): boolean => item.kind === 'outgoing' || item.mine

/**
 * Day separators, the "New" divider and groups (SPEC §6 "Log"). A message on
 * its way groups like a delivered one, and keeps its key when delivered, so
 * delivery never moves its bubble to another group: no node is rebuilt and
 * read out twice. Row keys come from the first item they hold, so appending
 * keeps earlier rows.
 */
export const chatRows = (items: ReadonlyArray<ChatItem>, firstUnreadKey: string | null, now: number): ReadonlyArray<ChatRow> => {
  const rows: ChatRow[] = []
  let day: string | null = null
  let group: { key: string; mine: boolean; bubbles: ChatBubble[] } | null = null
  const close = (): void => {
    if (group !== null) rows.push({ kind: 'group', key: group.key, mine: group.mine, bubbles: group.bubbles })
    group = null
  }
  for (const item of items) {
    const label = dayLabel(item.at, now)
    if (label !== day) {
      close()
      rows.push({ kind: 'day', key: `day:${item.key}`, label })
      day = label
    }
    if (item.key === firstUnreadKey) {
      close()
      rows.push({ kind: 'new', key: 'new' })
    }
    if (item.kind === 'note') {
      close()
      rows.push({ kind: 'note', key: item.key, oldName: item.oldName, newName: item.newName })
      continue
    }
    const current = group as { key: string; mine: boolean; bubbles: ChatBubble[] } | null
    const last = current?.bubbles[current.bubbles.length - 1]
    const joins = current !== null && last !== undefined && current.mine === mineOf(item) && item.at - last.at <= MESSAGE_GROUP_GAP_MS
    if (!joins) {
      close()
      group = { key: `group:${item.key}`, mine: mineOf(item), bubbles: [] }
    }
    group!.bubbles.push(item)
  }
  close()
  return rows
}
