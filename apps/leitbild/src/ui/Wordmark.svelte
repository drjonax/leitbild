<script lang="ts">
  // The one "Leitbild.ai" mark (plan v2 §13). Read as "Leitbild.ai": the suffix is
  // a plain span, so no aria trickery is needed. ".ai" differs only in colour.
  let {
    tone = 'light',
    size = 'bar',
    mark = false,
    compact = false,
    href,
    label,
  }: {
    /** 'dark' on the top bars, 'light' on light surfaces. */
    tone?: 'dark' | 'light'
    /** bar: top bars (17 px) · hero: landing H1 (display size) · inline: inherits the surrounding size. */
    size?: 'bar' | 'hero' | 'inline'
    /** The small "L" brand mark before the word (hidden below 701 px on bars). */
    mark?: boolean
    /** Below 560 px only the "L" mark shows; the word stays as the accessible text. For a crowded bar. */
    compact?: boolean
    /** Renders a link, e.g. "/workspaces". */
    href?: string
    /** Accessible name for the link when it should say more, e.g. "Leitbild.ai home". */
    label?: string
  } = $props()
</script>

{#snippet content()}
  {#if mark || compact}<svg class="brand-mark" class:compact-only={!mark} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
    ><rect x="1" y="1" width="22" height="22" rx="6" fill="#2b4a35" /><path d="M7 6.5v11h10" fill="none" stroke="#ecf4e9"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /><circle cx="16.5" cy="7.5" r="2.2" fill="#8fd3c7" /></svg
  >{/if}<span class="word">Leitbild<span class="brand-suffix">.ai</span></span>
{/snippet}

{#if href}
  <a class="wordmark {tone} {size}" class:compact {href} aria-label={label}>{@render content()}</a>
{:else}
  <span class="wordmark {tone} {size}" class:compact>{@render content()}</span>
{/if}

<style>
  .wordmark { display: inline-flex; align-items: center; gap: .55rem; color: inherit; text-decoration: none; border-radius: 6px; }
  .word { font-weight: 750; letter-spacing: -.025em; white-space: nowrap; }
  .brand-suffix { color: var(--lb-accent); }
  .dark .brand-suffix { color: #8fd3c7; }
  .bar { font-size: 1.0625rem; }
  .hero { font-size: var(--lb-fs-display); line-height: 1; }
  .hero .word { letter-spacing: -.04em; }
  .inline { font-size: inherit; }
  .brand-mark { width: 22px; height: 22px; flex: none; }
  .hero .brand-mark { width: .8em; height: .8em; }
  a.wordmark:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 3px; }
  a.dark:focus-visible { outline-color: var(--lb-focus-on-dark); }
  .compact-only { display: none; }
  @media (max-width: 700px) { .bar .brand-mark { display: none; } }
  @media (max-width: 559px) {
    .compact .brand-mark { display: block; }
    .compact .word { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  }
</style>
