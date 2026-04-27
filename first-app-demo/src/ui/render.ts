import { TextContainerUpgrade } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { AppState } from '../state/machine'
import { MAIN_CONTAINER_ID, MAIN_CONTAINER_NAME } from './containers'

const BAR_WIDTH = 24

function makeBar(value: number, scale = 1): string {
  const fill = Math.max(0, Math.min(BAR_WIDTH, Math.round(value * BAR_WIDTH * scale)))
  return '#'.repeat(fill) + '-'.repeat(BAR_WIDTH - fill)
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
  // ALERTING — only the LLM's verdict shows on screen. Until the LLM
  // responds, we display a generic placeholder so the user never sees a
  // confidently-wrong heuristic label. The heuristic still runs in the
  // background for console diagnostics, but nothing about it surfaces here.
  const intensity = Math.min(1, state.spike.ratio / 8)
  const c = state.classification
  const llmReady = c?.source === 'llm'

  // SPEECH MODE — the most useful output for the deaf/hoh user.
  if (llmReady && c?.transcript) {
    const approachingPrefix = state.approaching ? 'APPROACHING — ' : ''
    return (
      `${approachingPrefix}SOMEONE SAID:\n` +
      `\n` +
      `"${c.transcript}"\n` +
      `\n` +
      `[AI]`
    )
  }

  // NON-SPEECH ALERT MODE — show LLM description if available, else placeholder.
  const headline = llmReady && c?.description ? c.description.toUpperCase() : 'SOUND DETECTED...'
  const sourceTag = llmReady ? '[AI]' : ''
  const urgencyMarker =
    llmReady && c?.urgency === 'high' ? '!!!'
    : llmReady && c?.urgency === 'medium' ? '!!'
    : llmReady && c?.urgency === 'low' ? '!'
    : '***'

  if (state.approaching) {
    return (
      `>>> ${headline} APPROACHING <<< ${sourceTag}\n` +
      `\n` +
      `intensity: ${makeBar(intensity)}\n` +
      `peak:      ${state.spike.peakRms.toFixed(3)}\n` +
      `ratio:     ${state.spike.ratio.toFixed(1)}x baseline\n` +
      `\n` +
      `getting louder`
    )
  }
  return (
    `${urgencyMarker} ${headline} ${urgencyMarker} ${sourceTag}\n` +
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
