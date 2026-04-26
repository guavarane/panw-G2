import type { SpikeEvent } from '../audio/spike-detector'
import type { Classification } from '../audio/classifier'

export type AppState =
  | { kind: 'IDLE' }
  | {
      kind: 'ALERTING'
      spike: SpikeEvent
      startedAt: number
      approaching: boolean
      classification?: Classification
    }

export interface StateMachine {
  current(): AppState
  alert(spike: SpikeEvent, classification?: Classification): void
  upgradeToApproaching(): void
  attachClassification(classification: Classification): void
  tick(now: number): void
  onChange(handler: (state: AppState) => void): () => void
}

const ALERT_DURATION_MS = 4000

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
