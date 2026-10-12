<script lang="ts">
  import { Settings } from 'lucide-svelte'
  import IconButton from './components/IconButton.svelte'
  import StatusDot, { type StatusTone } from './components/StatusDot.svelte'

  interface Props {
    readonly status: string
    readonly systemStatusTone: StatusTone
    readonly appVersion: string
    readonly openStatusModal: () => void
    readonly openSettings: () => void
  }

  let {
    status,
    systemStatusTone,
    appVersion,
    openStatusModal,
    openSettings,
  }: Props = $props()
</script>

<footer class="system-footer">
  <button class="status-dot-button" type="button" aria-label="Show Leitbild status" title={status} onclick={openStatusModal}>
    <StatusDot tone={systemStatusTone} label={status} />
  </button>
  <span class="brand">Leitbild.ai</span>
  <span class="version">v{appVersion}</span>
  <IconButton
    label="Open settings"
    title="Open settings"
    icon={Settings}
    variant="bare"
    onClick={openSettings}
  />
</footer>
