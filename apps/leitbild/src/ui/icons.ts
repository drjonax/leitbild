// Line icons for the Host pages (24×24, stroke currentColor), from the UX prototype.
// Rendered by Icon.svelte; decorative unless the caller labels the control.

export const icons = {
  down: '<path d="m6 9 6 6 6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  demos: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="m10 8.5 4.5 2.5-4.5 2.5zM8 21h8"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  list: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  dots: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  edit: '<path d="M4 20h4l10-10-4-4L4 16zM14 6l4 4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  tablet: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18h2"/>',
  ai: '<path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5zM18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z" fill="currentColor" stroke="none"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0M16 4.5a3.2 3.2 0 0 1 0 6.2M18 14a6 6 0 0 1 3 6"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7z"/>',
} as const satisfies Readonly<Record<string, string>>

export type IconName = keyof typeof icons
