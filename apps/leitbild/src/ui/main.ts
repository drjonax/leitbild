import { mount } from 'svelte'
import Landing from './Landing.svelte'
import './styles.css'

const target = document.querySelector('#app')
if (!(target instanceof HTMLElement)) throw new Error('Workspace Host UI root is missing')

// The landing page is the first thing a newcomer loads, so it ships in the
// entry chunk; the Workspace shell and the wiki load on their own routes.
if (location.pathname === '/workspaces') mount(Landing, { target })
else if (location.pathname === '/wiki') {
  const { default: Wiki } = await import('./Wiki.svelte')
  mount(Wiki, { target })
}
else {
  const { default: App } = await import('./App.svelte')
  mount(App, { target })
}
