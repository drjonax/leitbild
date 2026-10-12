import { describe, expect, test } from 'bun:test'
import {
  completeStartupStep,
  createStartupSteps,
  failStartupStep,
  resetStartupStepsAfter,
  setStartupStepDetails,
  startupHasFailed,
  startupIsReady,
  startupModalShouldShow,
  startStartupStep,
} from '../src/ui/startup.ts'

describe('startup progress model', () => {
  test('tracks independent step progress without requiring linear completion', () => {
    let steps = createStartupSteps(10)

    steps = completeStartupStep(steps, 'map', 20)
    steps = completeStartupStep(steps, 'route', 30)

    expect(steps.find(step => step.id === 'map')?.status).toBe('done')
    expect(steps.find(step => step.id === 'simulation-run')?.status).toBe('pending')
    expect(steps.find(step => step.id === 'route')?.completedAtMs).toBe(30)
  })

  test('preserves earlier work when retrying from a later startup step', () => {
    let steps = createStartupSteps(10)
    steps = completeStartupStep(steps, 'route', 20)
    steps = completeStartupStep(steps, 'interface', 30)
    steps = startStartupStep(steps, 'simulation-run', 40)
    steps = failStartupStep(steps, 'simulation-run', 'join failed', 50)

    const reset = resetStartupStepsAfter(steps, 'simulation-run')

    expect(reset.find(step => step.id === 'route')?.status).toBe('done')
    expect(reset.find(step => step.id === 'interface')?.status).toBe('done')
    expect(reset.find(step => step.id === 'simulation-run')?.status).toBe('pending')
    expect(reset.find(step => step.id === 'simulation-run')?.error).toBeUndefined()
  })

  test('reports readiness and failure explicitly', () => {
    let steps = createStartupSteps(10)
    for (const step of steps) steps = completeStartupStep(steps, step.id, 20)

    expect(startupIsReady(steps)).toBe(true)
    expect(startupHasFailed(steps)).toBe(false)

    const failed = failStartupStep(steps, 'realtime', 'socket failed', 30)

    expect(startupIsReady(failed)).toBe(false)
    expect(startupHasFailed(failed)).toBe(true)
  })

  test('does not create a new startup step array when diagnostic details are unchanged', () => {
    let steps = createStartupSteps(10)
    const details = [{ label: 'base', value: 'ready' }]
    steps = setStartupStepDetails(steps, 'map', details)

    const unchanged = setStartupStepDetails(steps, 'map', details)

    expect(unchanged).toBe(steps)
  })

  test('does not report readiness after a map failure', () => {
    let steps = createStartupSteps(10)
    for (const step of steps.filter(step => step.id !== 'map')) {
      steps = completeStartupStep(steps, step.id, 20)
    }

    expect(startupIsReady(steps)).toBe(true)

    const mapFailed = failStartupStep(steps, 'map', 'map failed', 30)
    expect(startupIsReady(mapFailed)).toBe(false)
    expect(startupHasFailed(mapFailed)).toBe(true)

    const realtimeFailed = failStartupStep(steps, 'realtime', 'socket failed', 30)
    expect(startupIsReady(realtimeFailed)).toBe(false)
  })

  test('shows the startup checklist while steps run or one failed, never once every step succeeded', () => {
    let steps = createStartupSteps(10)
    steps = completeStartupStep(steps, 'route', 20)
    expect(startupModalShouldShow({ routeMode: 'simulation-run', dismissed: false, steps })).toBe(true)
    expect(startupModalShouldShow({ routeMode: 'simulation-run', dismissed: true, steps })).toBe(false)

    expect(startupModalShouldShow({ routeMode: 'simulation-run', dismissed: false, steps: failStartupStep(steps, 'map', 'map failed', 30) })).toBe(true)

    for (const step of steps) steps = completeStartupStep(steps, step.id, 20)
    expect(startupModalShouldShow({ routeMode: 'simulation-run', dismissed: false, steps })).toBe(false)
  })

  test('does not show startup modal on the picker route', () => {
    const steps = createStartupSteps(10)

    expect(startupModalShouldShow({
      routeMode: 'picker',
      dismissed: false,
      steps,
    })).toBe(false)
  })
})
