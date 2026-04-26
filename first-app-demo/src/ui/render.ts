import { TextContainerUpgrade } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { AppState } from '../state/machine'
import type { SoundClass } from '../audio/classifier'
import { MAIN_CONTAINER_ID, MAIN_CONTAINER_NAME } from './containers'

const BAR_WIDTH = 24

function makeBar(value: number, scale = 1): string {
  const fill = Math.max(0, Math.min(BAR_WIDTH, Math.round(value * BAR_WIDTH * scale)))
  return '#'.repeat(fill) + '-'.repeat(BAR_WIDTH - fill)
}

// Display label for each sound class. 'other' falls back to the generic label
// so we don't lie about a confident classification when we don't have one.
function classLabel(c: SoundClass): string {
  switch (c) {
    case 'voice': return 'VOICE'
    case 'footsteps': return 'FOOTSTEPS'
    case 'vehicle': return 'VEHICLE'
    case 'bell': return 'BELL/WHISTLE'
    case 'other': return 'SOUND'
  }
}

export function renderState(state: AppState, currentRms: number, baselineRms: number): string {
  if (state.kind === 'IDLE') {
    return (
      `[*] listening\n` +
      `\n` +
      `level:    ${makeBar(currentRms, 6)}\n` +
      `baseline: ${baselineRms.toFixed(4)}\n` +
      `\n` +
      `double-tap to exit`
    )
  }
  // ALERTING
  const intensity = Math.min(1, state.spike.ratio / 8)
  const label = state.classification ? classLabel(state.classification.className) : 'SOUND'
  const confidence = state.classification?.confidence ?? 0
  const confidenceTag = state.classification && confidence < 0.5 ? ' (?)' : ''

  if (state.approaching) {
    return (
      `>>> ${label} APPROACHING${confidenceTag} <<<\n` +
      `\n` +
      `intensity: ${makeBar(intensity)}\n` +
      `peak:      ${state.spike.peakRms.toFixed(3)}\n` +
      `ratio:     ${state.spike.ratio.toFixed(1)}x baseline\n` +
      `\n` +
      `getting louder`
    )
  }
  return (
    `*** ${label} DETECTED${confidenceTag} ***\n` +
    `\n` +
    `intensity: ${makeBar(intensity)}\n` +
    `peak:      ${state.spike.peakRms.toFixed(3)}\n` +
    `ratio:     ${state.spike.ratio.toFixed(1)}x baseline\n`
  )
}

// Coalescing renderer: throttles updates to minIntervalMs and serializes
// bridge calls so we never have two textContainerUpgrade calls in flight at once.
export class Renderer {
  private inFlight = false
  private lastRenderAt = 0
  private pendingContent: string | null = null

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly minIntervalMs = 200,
  ) {}

  render(content: string, force = false): void {
    if (!force) {
      const now = Date.now()
      if (now - this.lastRenderAt < this.minIntervalMs || this.inFlight) {
        this.pendingContent = content
        return
      }
    } else if (this.inFlight) {
      this.pendingContent = content
      return
    }
    void this.dispatch(content)
  }

  private async dispatch(content: string): Promise<void> {
    this.inFlight = true
    this.lastRenderAt = Date.now()
    try {
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: MAIN_CONTAINER_ID,
          containerName: MAIN_CONTAINER_NAME,
          content,
          contentOffset: 0,
          contentLength: 0,
        }),
      )
    } finally {
      this.inFlight = false
      const pending = this.pendingContent
      if (pending !== null && pending !== content) {
        this.pendingContent = null
        void this.dispatch(pending)
      } else {
        this.pendingContent = null
      }
    }
  }
}
