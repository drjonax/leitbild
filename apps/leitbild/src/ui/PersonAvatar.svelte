<script lang="ts">
  // A person's initials in one of six tones keyed on their id (UX SPEC §2), so
  // a rename keeps the colour. Decorative: the name is always given in text.
  import { avatarTone, initials } from './people-format.ts'

  let { person, size, dot = null }: {
    person: { readonly id: string; readonly name: string }
    size: 20 | 24 | 28 | 40
    /** Present (filled) or not in this Run (hollow ring). */
    dot?: 'here' | 'away' | null
  } = $props()
</script>

<span class="avatar s{size} t{avatarTone(person.id)}" aria-hidden="true">{initials(person.name)}{#if dot}<i class="dot" class:away={dot === 'away'}></i>{/if}</span>

<style>
  .avatar { position: relative; flex: none; display: inline-grid; place-items: center; border-radius: 50%; font-weight: 750; line-height: 1; letter-spacing: -.02em; }
  .s20 { width: 20px; height: 20px; font-size: .55rem; }
  .s24 { width: 24px; height: 24px; font-size: .62rem; }
  .s28 { width: 28px; height: 28px; font-size: .7rem; }
  .s40 { width: 40px; height: 40px; font-size: .9rem; }
  /* Six tone pairs, all ≥ 4.99:1. */
  .t0 { color: #355440; background: #e2ebdf; }
  .t1 { color: #1c6f68; background: #dcefeb; }
  .t2 { color: #1f4f9c; background: #dfe8f7; }
  .t3 { color: #6d3e6e; background: #efe3ef; }
  .t4 { color: #6e5523; background: #f1e9d8; }
  .t5 { color: #3f4c5c; background: #e3e7ec; }
  .dot { position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px; border-radius: 50%; background: var(--lb-ok); box-shadow: 0 0 0 2px var(--lb-surface); }
  .dot.away { background: var(--lb-surface); border: 1.5px solid var(--lb-control); }
  @media (forced-colors: active) { .dot { border: 1px solid CanvasText; } }
</style>
