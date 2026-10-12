<script lang="ts">
  import { Eye, EyeOff, House, Moon, RotateCcw, Sun } from 'lucide-svelte'
  import type { ThemeMode } from './theme.ts'
  import IconButton from './components/IconButton.svelte'
  import InlineConfirmation from './components/InlineConfirmation.svelte'
  import ModalShell from './components/ModalShell.svelte'

  interface Props {
    readonly theme: ThemeMode
    readonly weatherLayerAvailable: boolean
    readonly weatherLayerVisible: boolean
    readonly close: () => void
    readonly goToStartPage: () => void
    readonly toggleTheme: () => void
    readonly toggleWeatherLayer: () => void
    /** Null where this screen may not reset: a role Run screen without a controller role. */
    readonly resetScenario: (() => Promise<void>) | null
  }

  let {
    theme,
    weatherLayerAvailable,
    weatherLayerVisible,
    close,
    goToStartPage,
    toggleTheme,
    toggleWeatherLayer,
    resetScenario,
  }: Props = $props()

  // Resetting replaces the Run's current state, so it asks first. While it
  // asks, Esc cancels the question instead of closing Settings.
  let resetRequested = $state(false)
  let resetToggle = $state<HTMLElement | null>(null)

  const confirmReset = (): void => {
    resetRequested = false
    if (resetScenario) void resetScenario()
  }
</script>

<ModalShell title="Settings" {close} closeOnEscape={!resetRequested} size="small">
  <div class="settings-stack">
    <section class="settings-row">
      <div>
        <strong>Theme</strong>
        <span>Switch map and interface theme.</span>
      </div>
      <IconButton
        label="Toggle light and dark mode"
        title="Toggle light and dark mode"
        icon={theme === 'dark' ? Sun : Moon}
        pressed={theme === 'dark'}
        variant="ghost"
        onClick={toggleTheme}
      />
    </section>

    <section class="settings-row">
      <div>
        <strong>Start page</strong>
        <span>Return to the Workspace catalog.</span>
      </div>
      <IconButton
        label="Go to start page"
        title="Go to start page"
        icon={House}
        variant="ghost"
        onClick={goToStartPage}
      />
    </section>

    {#if weatherLayerAvailable}
      <section class="settings-row">
        <div>
          <strong>Weather overlay</strong>
          <span>Show or hide the weather field layer on the map.</span>
        </div>
        <IconButton
          label={weatherLayerVisible ? 'Hide weather overlay' : 'Show weather overlay'}
          title={weatherLayerVisible ? 'Hide weather overlay' : 'Show weather overlay'}
          icon={weatherLayerVisible ? Eye : EyeOff}
          pressed={weatherLayerVisible}
          variant="ghost"
          onClick={toggleWeatherLayer}
        />
      </section>
    {/if}

    {#if resetScenario}
    <section class="settings-row">
      <div>
        <strong>Reset</strong>
        <span>Recreate the current scenario from its definition.</span>
      </div>
      <span class="reset-toggle" bind:this={resetToggle}>
        <IconButton
          label="Reset scenario"
          title="Reset scenario"
          icon={RotateCcw}
          variant="ghost"
          onClick={() => { resetRequested = !resetRequested }}
        />
      </span>
    </section>
    {#if resetRequested}
      <InlineConfirmation
        question="Reset this Run to its scenario's start?"
        confirmLabel="Reset"
        opener={resetToggle}
        confirm={confirmReset}
        cancel={() => { resetRequested = false }}
      />
    {/if}
    {/if}
  </div>
</ModalShell>

<style>
  .reset-toggle {
    display: inline-flex;
  }
</style>
