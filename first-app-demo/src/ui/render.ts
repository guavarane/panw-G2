import { TextContainerUpgrade } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { DirectionEstimate } from '../audio/direction'
import type { AppState } from '../state/machine'
import { MAIN_CONTAINER_ID, MAIN_CONTAINER_NAME } from './containers'

const BAR_WIDTH = 24

function makeBar(value: number, scale = 1): string {
  const fill = Math.max(0, Math.min(BAR_WIDTH, Math.round(value * BAR_WIDTH * scale)))
  return '#'.repeat(fill) + '-'.repeat(BAR_WIDTH - fill)
}

function formatDirection(estimate: DirectionEstimate | null): string | null {
  if (!estimate?.available) return null
  if (estimate.label !== 'left' && estimate.label !== 'right') return null
  const angle = estimate.relativeAzimuthDeg?.toFixed(0) ?? '?'
  const confidence = Math.round(estimate.confidence * 100)
  return `${estimate.label} (${angle} deg, ${confidence}%)`
}

export function renderState(
  state: AppState,
  currentRms: number,
  baselineRms: number,
  direction: DirectionEstimate | null = null,
): string {
  if (state.kind === 'IDLE') {
    const location = formatDirection(direction)
    return (
      `[*] listening\n` +
      `\n` +
      `level:    ${makeBar(currentRms, 6)}\n` +
      `baseline: ${baselineRms.toFixed(4)}\n` +
      (location ? `location: ${location}\n` : '') +
      `\n` +
      `double-tap to exit`
    )
  }
  // ALERTING
  const intensity = Math.min(1, state.spike.ratio / 8)
  const location = formatDirection(state.spike.direction)
  return (
    `*** SOUND DETECTED ***\n` +
    `\n` +
    (location ? `location:  ${location}\n` : '') +
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
