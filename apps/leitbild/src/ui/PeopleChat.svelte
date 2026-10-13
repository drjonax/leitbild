<script lang="ts" module>
  /** Drafts per person, for this page: kept when the chat closes, the Run changes or the Run view is left. */
  const drafts = new Map<string, string>()
  /** The last open request that moved focus into a composer, so a re-mounted chat does not take focus again. */
  let focusedRequest = -1
</script>

<script lang="ts">
  // One floating chat window (UX SPEC §6–§7), anchored to the bottom-right of
  // the World pane and not closed by clicks elsewhere, so the simulation stays
  // usable beside it. Text only: names and messages are never markup.
  import { onMount, tick, untrack } from 'svelte'
  import Icon from './Icon.svelte'
  import PersonAvatar from './PersonAvatar.svelte'
  import { composingKeystroke } from './ime.ts'
  import {
    chatRows, fullTimeLabel, isolate, messageCounterText, messageSendable, newMessagesPill, OUTBOX_UNSAVED_TEXT, timeLabel, type ChatItem,
  } from './people-format.ts'
  import type { ChatView, ConnectionNotice, PeopleSession } from './people-session.ts'

  /** Within this distance of the bottom the log follows new messages. */
  const STICK_TO_BOTTOM_PX = 48
  const CHAT_WIDTH_PX = 340
  const CHAT_MAX_HEIGHT_PX = 460
  /** Keeps MapLibre's bottom-right zoom, compass and ⓘ column clickable. */
  const MAP_CONTROLS_INSET_PX = 56
  const EDGE_PX = 16
  /** The Run bar's height (styles.css `.workspace-bar`), the top of the panes. */
  const BAR_HEIGHT_PX = 42
  /** The narrowest World pane that holds the window at its bottom-right, clear of the map controls. */
  const WORLD_PANE_FITS_PX = CHAT_WIDTH_PX + MAP_CONTROLS_INSET_PX + EDGE_PX
  /**
   * Kept free at the bottom when the window docks over the Agents pane: its
   * composer is 47 px and grows to about 150 px with a long draft (measured
   * 2026-10-13). Covering part of the Agents message list is accepted.
   */
  const AGENTS_COMPOSER_CLEARANCE_PX = 160
  /**
   * The docked window never gets shorter than this (header, composer and a few
   * messages) while the viewport holds it: on a short screen it covers the
   * Agents composer rather than shrink to a useless strip.
   */
  const DOCKED_MIN_HEIGHT_PX = 240
  /** The composer grows from one line to five. */
  const COMPOSER_MIN_HEIGHT_PX = 38
  const COMPOSER_MAX_HEIGHT_PX = 120
  /** The divider sits a little below the top when the log scrolls to it. */
  const DIVIDER_MARGIN_PX = 8

  let { session, chat, notice, outboxSaved, anchor, focusRequest, onClose }: {
    session: PeopleSession
    chat: ChatView
    notice: ConnectionNotice
    /** false: unsent messages would not survive a reload. */
    outboxSaved: boolean
    /** The World pane; the window docks top-left when the pane is too narrow or collapsed. */
    anchor: HTMLElement | null
    /** Increments when a row or the toast opens a chat: focus goes to the composer. */
    focusRequest: number
    /** Closes the window and returns focus to the header control. */
    onClose: () => void
  } = $props()

  const uid = `chat-${Math.random().toString(36).slice(2, 8)}`
  let log = $state<HTMLElement | null>(null)
  let textarea = $state<HTMLTextAreaElement | null>(null)

  const name = $derived(chat.with.name)
  const rows = $derived(chatRows(chat.items, chat.firstUnreadKey, Date.now()))
  const status = $derived(notice !== 'none'
    ? { text: 'Reconnecting…', dot: 'wait' }
    : !chat.hereKnown ? null
    : chat.with.here ? { text: 'In this simulation', dot: 'here' } : { text: 'Not in this simulation', dot: 'away' })
  const composerNote = $derived<'reconnecting' | 'away' | null>(notice !== 'none' ? 'reconnecting'
    : chat.hereKnown && !chat.with.here ? 'away' : null)

  // --- placement --------------------------------------------------------------------
  const narrowQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 759px)') : null
  let narrow = $state(narrowQuery?.matches ?? false)
  let place = $state('')
  const updatePlace = (): void => {
    // Below 760 px the stylesheet makes it a bottom sheet.
    if (narrow) { place = ''; return }
    const rect = anchor?.getBoundingClientRect()
    if (rect !== undefined && rect.width >= WORLD_PANE_FITS_PX && rect.height > 0) {
      // Bottom-right of the World pane, left of the map controls.
      const height = Math.max(0, Math.min(CHAT_MAX_HEIGHT_PX, rect.height - 2 * EDGE_PX))
      place = `left:${Math.round(rect.right - MAP_CONTROLS_INSET_PX - CHAT_WIDTH_PX)}px;top:${Math.round(rect.bottom - EDGE_PX - height)}px;height:${Math.round(height)}px`
      return
    }
    // A narrow or collapsed World pane: dock top-left, above the Agents composer where there is room.
    const paneTop = rect !== undefined && rect.height > 0 ? rect.top : BAR_HEIGHT_PX
    const room = innerHeight - paneTop - 2 * EDGE_PX
    const height = Math.max(0, Math.min(CHAT_MAX_HEIGHT_PX, room, Math.max(DOCKED_MIN_HEIGHT_PX, room - AGENTS_COMPOSER_CLEARANCE_PX)))
    place = `left:${EDGE_PX}px;top:${Math.round(paneTop + EDGE_PX)}px;height:${Math.round(height)}px`
  }
  $effect(() => {
    const target = anchor
    void narrow
    untrack(updatePlace)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => updatePlace()) : null
    if (target !== null) observer?.observe(target)
    const onNarrow = (): void => { narrow = narrowQuery?.matches ?? false }
    window.addEventListener('resize', updatePlace)
    narrowQuery?.addEventListener('change', onNarrow)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updatePlace)
      narrowQuery?.removeEventListener('change', onNarrow)
    }
  })

  // --- log scrolling ------------------------------------------------------------------
  let pill = $state(0)
  let stick = true
  let sentJustNow = false
  let seen = new Set<string>()
  let settledPeer: string | null = null
  const atBottom = (): boolean => log === null || log.scrollHeight - log.scrollTop - log.clientHeight < STICK_TO_BOTTOM_PX
  const toBottom = (): void => { if (log !== null) log.scrollTop = log.scrollHeight }
  /**
   * Messages are read only while the newest one is on screen (no "↓ new messages" pill).
   * The session treats the chat as not at its newest until the first report, made
   * after the opening scroll to the "New" divider or the bottom.
   */
  const reportPosition = (): void => session.setChatAtBottom(pill === 0 && atBottom())

  $effect.pre(() => {
    void chat.items
    untrack(() => { stick = atBottom() })
  })
  $effect(() => {
    const items = chat.items
    const peer = chat.with.id
    const loading = chat.loading
    untrack(() => {
      if (log === null) return
      if (settledPeer !== peer) {
        if (loading) return
        // On open: to the "New" divider when the unread do not fit, else to the bottom.
        settledPeer = peer
        seen = new Set(items.map(item => item.key))
        pill = 0
        const divider = log.querySelector<HTMLElement>('.new-divider')
        if (divider !== null && log.scrollHeight - divider.offsetTop > log.clientHeight) log.scrollTop = divider.offsetTop - DIVIDER_MARGIN_PX
        else toBottom()
        reportPosition()
        return
      }
      const fresh = items.filter(item => !seen.has(item.key))
      for (const item of fresh) seen.add(item.key)
      if (sentJustNow) {
        sentJustNow = false
        pill = 0
        toBottom()
      } else if (stick) toBottom()
      else pill += fresh.filter(item => item.kind === 'message' && !item.mine).length
      reportPosition()
    })
  })
  const onScroll = (): void => {
    if (pill > 0 && atBottom()) pill = 0
    reportPosition()
  }
  const jumpToBottom = (): void => {
    pill = 0
    toBottom()
    reportPosition()
    textarea?.focus()
  }

  // --- composer -----------------------------------------------------------------------
  let draft = $state(untrack(() => drafts.get(chat.with.id) ?? ''))
  let draftPeer = untrack(() => chat.with.id)
  const sendable = $derived(messageSendable(draft))
  const counter = $derived(messageCounterText(draft))

  const autosize = (): void => {
    if (textarea === null) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(COMPOSER_MAX_HEIGHT_PX, Math.max(COMPOSER_MIN_HEIGHT_PX, textarea.scrollHeight + 2))}px`
  }

  // Another person: keep this draft, show theirs.
  $effect(() => {
    const peer = chat.with.id
    untrack(() => {
      if (peer === draftPeer) return
      drafts.set(draftPeer, draft)
      draftPeer = peer
      draft = drafts.get(peer) ?? ''
      settledPeer = null
      void tick().then(autosize)
    })
  })

  $effect(() => {
    const request = focusRequest
    untrack(() => {
      if (request === focusedRequest) return
      focusedRequest = request
      void tick().then(() => { textarea?.focus(); autosize() })
    })
  })

  onMount(() => {
    // A draft kept from before may span several lines.
    void tick().then(autosize)
    // Gone from the screen, nothing in it is being read until a chat on screen reports again.
    return () => session.setChatAtBottom(false)
  })

  const onInput = (): void => {
    drafts.set(chat.with.id, textarea?.value ?? draft)
    autosize()
  }

  const send = (): void => {
    if (!sendable || !session.send(draft)) return
    draft = ''
    drafts.set(chat.with.id, '')
    sentJustNow = true
    void tick().then(autosize)
  }

  const onComposerKeydown = (event: KeyboardEvent): void => {
    // Keystrokes that finish an IME composition never send.
    if (event.key !== 'Enter' || event.shiftKey || composingKeystroke(event)) return
    event.preventDefault()
    send()
  }

  const onWindowKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || composingKeystroke(event)) return
    event.preventDefault()
    onClose()
  }

  const remove = (key: string): void => {
    session.removeSend(key)
    textarea?.focus()
  }

  // The Retry button goes away with the failure, so focus moves to the composer.
  const retry = (key: string): void => {
    session.retrySend(key)
    textarea?.focus()
  }
</script>

<!-- Under a message still on its way. "Not sent" and a rate-limit wait are read out; "Sending…" is not, as it comes and goes. -->
{#snippet outgoingMeta(bubble: Extract<ChatItem, { kind: 'outgoing' }>)}
  {#if bubble.stage === 'failed'}
    <span class="failrow"><span>Not sent: {bubble.reason}</span>
      <button type="button" onclick={() => retry(bubble.key)}>Retry</button>
      <button type="button" class="quiet" onclick={() => remove(bubble.key)}>Remove</button>
    </span>
  {:else if bubble.note !== null}<span class="meta">{bubble.note}</span>
  {:else if bubble.stage === 'sending'}<span class="meta" aria-hidden="true">Sending…</span>
  {/if}
{/snippet}

{#snippet awayNote()}Not in this simulation — <bdi>{name}</bdi> will see it next time.{/snippet}

<div class="chat" role="dialog" tabindex="-1" aria-modal="false" aria-label={`Chat with ${name}`} style={place} onkeydown={onWindowKeydown}>
  <header class="chat-head">
    <PersonAvatar person={chat.with} size={24} />
    <div class="chat-title">
      <h2 dir="auto">{name}</h2>
      <span class="chat-status">{#if status}<i class={status.dot} aria-hidden="true"></i>{status.text}{/if}</span>
    </div>
    <button class="chat-close" type="button" aria-label={`Close chat with ${name}`} title="Close chat" onclick={onClose}><Icon name="close" size={18} /></button>
  </header>

  <div class="log-wrap">
    <div bind:this={log} class="log" role="log" aria-live="polite" aria-label={`Messages with ${name}`} aria-busy={chat.loading ? 'true' : 'false'} onscroll={onScroll}>
      {#if chat.capped}<p class="cap">Only the last 200 messages are kept.</p>{/if}
      {#if chat.loadFailed && chat.items.length === 0}
        <div class="chat-empty"><span>Couldn’t load the messages.</span><button class="lb-btn lb-btn-sm" type="button" onclick={() => session.retryChatLoad()}>Try again</button></div>
      {:else if chat.loading && chat.items.length === 0}
        <p class="chat-empty">Loading messages…</p>
      {:else if chat.items.length === 0}
        <div class="chat-empty">
          <PersonAvatar person={chat.with} size={40} />
          <strong>No messages yet</strong>
          <span>{#if composerNote === 'away'}{@render awayNote()}{:else}Say hello to <bdi>{name}</bdi>.{/if}</span>
        </div>
      {:else}
        <!-- Read out per bubble as "Ben: …" or "You: …"; separators and times are for the eye only. -->
        {#each rows as row (row.key)}
          {#if row.kind === 'day'}<p class="day" aria-hidden="true">{row.label}</p>
          {:else if row.kind === 'new'}<p class="new-divider" aria-hidden="true">New</p>
          {:else if row.kind === 'note'}<p class="sys"><bdi>{row.oldName}</bdi> is now called <bdi>{row.newName}</bdi></p>
          {:else}
            {@const last = row.bubbles[row.bubbles.length - 1]!}
            <div class="group" class:mine={row.mine} class:theirs={!row.mine}>
              {#each row.bubbles as bubble, index (bubble.key)}
                <div class="bubble" class:last={index === row.bubbles.length - 1}
                  class:pending={bubble.kind === 'outgoing' && bubble.stage === 'sending'}
                  class:failed={bubble.kind === 'outgoing' && bubble.stage === 'failed'}
                  title={fullTimeLabel(bubble.at)}><span class="visually-hidden">{`${row.mine ? 'You' : name}: `}</span><span class="bubble-text" dir="auto">{bubble.text}</span></div>
                {#if bubble.kind === 'outgoing'}{@render outgoingMeta(bubble)}{/if}
              {/each}
              {#if last.kind === 'message'}<span class="meta" aria-hidden="true">{timeLabel(last.at)}</span>{/if}
            </div>
          {/if}
        {/each}
      {/if}
    </div>
    {#if pill > 0}<button class="new-pill" type="button" onclick={jumpToBottom}>{newMessagesPill(pill)}</button>{/if}
  </div>

  <form class="composer" onsubmit={event => { event.preventDefault(); send() }}>
    {#if !outboxSaved && chat.items.some(item => item.kind === 'outgoing')}<p class="note"><span>{OUTBOX_UNSAVED_TEXT}</span></p>{/if}
    {#if composerNote === 'reconnecting'}<p class="note"><i class="wait" aria-hidden="true"></i><span>Reconnecting… Messages will send when the connection is back.</span></p>
    {:else if composerNote === 'away'}<p class="note"><i class="away" aria-hidden="true"></i><span>{@render awayNote()}</span></p>{/if}
    <div class="compose-row">
      <label class="visually-hidden" for={`${uid}-text`}>Message {name}</label>
      <textarea bind:this={textarea} id={`${uid}-text`} rows="1" enterkeyhint="send" dir="auto" placeholder={`Message ${isolate(name)}`}
        aria-describedby={`${uid}-hint${counter ? ` ${uid}-counter` : ''}`}
        bind:value={draft} oninput={onInput} onkeydown={onComposerKeydown}></textarea>
      <button class="send" type="submit" aria-label="Send message" aria-disabled={sendable ? 'false' : 'true'}><Icon name="send" size={18} /></button>
    </div>
    <span class="visually-hidden" id={`${uid}-hint`}>Enter to send, Shift+Enter for a new line.</span>
    {#if counter}<p class="counter" class:over={counter.over} id={`${uid}-counter`}>{counter.text}</p>{/if}
  </form>
</div>

<style>
  .chat:focus { outline: none; }
  .chat { position: fixed; z-index: 25; width: 340px; display: flex; flex-direction: column; border: 1px solid var(--lb-line); border-radius: var(--lb-r-lg);
    color: var(--lb-ink); background: var(--lb-surface); box-shadow: var(--lb-shadow-lg); overflow: hidden; font-size: .875rem; }
  .chat-head { flex: none; height: 44px; padding: 0 6px 0 12px; display: flex; align-items: center; gap: 10px; color: var(--lb-on-dark); background: var(--lb-brand-800); }
  .chat-title { min-width: 0; flex: 1; display: grid; }
  .chat-title h2 { margin: 0; overflow: hidden; font-size: .875rem; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; unicode-bidi: plaintext; }
  .chat-status { min-height: 1em; display: flex; align-items: center; gap: 5px; color: var(--lb-on-dark-2); font-size: .6875rem; }
  .chat-status i { width: 7px; height: 7px; flex: none; border-radius: 50%; }
  .chat-status i.here { background: #6fcf8e; }
  .chat-status i.away { border: 1.5px solid var(--lb-on-dark-2); }
  .chat-status i.wait { border: 1.5px dashed var(--lb-on-dark-2); }
  .chat-close { width: 32px; height: 32px; min-height: 32px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--lb-r-sm);
    color: var(--lb-on-dark-2); background: transparent; cursor: pointer; }
  .chat-close:hover { color: var(--lb-on-dark); background: rgba(255, 255, 255, .08); }
  .chat-close:focus-visible { outline: 2px solid var(--lb-focus-on-dark); outline-offset: -2px; }

  .log-wrap { position: relative; flex: 1; min-height: 0; display: flex; }
  .log { position: relative; flex: 1; min-height: 0; overflow-y: auto; padding: 12px 12px 4px; display: flex; flex-direction: column; background: var(--lb-surface-2); }
  .day, .new-divider { display: flex; align-items: center; gap: 8px; margin: 4px 0 10px; color: var(--lb-ink-3); font-size: .6875rem; font-weight: 650; }
  .day::before, .day::after, .new-divider::before, .new-divider::after { content: ''; flex: 1; height: 1px; background: var(--lb-line); }
  .new-divider { color: var(--lb-accent); font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
  .new-divider::before, .new-divider::after { background: var(--lb-accent); opacity: .5; }
  .cap, .sys { align-self: center; margin: 0 0 10px; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); text-align: center; overflow-wrap: anywhere; unicode-bidi: plaintext; }
  .group { display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; }
  .group.mine { align-items: flex-end; }
  .group.theirs { align-items: flex-start; }
  .bubble { max-width: 82%; padding: 7px 10px; border-radius: 14px; line-height: 1.4; }
  .bubble-text { display: block; white-space: pre-wrap; overflow-wrap: anywhere; unicode-bidi: plaintext; }
  .mine .bubble { color: #f5fbf2; background: var(--lb-brand-700); }
  .mine .bubble.last { border-bottom-right-radius: 4px; }
  .theirs .bubble { color: var(--lb-ink); background: var(--lb-surface); border: 1px solid var(--lb-line); }
  .theirs .bubble.last { border-bottom-left-radius: 4px; }
  .bubble.pending { opacity: .7; }
  .mine .bubble.failed { color: var(--lb-ink); background: var(--lb-surface); border: 1px dashed var(--lb-danger); }
  .meta { padding: 1px 4px 0; color: var(--lb-ink-3); font-size: .6875rem; }
  .failrow { padding: 1px 2px 0; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 4px 10px; color: var(--lb-danger); font-size: var(--lb-fs-micro); }
  .failrow button { min-height: 24px; padding: 0 2px; border: 0; border-radius: 4px; color: var(--lb-accent); background: none; font-weight: 650; text-decoration: underline; cursor: pointer; }
  .failrow button.quiet { color: var(--lb-ink-2); }
  .failrow button:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 1px; }
  .chat-empty { margin: auto; display: grid; justify-items: center; gap: 6px; padding: 16px; color: var(--lb-ink-3); font-size: var(--lb-fs-small); text-align: center; }
  .chat-empty strong { color: var(--lb-ink-2); }
  .chat-empty span { overflow-wrap: anywhere; unicode-bidi: plaintext; }
  .new-pill { position: absolute; bottom: 8px; left: 50%; translate: -50% 0; min-height: 28px; height: 28px; padding: 0 12px; display: inline-flex; align-items: center; gap: 4px;
    border: 0; border-radius: var(--lb-r-pill); color: #fff; background: var(--lb-brand-700); box-shadow: 0 4px 14px rgba(10, 18, 12, .25);
    font-size: var(--lb-fs-micro); font-weight: 650; white-space: nowrap; cursor: pointer; }
  .new-pill:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }

  .composer { flex: none; display: grid; gap: 6px; margin: 0; padding: 8px 10px 10px; border-top: 1px solid var(--lb-line); background: var(--lb-surface); }
  .note { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); line-height: 1.35; }
  .note span { min-width: 0; overflow-wrap: anywhere; unicode-bidi: plaintext; }
  .note i { width: 8px; height: 8px; flex: none; border-radius: 50%; border: 1.5px solid var(--lb-control); }
  .note i.wait { border-style: dashed; }
  .compose-row { display: flex; align-items: flex-end; gap: 8px; }
  .compose-row textarea { flex: 1; min-width: 0; height: 38px; min-height: 38px; max-height: 120px; padding: 8px 10px; resize: none; border: 1px solid var(--lb-control);
    border-radius: var(--lb-r-md); color: var(--lb-ink); background: var(--lb-surface); font: inherit; font-size: .875rem; line-height: 1.4; unicode-bidi: plaintext; }
  .compose-row textarea::placeholder { color: #6d786f; }
  .compose-row textarea:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 1px; }
  .send { flex: none; width: 38px; height: 38px; min-height: 38px; display: grid; place-items: center; padding: 0; border: 1px solid var(--lb-brand-700);
    border-radius: var(--lb-r-md); color: #f5fbf2; background: var(--lb-brand-700); cursor: pointer; }
  .send:hover { border-color: var(--lb-brand-900); background: var(--lb-brand-900); }
  .send[aria-disabled="true"] { opacity: .45; cursor: not-allowed; }
  .send:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .counter { margin: 0; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); text-align: right; }
  .counter.over { color: var(--lb-danger); font-weight: 650; }

  /* Narrow: a full-width, non-modal bottom sheet with no scrim, so the simulation stays usable. */
  @media (max-width: 759px) {
    .chat { left: 0; right: 0; bottom: 0; width: auto; height: min(60dvh, 520px); border-bottom: 0; border-radius: 14px 14px 0 0; }
  }
  @media (pointer: coarse) {
    .chat-close, .send { width: 44px; height: 44px; min-height: 44px; }
    .failrow button { min-height: 44px; }
  }
</style>
