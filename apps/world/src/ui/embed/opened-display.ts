import { embeddedViewListingSchema, type EmbeddedViewEnvelope, type EmbeddedViewListing } from '@leitbild/contracts'

// A display opened after another (the equipment a critical safety function
// chip or a first-out banner label names, opened from an answer's display):
// a self-contained listing on the same Run, so the Workspace's one display
// window shows it as it shows any display, with a caption saying where it
// came from. Its key is stable for the same display opened from the same one.

const CAPTION_MAX = 120

/** FNV-1a over the text, as 8 hex digits: short, stable keys for long states. */
export const digest = (text: string): string => {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export const openedListing = (
  from: { readonly key: string; readonly title: string; readonly envelope: EmbeddedViewEnvelope },
  opened: { readonly state: string; readonly title: string },
): EmbeddedViewListing => {
  const caption = `From ${from.title}`
  return embeddedViewListingSchema.parse({
    key: `opened:${digest(`${from.key}\n${opened.state}`)}`,
    caption: caption.length <= CAPTION_MAX ? caption : 'From another display',
    envelope: { ...from.envelope, title: opened.title, state: opened.state },
  })
}
