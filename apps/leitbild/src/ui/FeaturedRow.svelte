<script lang="ts">
  // The featured demos this Workspace holds (plan v2 §6.4, rule 15): a row of
  // cards from 700 px, the shared carousel on phones. The cards come from the
  // Modules' featured list matched to this Workspace's own Definitions; the
  // Host adds no demo of its own. Start goes through the page's start runner.
  import Carousel from './Carousel.svelte'
  import Icon from './Icon.svelte'
  import StartProgress from './StartProgress.svelte'
  import type { StartState } from './definition-start.ts'
  import { FEATURED_UNAVAILABLE_TEXT, previewSrc, previewSrcset, type FeaturedCard } from './workspace-page.ts'

  let { cards, unavailable, start, keyOf, onstart, onretry, ondismiss, oncancel, onreload }: {
    cards: ReadonlyArray<FeaturedCard>
    /** A Module's featured list failed: say so once. */
    unavailable: boolean
    start: StartState
    keyOf: (card: FeaturedCard) => string
    onstart: (card: FeaturedCard) => void
    onretry: () => void
    ondismiss: () => void
    oncancel: () => void
    onreload: () => void
  } = $props()

  const PHONE = '(max-width: 699px)'
  let phone = $state(typeof matchMedia === 'function' && matchMedia(PHONE).matches)
  $effect(() => {
    const query = matchMedia(PHONE)
    const update = (): void => { phone = query.matches }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  })
  let carousel = $state<{ stop(): void } | null>(null)
  const busy = $derived(start.phase === 'busy')
  const begin = (card: FeaturedCard): void => {
    if (busy) return
    carousel?.stop()
    onstart(card)
  }
</script>

{#snippet demoCard(card: FeaturedCard, index: number)}
  {@const preview = card.featured.previews[0]!}
  {@const progress = start.phase !== 'idle' && start.key === keyOf(card) ? start : null}
  <article class="demo-card" aria-labelledby={`demo-title-${index}`}>
    <div class="media">
      <img src={previewSrc(preview)} srcset={previewSrcset(preview)} sizes="(max-width: 699px) 92vw, (max-width: 1100px) 31vw, 400px"
        alt={preview.alt} width={preview.width} height={preview.height} loading="lazy" decoding="async" />
    </div>
    <div class="text">
      <span class="eyebrow">{card.featured.tags[0]}</span>
      <h3 id={`demo-title-${index}`}>{card.featured.title}</h3>
      {#if progress}
        <StartProgress {progress} title={card.featured.title} {onretry} {ondismiss} {oncancel} {onreload} />
      {:else}
        <p class="summary">{card.featured.summary}</p>
        <div class="foot">
          <button class="lb-btn lb-btn-primary" type="button" aria-disabled={busy ? 'true' : undefined} aria-describedby={`demo-title-${index}`}
            onclick={() => begin(card)}><Icon name="play" size={16} />Start demo</button>
          {#if card.edited}<span class="note">Starts the original demo</span>{/if}
        </div>
      {/if}
    </div>
  </article>
{/snippet}

{#snippet credit()}
  <p class="credit">Map and grid data © OpenStreetMap contributors (ODbL) and others · <a href="/wiki?path=data-credits.md">Credits</a></p>
{/snippet}

{#if cards.length > 0 || unavailable}
  <section class="demos" aria-labelledby="demos-heading">
    <div class="section-head"><h2 id="demos-heading">Demos</h2>{#if cards.length > 0}<span class="count">{cards.length} featured</span>{/if}</div>
    {#if unavailable}<p class="unavailable">{FEATURED_UNAVAILABLE_TEXT}</p>{/if}
    {#if cards.length > 0}
      {#if phone}
        {#key cards.length}
          <Carousel bind:this={carousel} items={cards} label="Featured demos" itemTitle={card => card.featured.title} slide={demoCard}
            nav="dots" variant="panel" noun="demo" observeVisibility {credit} />
        {/key}
      {:else}
        <div class="row">{#each cards as card, index (keyOf(card))}{@render demoCard(card, index)}{/each}</div>
        {@render credit()}
      {/if}
    {/if}
  </section>
{/if}

<style>
  .section-head { display: flex; align-items: baseline; gap: var(--lb-s3); margin-bottom: var(--lb-s3); }
  h2 { margin: 0; font-size: var(--lb-fs-h3); font-weight: 700; }
  .count { color: var(--lb-ink-3); font-size: var(--lb-fs-small); }
  .row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--lb-s4); }
  .demo-card { min-width: 0; display: grid; grid-template-rows: auto 1fr; overflow: hidden; border: 1px solid var(--lb-line);
    border-radius: var(--lb-r-lg); background: var(--lb-surface); }
  .media { padding: 10px 10px 0; background: var(--lb-surface-2); }
  .media img { display: block; width: 100%; height: auto; aspect-ratio: 16 / 10; object-fit: cover; object-position: top left;
    border: 1px solid var(--lb-line); border-bottom: 0; border-radius: var(--lb-r-sm) var(--lb-r-sm) 0 0; background: var(--lb-surface-2); }
  .text { display: flex; flex-direction: column; gap: 6px; padding: 14px 16px 16px; min-width: 0; }
  .eyebrow { color: var(--lb-accent); font-size: var(--lb-fs-eyebrow); font-weight: 750; line-height: 1.2; letter-spacing: .12em; text-transform: uppercase; }
  h3 { margin: 0; color: var(--lb-ink); font-size: 1.0625rem; line-height: 1.3; font-weight: 700; letter-spacing: -.01em; }
  .summary { margin: 0 0 4px; color: var(--lb-ink-2); font-size: .875rem; line-height: 1.5; }
  .foot { margin-top: auto; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; }
  .note { color: var(--lb-ink-3); font-size: var(--lb-fs-micro); }
  .credit { margin: var(--lb-s2) 0 0; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); line-height: 1.5; }
  .credit a { color: inherit; }
  .unavailable { margin: 0 0 var(--lb-s3); color: var(--lb-ink-2); font-size: var(--lb-fs-small); }
  .demos :global(.lb-carousel) { border: 1px solid var(--lb-line); border-radius: var(--lb-r-lg); background: var(--lb-surface); overflow: hidden; }
  .demos :global(.lb-carousel .demo-card) { border: 0; border-radius: 0; }
  @media (max-width: 899px) { .row { gap: var(--lb-s3); } .text { padding: 12px; } }
</style>
