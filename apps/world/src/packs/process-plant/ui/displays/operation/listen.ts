// A custom element's own events, listened to on the element itself. Svelte
// delegates some events (change, input, click and others) to the document
// root, which an event that does not bubble never reaches: OpenBridge's
// slider and text field fire `change` without bubbling, so an `onchange` on
// them is never called.
export const listen = (node: HTMLElement, handlers: Readonly<Record<string, (event: Event) => void>>) => {
  let current = handlers
  const names = new Set(Object.keys(handlers))
  const listener = (event: Event): void => current[event.type]?.(event)
  for (const name of names) node.addEventListener(name, listener)
  return {
    update: (next: Readonly<Record<string, (event: Event) => void>>) => {
      current = next
      for (const name of Object.keys(next)) {
        if (names.has(name)) continue
        names.add(name)
        node.addEventListener(name, listener)
      }
    },
    destroy: () => { for (const name of names) node.removeEventListener(name, listener) },
  }
}
