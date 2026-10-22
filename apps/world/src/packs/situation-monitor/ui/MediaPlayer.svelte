<script lang="ts">
  import type { ExternalRecord } from '../model.ts'
  const { media, observedAt, title }: { media: ExternalRecord['media'][number]; observedAt?: string | undefined; title: string } = $props()
  let requested = $state(false)
  let video = $state<HTMLVideoElement | null>(null)
  let error = $state('')
  // A refreshed record must not restart an unchanged stream.
  const format = $derived(media.format)
  const mediaUrl = $derived(media.url)
  function youtubeEmbed(url: string): string | null {
    const parsed = new URL(url)
    const id = parsed.hostname === 'youtu.be' ? parsed.pathname.slice(1) : ['www.youtube.com', 'youtube.com'].includes(parsed.hostname) ? parsed.searchParams.get('v') ?? parsed.pathname.match(/^\/(?:embed|live|shorts)\/([^/]+)/)?.[1] : null
    return id && /^[\w-]{11}$/.test(id) ? 'https://www.youtube-nocookie.com/embed/' + id : null
  }
  $effect(() => {
    const element = video
    if (!requested || !element || format !== 'hls') return
    const url = mediaUrl
    let active = true, destroy: (() => void) | undefined
    error = ''
    // Some Chromium builds advertise native HLS but cannot play these streams.
    // Prefer the library's capability check; native playback serves non-MSE browsers.
    void import('hls.js').then(({ default: Hls }) => {
      if (!active) return
      if (!Hls.isSupported()) {
        if (element.canPlayType('application/vnd.apple.mpegurl')) element.src = url
        else error = 'HLS playback is not supported by this browser'
        return
      }
      const player = new Hls({ maxBufferLength: 20, maxMaxBufferLength: 30, backBufferLength: 0 })
      destroy = () => player.destroy()
      player.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) { error = 'Stream could not be played: ' + data.details; player.destroy() } })
      player.loadSource(url); player.attachMedia(element)
    }).catch(cause => { if (active) error = String(cause) })
    return () => { active = false; destroy?.(); element.removeAttribute('src'); element.load() }
  })
</script>
<h4>{media.label ?? media.format}</h4>
{#if observedAt}<small>Provider image/record updated {new Date(observedAt).toLocaleString()}. This is not a guarantee of a live video frame.</small>{/if}
{#if media.available === false}<p role="status">Provider reports this media unavailable.</p>{/if}
{#if !requested}<button onclick={() => { requested = true; error = '' }}>Load {media.format === 'image' ? 'image' : 'media'} from provider</button><p>Contacts the provider directly. Availability, embedding permission and browser CORS rules apply.</p>
{:else if media.format === 'image'}{#key observedAt}<img src={media.url} alt={title} referrerpolicy="no-referrer" onerror={() => error = 'Image could not be loaded from the provider'} />{/key}
{:else if media.format === 'youtube'}
  {@const url = youtubeEmbed(media.url)}
  {#if url}<iframe title="External video" src={url} sandbox="allow-scripts allow-same-origin allow-presentation" allow="fullscreen; encrypted-media" referrerpolicy="strict-origin-when-cross-origin"></iframe>{:else}<p role="alert">Use a YouTube video, live or short URL with a video ID.</p>{/if}
{:else if media.format === 'audio'}<audio controls preload="none" src={media.url} onerror={() => error = 'Audio could not be loaded from the provider'}></audio>
{:else}
  <!-- Provider media has no locally supplied caption track. Native tracks, when supplied by the stream, remain available. -->
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={video} controls playsinline preload="none" src={media.format === 'video' ? media.url : undefined} onerror={() => error = 'Video could not be loaded from the provider'}></video>
{/if}
{#if requested}<button onclick={() => requested = false}>Unload media</button>{/if}
{#if error}<p role="alert">{error}</p>{/if}
<style>video,audio,iframe,img{width:100%;border:0}video,iframe{aspect-ratio:16/9;background:#000}p,small{font-size:12px;color:#94a3b8}[role=alert]{color:#f87171}button{padding:7px;color:inherit;background:transparent;border:1px solid #64748b;border-radius:5px}h4{margin:14px 0 6px}</style>
