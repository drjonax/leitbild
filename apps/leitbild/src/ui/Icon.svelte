<script lang="ts">
  import { icons, type IconName } from './icons.ts'

  let { name, size = 18, class: className = '' }: { name: IconName; size?: number; class?: string } = $props()
</script>

<svg class="lb-icon {className}" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"
>{@html icons[name]}</svg>

<style>
  .lb-icon { flex: none; }
</style>
