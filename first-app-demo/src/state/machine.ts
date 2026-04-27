import type { SpikeEvent } from '../audio/spike-detector'
import type { Classification } from '../audio/classifier'
import type { DirectionEstimate } from '../audio/direction'

// A spike with Henry's direction estimate attached. The spike itself is
// detected by the local pipeline; the direction comes from the multi-mic
// localization layer.
export type LocalizedSpikeEvent = SpikeEvent & {
  direction: DirectionEstimate | null
}

// ALERTING carries everything we know about a sound: where it came from
// (Henry's direction), what it sounds like locally (heuristic classification),
// whether it's approaching (RMS-trend watcher), and what the LLM later
// confirmed it was (LLM classification, which replaces the heuristic when
// it lands).
export type AppState =
  | { kind: 'IDLE' }
  | {
      kind: 'ALERTING'
      spike: LocalizedSpikeEvent
      startedAt: number
      approaching: boolean
      classification?: Classification
    }

export interface StateMachine {
  current(): AppState
  alert(spike: LocalizedSpikeEvent, classification?: Classification): void
  upgradeToApproaching(): void
  attachClassification(classification: Classification): void
  tick(now: number): void
  onChange(handler: (state: AppState) => void): () => void
}

// Bumped from 4 s to 6 s so late-arriving LLM transcripts (we delay the
// LLM call by 1.5 s to let speech complete + ~1.5 s round-trip) still have
// at least 3 s of on-screen time after the upgrade lands.
const ALERT_DURATION_MS = 6000

export function createStateMachine(): StateMachine {
  let state: AppState = { kind: 'IDLE' }
  const handlers = new Set<(state: AppState) => void>()

  function setState(next: AppState) {
    state = next
    for (const handler of handlers) handler(state)
  }

  return {
    current: () => state,
    alert(spike, classification) {
      setState({
        kind: 'ALERTING',
        spike,
        startedAt: Date.now(),
        approaching: false,
        classification,
      })
    },
    upgradeToApproaching() {
      if (state.kind !== 'ALERTING' || state.approaching) return
      setState({ ...state, approaching: true })
    },
    attachClassification(classification) {
      if (state.kind !== 'ALERTING') return
      setState({ ...state, classification })
    },
    tick(now) {
      if (state.kind === 'ALERTING' && now - state.startedAt >= ALERT_DURATION_MS) {
        setState({ kind: 'IDLE' })
      }
    },
    onChange(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
}
